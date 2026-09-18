/**
 * BLOQUE 4.3 — recibos y outbox.
 *
 *   npm run test:receipts
 *
 * Comprueba la cadena PAGO -> RECIBO INMUTABLE -> EVENTO DE OUTBOX contra la
 * API y, donde la regla es crítica, también por SQL directo.
 *
 * Está escrita para poder ejecutarse contra una base REAL y ACUMULATIVA: no
 * exige que ninguna tabla esté vacía, se compara siempre contra el estado de
 * partida, y sus datos llevan un identificador único por ejecución.
 */
import { pool, closePool } from '../config/db.js';

const BASE = (process.env.API_URL ?? 'http://localhost:4000').replace(/\/$/, '') + '/api';
const ADMIN_USER = process.env.SEED_ADMIN_USERNAME ?? 'admin';
const ADMIN_PASS = process.env.SEED_ADMIN_PASSWORD ?? 'Admin123!';
const TEST_PASS = 'Prueba123';
const SUITE_IP = '198.18.10.9';

let passed = 0;
let failed = 0;
const c = { ok: '\x1b[32m', bad: '\x1b[31m', dim: '\x1b[2m', off: '\x1b[0m' };
const serverErrors = [];

function check(name, condition, extra = '') {
    if (condition) {
        passed += 1;
        console.log(`  ${c.ok}PASA${c.off}  ${name}`);
    } else {
        failed += 1;
        console.log(`  ${c.bad}FALLA${c.off} ${name} ${c.dim}${extra}${c.off}`);
    }
}

async function api(method, path, { token, body, headers = {} } = {}) {
    const res = await fetch(BASE + path, {
        method,
        headers: {
            'Content-Type': 'application/json',
            'X-Forwarded-For': SUITE_IP,
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
            ...headers,
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const parsed = await res.json().catch(() => null);
    if (res.status >= 500) serverErrors.push(`${method} ${path} -> ${res.status}`);
    return { status: res.status, body: parsed };
}

const show = (r) => `estado ${r.status} ${JSON.stringify(r.body?.error ?? r.body?.data ?? r.body).slice(0, 300)}`;
const q = (n) => Number(n).toFixed(2);

async function login(username, password) {
    const res = await api('POST', '/auth/login', { body: { username, password } });
    return res.body?.data?.token ?? null;
}

const fails = async (sql, params = []) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query(sql, params);
        await client.query('ROLLBACK');
        return null;
    } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        return error;
    } finally {
        client.release();
    }
};

/** Identificador único de esta ejecución, comprobado contra la base. */
let RUN = null;
const codigoSucursal = (run) => `R43-${run}`;
const nombreSucursal = (run) => `SUCURSAL PRUEBA RECIBOS ${run}`;

async function reservarRun() {
    for (let intento = 0; intento < 25; intento += 1) {
        const candidato =
            String(Date.now()).slice(-8) + String(Math.floor(Math.random() * 100)).padStart(2, '0');
        const { rows } = await pool.query(
            `SELECT 1 FROM users     WHERE username LIKE $1
              UNION ALL
             SELECT 1 FROM branches  WHERE code = $2
                                        OR normalize_business_text(name) = normalize_business_text($3)
              UNION ALL
             SELECT 1 FROM customers WHERE dpi LIKE $4
             LIMIT 1`,
            [`%\\_${candidato}`, codigoSucursal(candidato), nombreSucursal(candidato), `4${candidato}%`]
        );
        if (rows.length === 0) return candidato;
    }
    throw new Error('No se encontró un identificador de ejecución libre para la prueba de recibos');
}

async function ventaConCuotas({ customerId, createdBy, branchId, cuotas }) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const total = cuotas.reduce((a, b) => a + b, 0);
        const { rows: [sale] } = await client.query(
            `INSERT INTO sales (customer_id, sale_date, payment_mode, installments_count, subtotal, total, created_by, branch_id, notes)
             VALUES ($1, app_today() - 30, 'credito_4', 4, $2, $2, $3, $4, 'venta de prueba del bloque 4.3')
             RETURNING id`,
            [customerId, q(total), createdBy, branchId]
        );
        for (let i = 0; i < cuotas.length; i += 1) {
            await client.query(
                `INSERT INTO installments (sale_id, number, due_date, amount)
                 VALUES ($1, $2, app_today() + $3::int, $4)`,
                [sale.id, i + 1, (i + 1) * 30 - 30, q(cuotas[i])]
            );
        }
        await client.query('COMMIT');
        return sale;
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}

