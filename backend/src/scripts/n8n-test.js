/**
 * Prueba de integración del puente hacia n8n.
 *
 * Levanta por su cuenta un receptor que verifica la firma igual que lo haría
 * n8n, arranca una instancia de la API con el despacho activado, y comprueba
 * el camino completo:
 *
 *   operación comercial → outbox → despacho firmado → receptor
 *
 * Cubre también lo que suele fallar en producción: firma inválida, receptor
 * caído, reintento posterior, duplicados e idempotencia del barrido.
 *
 *   npm run test:n8n
 *
 * No necesita que la API esté levantada: la levanta y la apaga sola.
 * Sí necesita la base de datos migrada y con el seed aplicado.
 */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { signBody } from '../utils/signature.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const API_PORT = Number(process.env.TEST_API_PORT ?? 4600);
const RECEIVER_PORT = Number(process.env.TEST_RECEIVER_PORT ?? 4500);
const SECRET = crypto.randomBytes(32).toString('hex');
const API = `http://127.0.0.1:${API_PORT}/api`;
const RECEIVER = `http://127.0.0.1:${RECEIVER_PORT}`;
const USER = process.env.SEED_ADMIN_USERNAME ?? 'admin';
const PASS = process.env.SEED_ADMIN_PASSWORD ?? 'Admin123!';

const c = { ok: '\x1b[32m', bad: '\x1b[31m', dim: '\x1b[2m', off: '\x1b[0m' };
let passed = 0;
let failed = 0;
let token = '';