/** Contadores de la cadena completa, para comparar antes y después. */
async function contadores() {
    const { rows: [n] } = await pool.query(
        `SELECT (SELECT COUNT(*) FROM payments)::int           AS pagos,
                (SELECT COUNT(*) FROM payment_receipts)::int   AS recibos,
                (SELECT COUNT(*) FROM integration_events
                  WHERE event_type = 'payment.created')::int   AS eventos`);
    return n;
}

async function main() {
    console.log(`\n=== Recibos y outbox (bloque 4.3) contra ${BASE} ===\n`);

    console.log('[0] Preparación');
    const admin = await login(ADMIN_USER, ADMIN_PASS);
    if (!admin) throw new Error('Sin sesión de administrador. ¿Ejecutaste `npm run seed`?');
    RUN = await reservarRun();
    console.log(`  ${c.dim}identificador de esta ejecución: ${RUN}${c.off}`);

    const { rows: [adminRow] } = await pool.query(
        'SELECT id FROM users WHERE lower(username) = lower($1)', [ADMIN_USER]);
    const { rows: [bA] } = await pool.query('SELECT id FROM branches WHERE is_default');
    const branchA = Number(bA.id);
    const { rows: yaEstaba } = await pool.query(
        `SELECT id FROM branches
          WHERE code = $1 OR normalize_business_text(name) = normalize_business_text($2)`,
        [codigoSucursal(RUN), nombreSucursal(RUN)]);
    const bB = yaEstaba[0]
        ? yaEstaba[0]
        : (await pool.query('INSERT INTO branches (code, name) VALUES ($1, $2) RETURNING id',
            [codigoSucursal(RUN), nombreSucursal(RUN)])).rows[0];
    const branchB = Number(bB.id);

    const mkUser = async (prefix, role, branchId) => {
        const username = `${prefix}_${RUN}`;
        const res = await api('POST', '/users', {
            token: admin,
            body: {
                username, full_name: `PRUEBA RECIBOS ${prefix}`, password: TEST_PASS, role,
                ...(branchId ? { branch_id: branchId } : {}),
            },
        });
        return { id: res.body?.data?.id, username };
    };
    const uCob = await mkUser('r43_c', 'cobrador', branchA);
    const uGer = await mkUser('r43_g', 'gerencia', branchA);
    const cobrador = await login(uCob.username, TEST_PASS);
    const gerencia = await login(uGer.username, TEST_PASS);
    check('Entran cobrador y gerencia', Boolean(cobrador && gerencia));

    const mkCustomer = async (sufijo, nombre) => {
        const res = await api('POST', '/customers', {
            token: admin,
            body: { dpi: `4${RUN}${sufijo}`.slice(0, 13).padEnd(13, '0'), full_name: nombre,
                    phone: '55553333', address: 'DIRECCION DE PRUEBA 4.3' },
        });
        return Number(res.body?.data?.id);
    };
    const cli = await mkCustomer('01', 'CLIENTE RECIBOS UNO');
    const cliB = await mkCustomer('02', 'CLIENTE RECIBOS DOS');

    const partida = await contadores();

    // ==================================================== 1. PAGO -> RECIBO
    console.log('\n[1] Un pago emite su recibo en la misma transacción');

    const venta = await ventaConCuotas({ customerId: cli, createdBy: uCob.id, branchId: branchA, cuotas: [100, 100, 100, 100] });
    const cobro = await api('POST', '/payments', {
        token: cobrador, body: { sale_id: venta.id, amount: 250, method: 'efectivo' },
    });
    check('El pago se registra (201)', cobro.status === 201, show(cobro));
    const pago = cobro.body?.data?.payment ?? {};
    check('La respuesta del cobro ya trae el número de recibo',
        /^R-\d{8}$/.test(pago.receipt_number ?? ''), String(pago.receipt_number));

    const recibo = (await api('GET', `/payments/${pago.id}/receipt`, { token: cobrador })).body?.data ?? {};
    check('El recibo es consultable desde el pago',
        recibo.receipt_number === pago.receipt_number && Number(recibo.payment_id) === Number(pago.id),
        JSON.stringify({ r: recibo.receipt_number, p: pago.receipt_number }));
    check('El recibo conserva cliente, sucursal, usuario y método',
        Number(recibo.customer_id) === cli && Number(recibo.branch_id) === branchA &&
            recibo.issued_by_username === uCob.username && recibo.method === 'efectivo',
        JSON.stringify({ cli: recibo.customer_id, suc: recibo.branch_id, u: recibo.issued_by_username }));

    // ------ saldos
    check('SALDO ANTERIOR y POSTERIOR correctos: 400 -> 150',
        q(recibo.balance_before) === '400.00' && q(recibo.balance_after) === '150.00',
        JSON.stringify({ antes: recibo.balance_before, despues: recibo.balance_after }));
    check('El recibo cuadra: posterior = anterior - monto',
        Number(recibo.balance_after) === Number(recibo.balance_before) - Number(recibo.amount));

    // ------ FIFO
    const fifo = (recibo.allocations ?? []).map((a) => `${a.installment_number}:${q(a.amount)}`).join(',');
    check('El recibo lleva la asignación FIFO REAL (2 cuotas y media, sin saltar ninguna)',
        fifo === '1:100.00,2:100.00,3:50.00', fifo);
    check('Cada línea del recibo identifica su cuota y su vencimiento',
        (recibo.allocations ?? []).every((a) => a.installment_id && a.due_date));

    const { rows: [coincide] } = await pool.query(
        `SELECT COUNT(*)::int AS n FROM payment_allocations WHERE payment_id = $1`, [pago.id]);
    check('La distribución del recibo coincide con la que quedó en la base',
        coincide.n === (recibo.allocations ?? []).length, `${coincide.n} vs ${recibo.allocations?.length}`);

    // ==================================================== 2. OUTBOX
    console.log('\n[2] El evento de outbox nace en la misma transacción');

    const { rows: eventos } = await pool.query(
        `SELECT id, event_type, aggregate, aggregate_id, status, attempts, payload, created_at
           FROM integration_events
          WHERE event_type = 'payment.created' AND aggregate_id = $1`, [pago.id]);
    check('El pago dejó exactamente UN evento payment.created', eventos.length === 1, String(eventos.length));
    const evento = eventos[0] ?? {};
    check('El evento apunta al agregado correcto y nace pendiente',
        evento.aggregate === 'payment' && Number(evento.aggregate_id) === Number(pago.id) &&
            evento.status === 'pendiente' && evento.attempts === 0,
        JSON.stringify({ a: evento.aggregate, s: evento.status, i: evento.attempts }));
    check('El payload del evento lleva el número de recibo emitido',
        evento.payload?.receipt_number === recibo.receipt_number &&
            Number(evento.payload?.receipt_id) === Number(recibo.id),
        JSON.stringify({ e: evento.payload?.receipt_number, r: recibo.receipt_number }));
    check('El payload lleva saldos y distribución FIFO para que n8n no tenga que calcularlos',
        q(evento.payload?.balance_before) === '400.00' && q(evento.payload?.balance_after) === '150.00' &&
            (evento.payload?.allocations ?? []).length === 3,
        JSON.stringify(evento.payload?.allocations));

    const trio = await contadores();
    check('PAGO + RECIBO + EVENTO avanzan juntos: uno de cada uno',
        trio.pagos === partida.pagos + 1 && trio.recibos === partida.recibos + 1 &&
            trio.eventos === partida.eventos + 1,
        JSON.stringify({ partida, trio }));

    // ==================================================== 3. IDEMPOTENCIA
    console.log('\n[3] Idempotencia: un reenvío no duplica recibo ni evento');

    const clave = `rec-${RUN}-1`;
    const antesIdem = await contadores();
    const primero = await api('POST', '/payments', {
        token: cobrador, body: { sale_id: venta.id, amount: 50, method: 'efectivo' },
        headers: { 'Idempotency-Key': clave },
    });
    const reenvio = await api('POST', '/payments', {
        token: cobrador, body: { sale_id: venta.id, amount: 50, method: 'efectivo' },
        headers: { 'Idempotency-Key': clave },
    });
    check('El reenvío devuelve 200 y marca replayed', reenvio.status === 200 && reenvio.body?.replayed === true,
        show(reenvio));
    const despuesIdem = await contadores();
    check('Solo se registró UN pago, UN recibo y UN evento',
        despuesIdem.pagos === antesIdem.pagos + 1 && despuesIdem.recibos === antesIdem.recibos + 1 &&
            despuesIdem.eventos === antesIdem.eventos + 1,
        JSON.stringify({ antesIdem, despuesIdem }));
    const idPrimero = primero.body?.data?.payment?.id;
    const { rows: [unSoloRecibo] } = await pool.query(
        'SELECT COUNT(*)::int AS n FROM payment_receipts WHERE payment_id = $1', [idPrimero]);
    check('Un pago no puede tener dos recibos', unSoloRecibo.n === 1, String(unSoloRecibo.n));

    const dosRecibos = await fails(
        `INSERT INTO payment_receipts (payment_id, receipt_number, customer_id, sale_id, payment_date,
                                       method, amount, balance_before, balance_after)
         VALUES ($1, next_receipt_number(), $2, $3, app_today(), 'efectivo', 10, 100, 90)`,
        [idPrimero, cli, venta.id]);
    check('Por SQL directo tampoco: el segundo recibo choca con el UNIQUE',
        dosRecibos?.code === '23505', dosRecibos?.message);

    // ==================================================== 4. ATOMICIDAD
    console.log('\n[4] Si la transacción se cae, no queda nada suelto');

    const antesFallo = await contadores();
    const excede = await api('POST', '/payments', {
        token: cobrador, body: { sale_id: venta.id, amount: 999999, method: 'efectivo' },
    });
    check('Un pago que excede el saldo se rechaza', excede.status === 422, show(excede));
    const trasFallo = await contadores();
    check('Un cobro rechazado no deja ni pago, ni recibo, ni evento',
        trasFallo.pagos === antesFallo.pagos && trasFallo.recibos === antesFallo.recibos &&
            trasFallo.eventos === antesFallo.eventos,
        JSON.stringify({ antesFallo, trasFallo }));

    // ---- rollback DESPUÉS de haber escrito los tres, por SQL directo
    const client = await pool.connect();
    let dentro = null;
    try {
        await client.query('BEGIN');
        const { rows: [p] } = await client.query(
            `INSERT INTO payments (sale_id, customer_id, payment_date, amount, method, created_by, voucher_status)
             VALUES ($1, $2, app_today(), 10, 'efectivo', $3, 'PENDIENTE_DE_BOLETA') RETURNING id`,
            [venta.id, cli, adminRow.id]);
        await client.query(
            `INSERT INTO payment_receipts (payment_id, receipt_number, customer_id, sale_id, payment_date,
                                           method, amount, balance_before, balance_after)
             VALUES ($1, next_receipt_number(), $2, $3, app_today(), 'efectivo', 10, 100, 90)`,
            [p.id, cli, venta.id]);
        await client.query(
            `INSERT INTO integration_events (event_type, aggregate, aggregate_id, payload)
             VALUES ('payment.created', 'payment', $1, '{}'::jsonb)`, [p.id]);
        const { rows: [v] } = await client.query(
            `SELECT (SELECT COUNT(*) FROM payment_receipts)::int r,
                    (SELECT COUNT(*) FROM integration_events WHERE event_type='payment.created')::int e`);
        dentro = v;
        await client.query('ROLLBACK');
    } finally {
        client.release();
    }
    const trasRollback = await contadores();
    check('Dentro de la transacción los tres estaban escritos',
        dentro.r === trasFallo.recibos + 1 && dentro.e === trasFallo.eventos + 1, JSON.stringify(dentro));
    check('Tras el ROLLBACK no queda recibo ni evento huérfano',
        trasRollback.pagos === trasFallo.pagos && trasRollback.recibos === trasFallo.recibos &&
            trasRollback.eventos === trasFallo.eventos,
        JSON.stringify({ trasFallo, trasRollback }));

    const { rows: [huerfanos] } = await pool.query(
        `SELECT COUNT(*)::int AS n FROM payment_receipts r
          LEFT JOIN payments p ON p.id = r.payment_id WHERE p.id IS NULL`);
    check('No existe ningún recibo sin su pago', huerfanos.n === 0, String(huerfanos.n));

    // ==================================================== 5. MÉTODOS
    console.log('\n[5] Todos los métodos operativos emiten recibo');

    const metodos = [
        ['efectivo', null], ['remesa', null],
        ['transferencia', `TR-${RUN}`], ['deposito', `DEP-${RUN}`], ['tarjeta', `TJ-${RUN}`],
    ];
    const ventaM = await ventaConCuotas({ customerId: cli, createdBy: uCob.id, branchId: branchA, cuotas: [50, 50, 50, 50] });
    const emitidos = [];
    for (const [metodo, referencia] of metodos) {
        const r = await api('POST', '/payments', {
            token: cobrador,
            body: { sale_id: ventaM.id, amount: 40, method: metodo, ...(referencia ? { reference: referencia } : {}) },
        });
        emitidos.push({ metodo, status: r.status, recibo: r.body?.data?.payment?.receipt_number ?? null,
                        voucher: r.body?.data?.payment?.voucher_status ?? null });
    }
    check('Los cinco métodos operativos registran pago y emiten recibo',
        emitidos.every((e) => e.status === 201 && /^R-\d{8}$/.test(e.recibo ?? '')),
        JSON.stringify(emitidos));
    check('El recibo conserva el estado documental que tenía el pago al emitirse',
        emitidos.find((e) => e.metodo === 'efectivo')?.voucher === 'PENDIENTE_DE_BOLETA' &&
            emitidos.find((e) => e.metodo === 'deposito')?.voucher === 'EN_REVISION',
        JSON.stringify(emitidos.map((e) => `${e.metodo}:${e.voucher}`)));
    const { rows: [reciboRef] } = await pool.query(
        `SELECT r.snapshot->>'reference' AS referencia, r.method FROM payment_receipts r
           JOIN payments p ON p.id = r.payment_id
          WHERE p.sale_id = $1 AND p.method = 'deposito'`, [ventaM.id]);
    check('El correlativo del pago queda congelado en el recibo',
        reciboRef?.referencia === `DEP-${RUN}`, JSON.stringify(reciboRef));

    // ==================================================== 6. INMUTABILIDAD
    console.log('\n[6] El recibo es inmutable');

    const editar = await fails('UPDATE payment_receipts SET amount = 1 WHERE payment_id = $1', [pago.id]);
    check('Un recibo emitido no se puede editar', editar?.code === '23001', editar?.message);
    const borrar = await fails('DELETE FROM payment_receipts WHERE payment_id = $1', [pago.id]);
    check('Un recibo emitido no se puede borrar', borrar?.code === '23001', borrar?.message);
    const descuadrado = await fails(
        `INSERT INTO payment_receipts (payment_id, receipt_number, customer_id, sale_id, payment_date,
                                       method, amount, balance_before, balance_after)
         VALUES ($1, next_receipt_number(), $2, $3, app_today(), 'efectivo', 10, 100, 50)`,
        [idPrimero, cli, venta.id]);
    check('Un recibo que no cuadra (posterior <> anterior - monto) se rechaza',
        descuadrado?.code === '23514', descuadrado?.message);

    // ==================================================== 7. ANULACIÓN
    console.log('\n[7] Anular el pago NO destruye su recibo');

    const ventaA = await ventaConCuotas({ customerId: cli, createdBy: uCob.id, branchId: branchA, cuotas: [100, 100, 100, 100] });
    const pagoAnul = (await api('POST', '/payments', {
        token: cobrador, body: { sale_id: ventaA.id, amount: 120, method: 'efectivo' },
    })).body?.data?.payment ?? {};
    const reciboAntes = (await api('GET', `/payments/${pagoAnul.id}/receipt`, { token: admin })).body?.data ?? {};

    const anulado = await api('PATCH', `/payments/${pagoAnul.id}/void`, {
        token: admin, body: { reason: 'prueba de anulacion del bloque 4.3' },
    });
    check('El pago se anula', anulado.status === 200, show(anulado));

    const reciboDespues = (await api('GET', `/payments/${pagoAnul.id}/receipt`, { token: admin })).body?.data ?? {};
    check('El recibo sigue existiendo y con el MISMO número, monto y saldos',
        reciboDespues.receipt_number === reciboAntes.receipt_number &&
            q(reciboDespues.amount) === q(reciboAntes.amount) &&
            q(reciboDespues.balance_before) === q(reciboAntes.balance_before) &&
            q(reciboDespues.balance_after) === q(reciboAntes.balance_after),
        JSON.stringify({ antes: reciboAntes.receipt_number, despues: reciboDespues.receipt_number }));
    check('El recibo muestra al lado que su pago quedó anulado, con motivo y responsable',
        reciboDespues.payment_status === 'anulado' && Boolean(reciboDespues.voided_at) &&
            /prueba de anulacion/.test(reciboDespues.void_reason ?? '') &&
            reciboDespues.voided_by_username === ADMIN_USER,
        JSON.stringify({ e: reciboDespues.payment_status, m: reciboDespues.void_reason }));

    // ==================================================== 8. DEPÓSITO
    console.log('\n[8] Relación con el depósito, sin congelar lo que todavía no existe');

    const ventaD = await ventaConCuotas({ customerId: cli, createdBy: uCob.id, branchId: branchA, cuotas: [100, 100, 100, 100] });
    const pagoDep = (await api('POST', '/payments', {
        token: cobrador, body: { sale_id: ventaD.id, amount: 100, method: 'deposito', reference: `BOL-${RUN}` },
    })).body?.data?.payment ?? {};
    const reciboSinDep = (await api('GET', `/payments/${pagoDep.id}/receipt`, { token: admin })).body?.data ?? {};
    check('Al emitirse, el recibo no inventa un depósito que aún no existe',
        reciboSinDep.deposit_id === null && reciboSinDep.current_deposit_number === null,
        JSON.stringify({ d: reciboSinDep.deposit_id, c: reciboSinDep.current_deposit_number }));

    const deposito = (await api('POST', '/deposits', {
        token: cobrador, body: { declared_amount: 100, reference: `DEP43-${RUN}`, payment_ids: [pagoDep.id] },
    })).body?.data ?? {};
    const reciboConDep = (await api('GET', `/payments/${pagoDep.id}/receipt`, { token: admin })).body?.data ?? {};
    check('Después, el recibo muestra el depósito en el que acabó el pago',
        reciboConDep.current_deposit_number === deposito.deposit_number,
        JSON.stringify({ r: reciboConDep.current_deposit_number, d: deposito.deposit_number }));

    // ==================================================== 9. CONSULTA Y PERMISOS
    console.log('\n[9] Consulta, permisos y sucursal');

    const listado = await api('GET', `/receipts?saleId=${venta.id}&pageSize=100`, { token: cobrador });
    check('El listado de recibos filtra por venta',
        listado.status === 200 && (listado.body?.data ?? []).length > 0 &&
            (listado.body?.data ?? []).every((r) => Number(r.sale_id) === Number(venta.id)),
        show(listado));

    const porId = await api('GET', `/receipts/${recibo.id}`, { token: cobrador });
    check('Un recibo se consulta por su identificador',
        porId.status === 200 && porId.body?.data?.receipt_number === recibo.receipt_number, show(porId));

    const anulados = await api('GET', '/receipts?paymentStatus=anulado&pageSize=100', { token: admin });
    check('Se pueden listar los recibos cuyo pago fue anulado',
        anulados.status === 200 && (anulados.body?.data ?? []).every((r) => r.payment_status === 'anulado') &&
            (anulados.body?.data ?? []).some((r) => r.receipt_number === reciboAntes.receipt_number),
        show(anulados));

    const sinPermiso = await api('GET', '/receipts', { token: gerencia });
    check('Sin el permiso de consultar pagos no se ven los recibos (gerencia no lo tiene)',
        sinPermiso.status === 403, show(sinPermiso));
    const reciboSinPermiso = await api('GET', `/payments/${pago.id}/receipt`, { token: gerencia });
    check('Tampoco el recibo de un pago concreto', reciboSinPermiso.status === 403, show(reciboSinPermiso));
    const sinSesion = await api('GET', '/receipts');
    check('Sin sesión, tampoco', sinSesion.status === 401, show(sinSesion));

    // ---- sucursal
    const ventaB = await ventaConCuotas({ customerId: cliB, createdBy: adminRow.id, branchId: branchB, cuotas: [100, 100, 100, 100] });
    const pagoB = (await api('POST', '/payments', {
        token: admin, body: { sale_id: ventaB.id, amount: 60, method: 'efectivo' },
    })).body?.data?.payment ?? {};
    const reciboB = (await api('GET', `/payments/${pagoB.id}/receipt`, { token: admin })).body?.data ?? {};
    check('El recibo hereda la sucursal de SU venta, no la de quien cobra',
        Number(reciboB.branch_id) === branchB && reciboB.branch_code === codigoSucursal(RUN),
        JSON.stringify({ suc: reciboB.branch_id, esperado: branchB }));
    const porSucursal = await api('GET', `/receipts?branchId=${branchB}&pageSize=100`, { token: admin });
    check('El listado se puede aislar por sucursal',
        porSucursal.status === 200 && (porSucursal.body?.data ?? []).length > 0 &&
            (porSucursal.body?.data ?? []).every((r) => Number(r.branch_id) === branchB),
        show(porSucursal));

    const inexistente = await api('GET', '/payments/99999999/receipt', { token: admin });
    check('Un pago sin recibo responde 404 y no inventa uno', inexistente.status === 404, show(inexistente));

    // ==================================================== 10. NUMERACIÓN
    console.log('\n[10] Numeración');

    const { rows: [numeracion] } = await pool.query(
        `SELECT COUNT(*)::int AS total, COUNT(DISTINCT receipt_number)::int AS distintos
           FROM payment_receipts`);
    check('Ningún número de recibo se repite en toda la base',
        numeracion.total === numeracion.distintos, JSON.stringify(numeracion));

    // Se acota a los clientes de ESTA ejecución a propósito. Mirar todos los
    // pagos de la base mezclaría los que otras suites insertan por SQL directo
    // —que no pasan por la aplicación y por tanto no emiten recibo— con los
    // que sí registró la API, que son los que aquí se comprueban.
    const { rows: [sinRecibo] } = await pool.query(
        `SELECT COUNT(*)::int AS n
           FROM payments p
           LEFT JOIN payment_receipts r ON r.payment_id = p.id
          WHERE r.id IS NULL AND p.customer_id = ANY($1::bigint[])`,
        [[cli, cliB]]);
    check('Todo pago que registró la API en esta prueba tiene su recibo',
        sinRecibo.n === 0, `${sinRecibo.n} pagos sin recibo`);

    check('Ninguna petición terminó en error 500', serverErrors.length === 0, serverErrors.join(' | '));
}

main()
    .catch((error) => {
        failed += 1;
        console.error(`\n${c.bad}Error ejecutando la prueba:${c.off}`, error.stack);
    })
    .finally(async () => {
        await closePool();
        console.log(`\n=== Resultado: ${c.ok}${passed} correctas${c.off}, ${failed ? c.bad : ''}${failed} fallidas${c.off} ===\n`);
        process.exit(failed === 0 ? 0 : 1);
    });