function check(name, condition, extra = '') {
    if (condition) {
        passed += 1;
        console.log(`  ${c.ok}PASA${c.off}  ${name}`);
    } else {
        failed += 1;
        console.log(`  ${c.bad}FALLA${c.off} ${name} ${c.dim}${extra}${c.off}`);
    }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, p, body) {
    const res = await fetch(API + p, {
        method,
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
}

async function waitFor(url, label, timeoutMs = 20000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try {
            const res = await fetch(url, { signal: AbortSignal.timeout(1500) });
            if (res.ok) return true;
        } catch {
            /* todavía no responde */
        }
        await sleep(300);
    }
    throw new Error(`${label} no respondió en ${timeoutMs} ms`);
}

const children = [];
function spawnChild(name, file, env) {
    // `file` se resuelve desde src/, no desde src/scripts/: server.js vive un
    // nivel arriba.
    const child = spawn(process.execPath, [path.resolve(HERE, '..', file)], {
        env: { ...process.env, ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (d) => process.env.TEST_VERBOSE && process.stdout.write(`  ${c.dim}[${name}] ${d}${c.off}`));
    child.stderr.on('data', (d) => process.stderr.write(`  ${c.dim}[${name}] ${d}${c.off}`));
    children.push(child);
    return child;
}

function stopAll() {
    for (const child of children) {
        if (!child.killed) child.kill('SIGKILL');
    }
}

/**
 * Fecha desplazada respecto a HOY según el negocio.
 *
 * Se toma el "hoy" de la propia API (zona America/Guatemala), no el del
 * proceso que corre la prueba: entre las 18:00 y la medianoche de Guatemala
 * el servidor de pruebas ya está en el día siguiente en UTC, y la ventana de
 * aviso de cuotas se calcularía con un día de diferencia.
 */
let apiToday = null;
function isoDaysFromToday(days) {
    const [y, m, d] = apiToday.split('-').map(Number);
    const base = new Date(Date.UTC(y, m - 1, d));
    base.setUTCDate(base.getUTCDate() + days);
    return base.toISOString().slice(0, 10);
}

const stamp = Date.now().toString().slice(-7);

async function main() {
    console.log(`\n=== Integración con n8n: API :${API_PORT}  receptor :${RECEIVER_PORT} ===\n`);

    // ------------------------------------------------------ PREPARACIÓN
    let receiver = spawnChild('receptor', 'scripts/n8n-receiver.js', {
        RECEIVER_PORT: String(RECEIVER_PORT),
        RECEIVER_SECRET: SECRET,
        RECEIVER_MODE: 'ok',
    });
    await waitFor(`${RECEIVER}/stats`, 'El receptor');

    spawnChild('api', 'server.js', {
        PORT: String(API_PORT),
        N8N_WEBHOOK_URL: `${RECEIVER}/webhook`,
        N8N_WEBHOOK_SECRET: SECRET,
        N8N_DISPATCH_ENABLED: 'true',
        N8N_DISPATCH_INTERVAL_MS: '3000',
        N8N_TIMEOUT_MS: '4000',
        // El barrido se dispara a mano en la prueba, no por temporizador.
        COLLECTIONS_SCAN_ENABLED: 'false',
    });
    await waitFor(`${API}/health`, 'La API');

    apiToday = (await api('GET', '/health')).body?.data?.today;
    if (!apiToday) throw new Error('la API no reportó su fecha de hoy');

    const login = await api('POST', '/auth/login', { username: USER, password: PASS });
    token = login.body?.data?.token ?? '';
    if (!token) {
        console.error('\nNo se pudo iniciar sesión. ¿Ejecutaste `npm run seed`?\n');
        throw new Error('login fallido');
    }

    // ------------------------------------------ 1. CONFIGURACIÓN VISIBLE
    console.log('[1] Estado del puente');
    const status = await api('GET', '/integrations/status');
    check('El estado reporta el despacho activo', status.body?.data?.enabled === true);
    check('El estado reporta el webhook configurado', status.body?.data?.webhook_configured === true);
    check('El estado reporta la firma configurada', status.body?.data?.signature_configured === true);
    check('El estado expone la política de reintentos',
        Array.isArray(status.body?.data?.backoff_seconds) && status.body.data.backoff_seconds.length > 0);

    const noAuth = await fetch(`${API}/integrations/status`);
    check('La bandeja de salida exige autenticación (401)', noAuth.status === 401, `recibido ${noAuth.status}`);

    // ------------------------------------- 2. ENTREGA DE UNA OPERACIÓN REAL
    console.log('\n[2] Entrega de eventos de una operación real');
    const before = await (await fetch(`${RECEIVER}/stats`)).json();

    const customer = await api('POST', '/customers', {
        dpi: `41${stamp}01`.slice(0, 13).padEnd(13, '0'),
        full_name: 'Cliente Integración n8n',
        phone: '55550000',
        address: 'Zona 1, Ciudad de Guatemala',
    });
    check('Cliente creado', customer.status === 201, JSON.stringify(customer.body?.error ?? ''));
    const customerId = customer.body?.data?.id;

    const product = await api('POST', '/products', {
        code: `N8N-${stamp}`, name: 'Producto Integración n8n', cost: 1000, stock: 20,
    });
    const productId = product.body?.data?.id;

    const sale = await api('POST', '/sales', {
        customer_id: customerId, payment_mode: 'credito_4',
        items: [{ product_id: productId, quantity: 1 }],
    });
    check('Venta creada', sale.status === 201, JSON.stringify(sale.body?.error ?? ''));
    const saleId = sale.body?.data?.id;

    const cuota = sale.body?.data?.installments?.[0]?.amount;
    const payment = await api('POST', '/payments', { sale_id: saleId, amount: cuota });
    check('Pago registrado', payment.status === 201, JSON.stringify(payment.body?.error ?? ''));

    const dispatch = await api('POST', '/integrations/dispatch');
    check('El despacho manual se ejecuta', dispatch.status === 200, JSON.stringify(dispatch.body?.error ?? ''));

    await sleep(500);
    const after = await (await fetch(`${RECEIVER}/stats`)).json();
    const delivered = after.received - before.received;
    check('n8n recibió los eventos de la operación', delivered >= 3, `recibidos ${delivered}`);
    check('El receptor no rechazó ninguna firma', after.rejected === before.rejected,
        `rechazados ${after.rejected - before.rejected}`);

    const events = await api('GET', '/integrations/events?status=enviado&pageSize=50');
    const sentTypes = new Set((events.body?.data ?? []).map((e) => e.event_type));
    check('Se entregó customer.created', sentTypes.has('customer.created'), [...sentTypes].join(', '));
    check('Se entregó sale.created', sentTypes.has('sale.created'));
    check('Se entregó payment.created', sentTypes.has('payment.created'));

    const sentEvent = (events.body?.data ?? [])[0];
    const detail = await api('GET', `/integrations/events/${sentEvent.id}`);
    check('El evento guarda el historial de intentos',
        Array.isArray(detail.body?.data?.attempts) && detail.body.data.attempts.length >= 1);
    check('El intento registra el código HTTP 200', detail.body?.data?.attempts?.[0]?.http_status === 200,
        `= ${detail.body?.data?.attempts?.[0]?.http_status}`);
    check('El intento registra la duración', Number(detail.body?.data?.attempts?.[0]?.duration_ms) >= 0);

    // ---------------------------------------------- 3. SEGURIDAD DE LA FIRMA
    console.log('\n[3] Seguridad de la firma');
    const body = JSON.stringify({ id: 999999, event: 'sale.created', data: { falsificado: true } });
    const ts = Math.floor(Date.now() / 1000).toString();

    const noSig = await fetch(`${RECEIVER}/webhook`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
    });
    check('Sin firma, el receptor rechaza (401)', noSig.status === 401, `recibido ${noSig.status}`);

    const badSig = await fetch(`${RECEIVER}/webhook`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-Webhook-Timestamp': ts,
            'X-Signature-256': signBody('secreto-equivocado', ts, body),
        },
        body,
    });
    check('Con firma de otro secreto, rechaza (401)', badSig.status === 401, `recibido ${badSig.status}`);

    const tamperedSig = signBody(SECRET, ts, body);
    const tampered = await fetch(`${RECEIVER}/webhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Webhook-Timestamp': ts, 'X-Signature-256': tamperedSig },
        body: body.replace('999999', '111111'),
    });
    check('Si el cuerpo se altera en tránsito, rechaza (401)', tampered.status === 401, `recibido ${tampered.status}`);

    const oldTs = (Math.floor(Date.now() / 1000) - 3600).toString();
    const replay = await fetch(`${RECEIVER}/webhook`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-Webhook-Timestamp': oldTs,
            'X-Signature-256': signBody(SECRET, oldTs, body),
        },
        body,
    });
    check('Una petición vieja reenviada se rechaza (401)', replay.status === 401, `recibido ${replay.status}`);

    const validHeaders = {
        'Content-Type': 'application/json',
        'X-Webhook-Timestamp': ts,
        'X-Signature-256': tamperedSig,
        'X-Event-Id': '999999',
    };
    const valid = await fetch(`${RECEIVER}/webhook`, { method: 'POST', headers: validHeaders, body });
    check('Con firma correcta, acepta (200)', valid.status === 200, `recibido ${valid.status}`);

    const dup = await fetch(`${RECEIVER}/webhook`, { method: 'POST', headers: validHeaders, body });
    const dupBody = await dup.json();
    check('Un reenvío del mismo X-Event-Id se detecta como duplicado', dupBody.duplicate === true,
        JSON.stringify(dupBody));

    // ------------------------------------ 4. RESISTENCIA: n8n fuera de servicio
    console.log('\n[4] Resistencia cuando n8n está caído');
    receiver.kill('SIGKILL');
    await sleep(700);

    const saleWhileDown = await api('POST', '/sales', {
        customer_id: customerId, payment_mode: 'contado',
        items: [{ product_id: productId, quantity: 1 }],
    });
    check('Con n8n caído, la venta se registra igual (201)', saleWhileDown.status === 201,
        JSON.stringify(saleWhileDown.body?.error ?? ''));

    await api('POST', '/integrations/dispatch');
    await sleep(300);

    const pendings = await api('GET', '/integrations/events?status=fallido&pageSize=20');
    const failedEvent = (pendings.body?.data ?? []).find((e) => e.aggregate_id === saleWhileDown.body?.data?.id);
    check('El evento queda marcado como fallido, no perdido', Boolean(failedEvent),
        JSON.stringify((pendings.body?.data ?? []).map((e) => e.event_type)));
    check('El fallo queda registrado con su causa', Boolean(failedEvent?.last_error), failedEvent?.last_error);
    check('El reintento se programa para más tarde, no de inmediato',
        failedEvent && new Date(failedEvent.next_attempt_at).getTime() > Date.now() + 30_000,
        `próximo intento: ${failedEvent?.next_attempt_at}`);

    const failedDetail = await api('GET', `/integrations/events/${failedEvent.id}`);
    check('El intento fallido queda en el historial',
        failedDetail.body?.data?.attempts?.some((a) => a.ok === false));

    // n8n vuelve
    receiver = spawnChild('receptor', 'scripts/n8n-receiver.js', {
        RECEIVER_PORT: String(RECEIVER_PORT),
        RECEIVER_SECRET: SECRET,
        RECEIVER_MODE: 'ok',
    });
    await waitFor(`${RECEIVER}/stats`, 'El receptor (reinicio)');

    const retry = await api('POST', `/integrations/events/${failedEvent.id}/retry`);
    check('Se puede reintentar el evento a mano', retry.status === 200, JSON.stringify(retry.body?.error ?? ''));
    await api('POST', '/integrations/dispatch');
    await sleep(500);

    const recovered = await api('GET', `/integrations/events/${failedEvent.id}`);
    check('Tras volver n8n, el evento se entrega', recovered.body?.data?.status === 'enviado',
        `= ${recovered.body?.data?.status}`);
    check('El historial conserva el intento fallido y el exitoso',
        recovered.body?.data?.attempts?.length >= 2 &&
            recovered.body?.data?.attempts?.some((a) => a.ok === false) &&
            recovered.body?.data?.attempts?.some((a) => a.ok === true),
        `${recovered.body?.data?.attempts?.length} intento(s)`);

    // ------------------------------------------- 5. EVENTOS DE COBRANZA
    console.log('\n[5] Eventos de cobranza (installment.upcoming / overdue)');

    // Venta de contado fechada 30 días atrás: su única cuota está vencida.
    const overdueSale = await api('POST', '/sales', {
        customer_id: customerId, payment_mode: 'contado', sale_date: isoDaysFromToday(-30),
        items: [{ product_id: productId, quantity: 1 }],
    });
    check('Venta con cuota ya vencida creada', overdueSale.status === 201);

    // Venta de contado fechada dentro de 3 días: su cuota vence justo en la
    // ventana de aviso por defecto.
    const upcomingSale = await api('POST', '/sales', {
        customer_id: customerId, payment_mode: 'contado', sale_date: isoDaysFromToday(3),
        items: [{ product_id: productId, quantity: 1 }],
    });
    check('Venta con cuota por vencer creada', upcomingSale.status === 201);

    const scan1 = await api('POST', '/integrations/collections/scan');
    check('El barrido se ejecuta', scan1.status === 200, JSON.stringify(scan1.body?.error ?? ''));
    check('El barrido genera al menos un installment.overdue',
        scan1.body?.data?.created?.overdue >= 1, JSON.stringify(scan1.body?.data?.created));
    check('El barrido genera al menos un installment.upcoming',
        scan1.body?.data?.created?.upcoming >= 1, JSON.stringify(scan1.body?.data?.created));

    // Idempotencia: correrlo otra vez no debe volver a avisar
    const scan2 = await api('POST', '/integrations/collections/scan');
    check('Un segundo barrido no genera avisos repetidos',
        scan2.body?.data?.created?.upcoming === 0 && scan2.body?.data?.created?.overdue === 0,
        JSON.stringify(scan2.body?.data?.created));
    check('El segundo barrido reporta los avisos ya emitidos', scan2.body?.data?.skipped >= 2,
        `omitidos ${scan2.body?.data?.skipped}`);

    await api('POST', '/integrations/dispatch');
    await sleep(500);

    const collectionEvents = await api('GET', '/integrations/events?type=installment.overdue&pageSize=10');
    check('installment.overdue se entregó a n8n',
        collectionEvents.body?.data?.some((e) => e.status === 'enviado'),
        JSON.stringify((collectionEvents.body?.data ?? []).map((e) => e.status)));

    const upcomingEvents = await api('GET', '/integrations/events?type=installment.upcoming&pageSize=10');
    const upcomingOne = upcomingEvents.body?.data?.[0];
    check('installment.upcoming se entregó a n8n', upcomingOne?.status === 'enviado', `= ${upcomingOne?.status}`);
    check('El evento de cobranza lleva clave de idempotencia', Boolean(upcomingOne?.unique_key),
        `= ${upcomingOne?.unique_key}`);

    const upcomingDetail = await api('GET', `/integrations/events/${upcomingOne.id}`);
    const p = upcomingDetail.body?.data?.payload ?? {};
    check('El payload trae el teléfono del cliente para notificar', Boolean(p.customer?.phone), JSON.stringify(p.customer));
    check('El payload trae la fecha de vencimiento y el saldo',
        Boolean(p.due_date) && Boolean(p.balance), `${p.due_date} / ${p.balance}`);

    // ------------------------------------------------ 6. RESUMEN DEL OUTBOX
    console.log('\n[6] Resumen y trazabilidad');
    const finalStatus = await api('GET', '/integrations/status');
    const counts = finalStatus.body?.data?.counts ?? {};
    check('El resumen contabiliza los eventos enviados', counts.enviado >= 5, JSON.stringify(counts));
    check('No quedan eventos descartados', counts.descartado === 0, `descartados ${counts.descartado}`);
    check('El resumen desglosa por tipo de evento',
        Array.isArray(finalStatus.body?.data?.by_type) && finalStatus.body.data.by_type.length >= 4);

    const stats = await (await fetch(`${RECEIVER}/stats`)).json();
    check('El receptor no acumuló rechazos de firma en el tráfico real', stats.rejected === 0,
        `rechazados ${stats.rejected}`);

    console.log(`\n=== Resultado: ${c.ok}${passed} correctas${c.off}, ${failed ? c.bad : ''}${failed} fallidas${c.off} ===\n`);
}

main()
    .then(() => {
        stopAll();
        process.exit(failed === 0 ? 0 : 1);
    })
    .catch((error) => {
        console.error('\nError inesperado:', error.message);
        stopAll();
        process.exit(1);
    });
