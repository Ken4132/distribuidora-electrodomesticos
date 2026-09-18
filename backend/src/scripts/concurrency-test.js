/**
 * QA DE CONCURRENCIA Y CARGA — contra el backend REAL.
 *
 *   npm run test:concurrency
 *
 * No prueba funcionalidades: prueba que el sistema se comporte bien cuando
 * varias personas hacen lo mismo AL MISMO TIEMPO. Todo lo que se lanza aquí
 * sale de verdad por HTTP y llega a PostgreSQL.
 *
 * SEGURIDAD DE DATOS
 * ------------------
 * Solo AÑADE datos, y todos llevan el identificador de la ejecución, así que
 * se distinguen de la operación real (`QA CONCURRENCIA <run>`). No borra,
 * no actualiza y no toca nada existente. Puede ejecutarse varias veces
 * seguidas sobre una base acumulativa.
 *
 * REGLAS VIGENTES QUE SE COMPRUEBAN (no se modifican)
 * ---------------------------------------------------
 *   * login: ventana de 10 min, 10 fallos por IP+usuario, 50 por IP, y los
 *     ACIERTOS no consumen presupuesto (`skipSuccessfulRequests`);
 *   * API: 300 peticiones por minuto y por IP;
 *   * pagos: FIFO estricto, saldo bloqueado en la transacción, idempotencia
 *     por `Idempotency-Key`.
 */
import { pool, closePool } from '../config/db.js';
import { config } from '../config/env.js';

const BASE = (process.env.API_URL ?? 'http://localhost:4000').replace(/\/$/, '') + '/api';
const ADMIN_USER = process.env.SEED_ADMIN_USERNAME ?? 'admin';
const ADMIN_PASS = process.env.SEED_ADMIN_PASSWORD ?? 'Admin123!';
const TEST_PASS = 'Prueba123';

/** Nivel de concurrencia de cada escenario (ajustable sin tocar el código). */
const USERS = Number(process.env.QA_USERS ?? 8);
const READERS = Number(process.env.QA_READERS ?? 5);
const PAYERS = Number(process.env.QA_PAYERS ?? 5);
const IDEMPOTENT_SHOTS = Number(process.env.QA_IDEMPOTENT ?? 6);

/**
 * Cada escenario usa su propio bloque de IPs simuladas. El limitador de la
 * API cuenta 300 peticiones por minuto y por IP: repartir evita que un
 * escenario estrangule al siguiente y que un 429 se confunda con un fallo.
 */
const IP = {
    nat: '198.18.20.1', // 8 usuarios detrás del mismo router (NAT)
    distinct: (i) => `198.18.21.${i + 1}`, // 8 usuarios, 8 IPs
    // El escenario de fuerza bruta gasta presupuesto de IP a propósito (50
    // fallos por IP y ventana de 10 min), así que cada ejecución usa su
    // propia IP: la suite se puede repetir seguida sin envenenarse.
    brute: null,
    brute2: null,
    customers: '198.18.23.1',
    reads: (i) => `198.18.24.${i + 1}`,
    pays: (i) => `198.18.25.${i + 1}`,
    idem: '198.18.26.1',
    admin: '198.18.27.1',
};

let passed = 0;
let failed = 0;
const c = { ok: '\x1b[32m', bad: '\x1b[31m', dim: '\x1b[2m', off: '\x1b[0m' };
const serverErrors = [];
const timings = [];

function check(name, condition, extra = '') {
    if (condition) {
        passed += 1;
        console.log(`  ${c.ok}PASA${c.off}  ${name}`);
    } else {
        failed += 1;
        console.log(`  ${c.bad}FALLA${c.off} ${name} ${c.dim}${extra}${c.off}`);
    }
}

/** Petición cronometrada. `ip` simula el cliente real detrás del proxy. */
async function api(method, path, { token, body, ip, key, tag } = {}) {
    const started = Date.now();
    let status = 0;
    let parsed = null;
    try {
        const res = await fetch(BASE + path, {
            method,
            headers: {
                'Content-Type': 'application/json',
                'X-Forwarded-For': ip ?? IP.admin,
                ...(token ? { Authorization: `Bearer ${token}` } : {}),
                ...(key ? { 'Idempotency-Key': key } : {}),
            },
            ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        });
        status = res.status;
        parsed = await res.json().catch(() => null);
    } catch (error) {
        parsed = { error: { message: error.message } };
    }
    const ms = Date.now() - started;
    timings.push({ tag: tag ?? `${method} ${path.split('?')[0]}`, ms, status });
    if (status >= 500) serverErrors.push(`${method} ${path} -> ${status}`);
    return { status, body: parsed, ms };
}

const login = (username, password, ip) =>
    api('POST', '/auth/login', { body: { username, password }, ip, tag: 'POST /auth/login' });

const q = (n) => Number(n).toFixed(2);
const codes = (rs) => rs.map((r) => r.status).sort().join(',');
const count = (rs, pred) => rs.filter(pred).length;

/** Estadística de tiempos de un conjunto de respuestas. */
function stats(list) {
    if (!list.length) return { n: 0 };
    const xs = list.map((r) => (typeof r === 'number' ? r : r.ms)).sort((a, b) => a - b);
    const pick = (p) => xs[Math.min(xs.length - 1, Math.floor((xs.length * p) / 100))];
    return {
        n: xs.length,
        min: xs[0],
        p50: pick(50),
        p95: pick(95),
        max: xs[xs.length - 1],
        avg: Math.round(xs.reduce((a, b) => a + b, 0) / xs.length),
    };
}
const fmt = (s) => (s.n ? `n=${s.n} min=${s.min}ms p50=${s.p50}ms p95=${s.p95}ms max=${s.max}ms` : 'sin datos');

let RUN = null;
async function reservarRun() {
    for (let i = 0; i < 25; i += 1) {
        const cand = String(Date.now()).slice(-8) + String(Math.floor(Math.random() * 100)).padStart(2, '0');
        const { rows } = await pool.query(
            `SELECT 1 FROM users WHERE username LIKE $1
              UNION ALL SELECT 1 FROM customers WHERE dpi LIKE $2 LIMIT 1`,
            [`%\\_${cand}`, `4${cand}%`]
        );
        if (rows.length === 0) return cand;
    }
    throw new Error('Sin identificador de ejecución libre');
}

/** Venta a crédito controlada, por SQL (el flujo de crédito tiene su suite). */
let seqSolicitud = 0;
async function ventaControlada({ customerId, createdBy, branchId, cuotas }) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        seqSolicitud += 1;
        const { rows: [ca] } = await client.query(
            `INSERT INTO credit_applications
                 (application_number, customer_id, branch_id, created_by, customer_dpi_snapshot,
                  customer_full_name_snapshot, customer_phone_snapshot, customer_address_snapshot, status)
             VALUES ($1,$2,$3,$4,'0000000000000','QA CONCURRENCIA','55550000','DIRECCION QA','APROBADO')
             RETURNING id`,
            [Number(RUN) * 100 + seqSolicitud, customerId, branchId, createdBy]
        );
        const total = cuotas.reduce((a, b) => a + b, 0);
        const { rows: [s] } = await client.query(
            `INSERT INTO sales (customer_id, sale_date, payment_mode, installments_count, subtotal, total,
                                created_by, branch_id, credit_application_id, notes)
             VALUES ($1, app_today() - 30, 'credito', $2, $3, $3, $4, $5, $6, 'venta QA de concurrencia')
             RETURNING id, total`,
            [customerId, cuotas.length, q(total), createdBy, branchId, ca.id]
        );
        await client.query(`UPDATE credit_applications SET status='VENTA_CONCRETADA', sale_id=$2 WHERE id=$1`, [ca.id, s.id]);
        await client.query(`UPDATE credit_applications SET status='ACTIVO' WHERE id=$1`, [ca.id]);
        for (let i = 0; i < cuotas.length; i += 1) {
            await client.query(
                `INSERT INTO installments (sale_id, number, due_date, amount)
                 VALUES ($1, $2, app_today() + $3::int, $4)`,
                [s.id, i + 1, (i + 1) * 30 - 30, q(cuotas[i])]
            );
        }
        await client.query('COMMIT');
        return s;
    } catch (e) {
        await client.query('ROLLBACK');
        throw e;
    } finally {
        client.release();
    }
}

/** Estado económico de una venta leído directamente de la base. */
async function estado(saleId) {
    const { rows: [r] } = await pool.query(
        `SELECT vs.total, vs.paid_amount, vs.balance,
                (SELECT COALESCE(SUM(p.amount),0) FROM payments p
                  WHERE p.sale_id = $1 AND p.status='aplicado')::numeric(12,2)   AS pagos,
                (SELECT COALESCE(SUM(pa.amount),0) FROM payment_allocations pa
                  JOIN payments p2 ON p2.id = pa.payment_id AND p2.status='aplicado'
                 WHERE p2.sale_id = $1)::numeric(12,2)                           AS asignado,
                (SELECT COUNT(*) FROM payments WHERE sale_id=$1 AND status='aplicado')::int AS n_pagos,
                (SELECT COUNT(*) FROM v_installments
                  WHERE sale_id=$1 AND NOT is_superseded AND paid_amount > amount)::int     AS sobrepagadas,
                (SELECT COUNT(*) FROM v_installments
                  WHERE sale_id=$1 AND NOT is_superseded AND balance < 0)::int              AS negativas
           FROM v_sales vs WHERE vs.id = $1`,
        [saleId]
    );
    return r;
}

async function main() {
    console.log(`\n=== QA de concurrencia contra ${BASE} ===\n`);
    const t0 = Date.now();

    // ============================================================ PREPARACIÓN
    console.log('[0] Preparación');
    const admin = (await login(ADMIN_USER, ADMIN_PASS, IP.admin)).body?.data?.token;
    if (!admin) throw new Error('Sin sesión de administrador. ¿Ejecutaste `npm run seed`?');
    RUN = await reservarRun();
    const octeto = (Number(RUN) % 200) + 20;
    IP.brute = `198.18.22.${octeto}`;
    IP.brute2 = `198.18.32.${octeto}`;
    console.log(`  ${c.dim}ejecución ${RUN} · ${USERS} usuarios · zona ${config.timezone}${c.off}`);

    const { rows: [adminRow] } = await pool.query(
        'SELECT id FROM users WHERE lower(username)=lower($1)', [ADMIN_USER]);
    const { rows: [br] } = await pool.query('SELECT id FROM branches WHERE is_default');
    const branch = Number(br.id);

    const users = [];
    for (let i = 0; i < USERS; i += 1) {
        const username = `qa${i}_${RUN}`;
        const res = await api('POST', '/users', {
            token: admin,
            ip: IP.admin,
            body: {
                username,
                full_name: `QA CONCURRENCIA ${i}`,
                password: TEST_PASS,
                role: i < 6 ? 'cobrador' : 'vendedor',
                branch_id: branch,
            },
        });
        users.push({ id: res.body?.data?.id, username, status: res.status });
    }
    check(`Se crean ${USERS} usuarios de prueba`, users.every((u) => u.status === 201),
        codes(users.map((u) => ({ status: u.status }))));

    const mkCustomer = async (suf, nombre, ip = IP.admin) =>
        api('POST', '/customers', {
            token: admin,
            ip,
            body: {
                dpi: `4${RUN}${suf}`.slice(0, 13).padEnd(13, '0'),
                full_name: nombre,
                phone: '55550000',
                address: 'DIRECCION QA CONCURRENCIA',
            },
        });
    const cliente = Number((await mkCustomer('01', `QA CONCURRENCIA CLIENTE ${RUN}`)).body?.data?.id);

    // ==================================================== 1. LOGIN CONCURRENTE
    console.log('\n[1] Login concurrente');

    // --- 1a. Los 8 detrás del MISMO router (NAT). Es el caso de la agencia.
    const nat = await Promise.all(users.map((u) => login(u.username, TEST_PASS, IP.nat)));
    check(`Los ${USERS} usuarios entran a la vez desde la MISMA IP pública (NAT)`,
        nat.every((r) => r.status === 200 && r.body?.data?.token),
        codes(nat));
    check('Ningún login válido fue bloqueado por el limitador (0 respuestas 429)',
        count(nat, (r) => r.status === 429) === 0, codes(nat));
    const tokens = nat.map((r) => r.body?.data?.token);
    // El rol importa: `cobrador` cobra pero NO registra clientes, y `vendedor`
    // registra clientes pero solo cobra su propia cartera. Cada escenario usa
    // los tokens que corresponden.
    const cobradores = tokens.filter((_, i) => i < 6);
    const vendedores = tokens.filter((_, i) => i >= 6);
    console.log(`  ${c.dim}tiempos NAT: ${fmt(stats(nat))}${c.off}`);

    // --- 1b. Ocho usuarios desde ocho IPs distintas.
    const spread = await Promise.all(users.map((u, i) => login(u.username, TEST_PASS, IP.distinct(i))));
    check(`Los ${USERS} usuarios entran a la vez desde IPs DISTINTAS`,
        spread.every((r) => r.status === 200), codes(spread));
    console.log(`  ${c.dim}tiempos IPs distintas: ${fmt(stats(spread))}${c.off}`);

    // --- 1c. Los aciertos NO consumen presupuesto.
    const seguidos = [];
    for (let i = 0; i < 15; i += 1) seguidos.push(await login(users[0].username, TEST_PASS, IP.nat));
    check('15 logins CORRECTOS seguidos no agotan el límite: los aciertos no cuentan',
        seguidos.every((r) => r.status === 200), codes(seguidos));

    // --- 1d. Fuerza bruta real: 10 fallos por IP+usuario y se cierra.
    const objetivo = users[1].username;
    const fallos = [];
    for (let i = 0; i < config.rateLimit.login.perUserLimit; i += 1) {
        fallos.push(await login(objetivo, 'clave-incorrecta', IP.brute));
    }
    const pasado = await login(objetivo, 'clave-incorrecta', IP.brute);
    check(`Tras ${config.rateLimit.login.perUserLimit} fallos, ese IP+usuario queda frenado (429)`,
        fallos.every((r) => r.status === 401) && pasado.status === 429,
        `${codes(fallos)} -> ${pasado.status}`);

    const validoFrenado = await login(objetivo, TEST_PASS, IP.brute);
    check('El freno aguanta aunque la contraseña ahora sea correcta (misma IP+usuario)',
        validoFrenado.status === 429, String(validoFrenado.status));

    const otraIp = await login(objetivo, TEST_PASS, IP.brute2);
    check('La CUENTA no queda bloqueada: el mismo usuario entra desde otra IP',
        otraIp.status === 200, String(otraIp.status));

    const otroUsuario = await login(users[2].username, TEST_PASS, IP.brute);
    check('El freno es por IP+usuario: otro usuario del mismo router sigue entrando',
        otroUsuario.status === 200, String(otroUsuario.status));

    const inexistente = await login(`fantasma_${RUN}`, 'x', IP.brute2);
    check('Un usuario inexistente responde 401, sin revelar si existe',
        inexistente.status === 401, String(inexistente.status));

    // ==================================================== 2. CLIENTES
    console.log('\n[2] Clientes simultáneos');

    // Un cobrador NO puede dar de alta clientes: se comprueba que el control
    // de permisos aguante también cuando entra tráfico en paralelo.
    const sinPermiso = await Promise.all(
        Array.from({ length: 4 }, () =>
            api('POST', '/customers', {
                token: cobradores[0],
                ip: IP.customers,
                body: {
                    dpi: `4${RUN}70`.slice(0, 13).padEnd(13, '0'),
                    full_name: `QA CONCURRENCIA SIN PERMISO ${RUN}`,
                    phone: '55550000',
                    address: 'DIRECCION QA',
                },
            })
        )
    );
    check('Bajo carga, un cobrador sigue sin poder registrar clientes (403)',
        sinPermiso.every((r) => r.status === 403), codes(sinPermiso));

    const dpis = users.map((_, i) => `4${RUN}${String(20 + i).padStart(2, '0')}`.slice(0, 13).padEnd(13, '0'));
    const nuevos = await Promise.all(
        users.map((u, i) =>
            api('POST', '/customers', {
                token: vendedores[i % vendedores.length],
                ip: IP.customers,
                body: {
                    dpi: dpis[i],
                    full_name: `QA CONCURRENCIA NUEVO ${i} ${RUN}`,
                    phone: '55550000',
                    address: 'DIRECCION QA',
                },
            })
        )
    );
    check(`${USERS} clientes DISTINTOS creados en paralelo: todos aceptados`,
        nuevos.every((r) => r.status === 201), codes(nuevos));
    const { rows: [creados] } = await pool.query(
        `SELECT COUNT(*)::int AS n FROM customers WHERE dpi = ANY($1::varchar[])`, [dpis]);
    check('Quedaron exactamente esos clientes en la base, sin pérdidas ni repeticiones',
        creados.n === USERS, `${creados.n} de ${USERS}`);

    const dpiRepetido = `4${RUN}90`.slice(0, 13).padEnd(13, '0');
    const duplicados = await Promise.all(
        Array.from({ length: 6 }, (_, i) =>
            api('POST', '/customers', {
                token: vendedores[i % vendedores.length],
                ip: IP.customers,
                body: {
                    dpi: dpiRepetido,
                    full_name: `QA CONCURRENCIA DUPLICADO ${i} ${RUN}`,
                    phone: '55550000',
                    address: 'DIRECCION QA',
                },
            })
        )
    );
    const { rows: [unico] } = await pool.query('SELECT COUNT(*)::int AS n FROM customers WHERE dpi = $1', [dpiRepetido]);
    check('Seis altas SIMULTÁNEAS con el mismo DPI dejan UN solo cliente',
        unico.n === 1, `${unico.n} filas · respuestas ${codes(duplicados)}`);
    check('Las cinco rechazadas son errores de cliente (4xx), no fallos del servidor',
        count(duplicados, (r) => r.status === 201) === 1 &&
            count(duplicados, (r) => r.status >= 400 && r.status < 500) === 5,
        codes(duplicados));

    // ==================================================== 3. CONSULTAS
    console.log('\n[3] Consultas simultáneas');

    const rutas = [
        '/dashboard',
        '/collections?pageSize=20',
        '/collections/summary',
        '/collections/installments?pageSize=20',
        '/customers?pageSize=20',
        '/payments?pageSize=20',
        '/receipts?pageSize=20',
        '/sales?pageSize=20',
    ];
    const lecturas = await Promise.all(
        Array.from({ length: READERS }, (_, u) =>
            Promise.all(rutas.map((r) => api('GET', r, { token: tokens[u % tokens.length], ip: IP.reads(u) })))
        )
    ).then((x) => x.flat());
    check(`${READERS} usuarios × ${rutas.length} pantallas a la vez: ninguna respuesta 5xx`,
        count(lecturas, (r) => r.status >= 500) === 0,
        lecturas.filter((r) => r.status >= 500).length + ' errores');
    check('Todas las consultas responden 200',
        lecturas.every((r) => r.status === 200),
        codes(lecturas.filter((r) => r.status !== 200)) || 'ok');
    console.log(`  ${c.dim}tiempos de lectura: ${fmt(stats(lecturas))}${c.off}`);

    // ==================================================== 4. PAGOS CONCURRENTES
    console.log('\n[4] Pagos concurrentes sobre el MISMO crédito');

    // --- 4a. Dos cobros a la vez que juntos exceden el saldo.
    const venta = await ventaControlada({ customerId: cliente, createdBy: adminRow.id, branchId: branch, cuotas: [100, 100, 100, 100] });
    const choque = await Promise.all([
        api('POST', '/payments', { token: cobradores[0], ip: IP.pays(0), body: { sale_id: venta.id, amount: 250, method: 'efectivo' } }),
        api('POST', '/payments', { token: cobradores[1], ip: IP.pays(1), body: { sale_id: venta.id, amount: 250, method: 'efectivo' } }),
    ]);
    const e1 = await estado(venta.id);
    check('Dos cobros simultáneos de Q250 sobre un saldo de Q400: solo uno entra',
        count(choque, (r) => r.status === 201) === 1 && count(choque, (r) => r.status >= 500) === 0,
        codes(choque));
    check('El saldo NO se duplica ni se aplica dinero de más: 400 - 250 = 150',
        q(e1.balance) === '150.00' && q(e1.pagos) === '250.00' && e1.n_pagos === 1,
        JSON.stringify(e1));

    // --- 4b. Varios cobros pequeños a la vez: todos deben entrar y cuadrar.
    // El crédito se dimensiona según la concurrencia: la ráfaga tiene que
    // caber en el saldo, porque lo que se prueba aquí es que NO se pierda ni
    // se duplique dinero, no el rechazo por exceder saldo (eso es el caso 4a).
    const cuotaBase = Math.ceil((PAYERS * 30 + 100) / 4);
    const venta2 = await ventaControlada({
        customerId: cliente, createdBy: adminRow.id, branchId: branch,
        cuotas: [cuotaBase, cuotaBase, cuotaBase, cuotaBase],
    });
    const totalVenta2 = cuotaBase * 4;
    const rafaga = await Promise.all(
        Array.from({ length: PAYERS }, (_, i) =>
            api('POST', '/payments', {
                token: cobradores[i % cobradores.length],
                ip: IP.pays(i),
                body: { sale_id: venta2.id, amount: 30, method: 'efectivo' },
            })
        )
    );
    const e2 = await estado(venta2.id);
    check(`${PAYERS} cobros simultáneos de Q30 se aplican todos, sin perderse ninguno`,
        rafaga.every((r) => r.status === 201) && e2.n_pagos === PAYERS,
        `${codes(rafaga)} · ${e2.n_pagos} pagos`);
    check(`El saldo baja EXACTAMENTE lo cobrado: ${totalVenta2} - ${PAYERS * 30} = ${totalVenta2 - PAYERS * 30}`,
        q(e2.balance) === q(totalVenta2 - PAYERS * 30) && q(e2.pagos) === q(PAYERS * 30),
        JSON.stringify(e2));
    check('Lo cobrado coincide con lo asignado a cuotas: ningún quetzal se aplica dos veces',
        q(e2.pagos) === q(e2.asignado), `pagos ${e2.pagos} vs asignado ${e2.asignado}`);
    check('Ninguna cuota queda sobrepagada ni con saldo negativo',
        e2.sobrepagadas === 0 && e2.negativas === 0, JSON.stringify(e2));

    const { rows: fifo } = await pool.query(
        `SELECT number, paid_amount, balance FROM v_installments
          WHERE sale_id=$1 AND NOT is_superseded ORDER BY number`, [venta2.id]);
    // Reparto FIFO esperado: se llenan las cuotas en orden, sin saltar ninguna.
    // No se replica lógica de negocio, solo se expresa la regla ya definida.
    const cobrado = PAYERS * 30;
    const esperadoFifo = [0, 1, 2, 3].map((k) =>
        q(Math.min(cuotaBase, Math.max(0, cobrado - cuotaBase * k)))
    );
    const realFifo = fifo.map((i) => q(i.paid_amount));
    check('El FIFO se respeta bajo concurrencia: las cuotas se llenan en orden, sin saltos',
        realFifo.join(',') === esperadoFifo.join(','),
        `esperado ${esperadoFifo.join(',')} · real ${realFifo.join(',')}`);

    const { rows: [recibos] } = await pool.query(
        `SELECT COUNT(*)::int AS n,
                COUNT(*) FILTER (WHERE r.balance_after <> r.balance_before - r.amount)::int AS descuadrados
           FROM payment_receipts r JOIN payments p ON p.id = r.payment_id
          WHERE p.sale_id = $1`, [venta2.id]);
    check('Cada pago concurrente emitió UN recibo y todos cuadran',
        recibos.n === PAYERS && recibos.descuadrados === 0, JSON.stringify(recibos));
    console.log(`  ${c.dim}tiempos de cobro: ${fmt(stats([...choque, ...rafaga]))}${c.off}`);

    // ==================================================== 5. IDEMPOTENCIA
    console.log('\n[5] Idempotencia bajo envío simultáneo');

    const venta3 = await ventaControlada({ customerId: cliente, createdBy: adminRow.id, branchId: branch, cuotas: [100, 100, 100, 100] });
    const clave = `qa-conc-${RUN}`;
    const repetidos = await Promise.all(
        Array.from({ length: IDEMPOTENT_SHOTS }, (_, i) =>
            api('POST', '/payments', {
                token: cobradores[0],
                ip: IP.idem,
                key: clave,
                body: { sale_id: venta3.id, amount: 75, method: 'efectivo' },
            })
        )
    );
    const e3 = await estado(venta3.id);
    check(`${IDEMPOTENT_SHOTS} envíos SIMULTÁNEOS con la misma Idempotency-Key: un solo pago efectivo`,
        e3.n_pagos === 1 && q(e3.pagos) === '75.00', JSON.stringify(e3));
    check('Ninguno falla: uno crea (201) y el resto son reenvíos (200)',
        count(repetidos, (r) => r.status === 201) === 1 &&
            count(repetidos, (r) => r.status === 200) === IDEMPOTENT_SHOTS - 1,
        codes(repetidos));
    check('Todas las respuestas devuelven el MISMO pago',
        new Set(repetidos.map((r) => r.body?.data?.payment?.id)).size === 1,
        [...new Set(repetidos.map((r) => r.body?.data?.payment?.id))].join(','));

    const { rows: [unicos] } = await pool.query(
        `SELECT (SELECT COUNT(*) FROM payment_receipts r JOIN payments p ON p.id=r.payment_id
                  WHERE p.sale_id=$1)::int AS recibos,
                (SELECT COUNT(*) FROM integration_events e
                  JOIN payments p2 ON p2.id = e.aggregate_id
                 WHERE e.event_type='payment.created' AND p2.sale_id=$1)::int AS eventos`,
        [venta3.id]);
    check('Tampoco se duplican el recibo ni el evento del outbox',
        unicos.recibos === 1 && unicos.eventos === 1, JSON.stringify(unicos));

    const distinto = await api('POST', '/payments', {
        token: cobradores[0], ip: IP.idem, key: clave,
        body: { sale_id: venta3.id, amount: 99, method: 'efectivo' },
    });
    check('Reutilizar la clave con datos DISTINTOS se rechaza (409), no cobra',
        distinto.status === 409, String(distinto.status));

    // ==================================================== 6. INTEGRIDAD
    console.log('\n[6] Integridad después de la carga');

    const ventas = [venta.id, venta2.id, venta3.id];
    const { rows: [integridad] } = await pool.query(
        `SELECT
            (SELECT COUNT(*) FROM v_sales vs
              WHERE vs.id = ANY($1::bigint[])
                AND vs.balance <> vs.total - vs.paid_amount)::int                      AS saldos_malos,
            (SELECT COUNT(*) FROM v_installments
              WHERE sale_id = ANY($1::bigint[]) AND (balance < 0 OR paid_amount > amount))::int AS cuotas_malas,
            (SELECT COUNT(*) FROM payments p
              LEFT JOIN payment_receipts r ON r.payment_id = p.id
             WHERE p.sale_id = ANY($1::bigint[]) AND r.id IS NULL)::int                AS pagos_sin_recibo,
            (SELECT COUNT(*) FROM payment_receipts r
              LEFT JOIN payments p ON p.id = r.payment_id
             WHERE p.id IS NULL)::int                                                  AS recibos_huerfanos,
            (SELECT COUNT(*) FROM payment_allocations pa
              LEFT JOIN payments p ON p.id = pa.payment_id
             WHERE p.id IS NULL)::int                                                  AS asignaciones_huerfanas,
            (SELECT COUNT(*) FROM deposit_payments dp
              LEFT JOIN deposits d ON d.id = dp.deposit_id
             WHERE d.id IS NULL)::int                                                  AS depositos_huerfanos,
            (SELECT COUNT(*) FROM payments p
              LEFT JOIN integration_events e
                     ON e.event_type='payment.created' AND e.aggregate_id = p.id
             WHERE p.sale_id = ANY($1::bigint[]) AND e.id IS NULL)::int                AS pagos_sin_evento`,
        [ventas]
    );
    check('El saldo de cada crédito sigue siendo total menos lo pagado',
        integridad.saldos_malos === 0, String(integridad.saldos_malos));
    check('No hay cuotas con saldo negativo ni sobrepagadas',
        integridad.cuotas_malas === 0, String(integridad.cuotas_malas));
    check('Cada pago tiene su recibo y cada recibo su pago',
        integridad.pagos_sin_recibo === 0 && integridad.recibos_huerfanos === 0, JSON.stringify(integridad));
    check('No hay asignaciones de pago huérfanas', integridad.asignaciones_huerfanas === 0);
    check('No hay pagos depositados sin depósito', integridad.depositos_huerfanos === 0);
    check('Cada pago dejó su evento payment.created en el outbox',
        integridad.pagos_sin_evento === 0, String(integridad.pagos_sin_evento));

    check('Ninguna petición de toda la prueba terminó en 5xx',
        serverErrors.length === 0, serverErrors.slice(0, 5).join(' | '));

    // ==================================================== RESUMEN DE TIEMPOS
    console.log('\n[7] Tiempos de respuesta');
    const porRuta = new Map();
    for (const t of timings) {
        if (!porRuta.has(t.tag)) porRuta.set(t.tag, []);
        porRuta.get(t.tag).push(t.ms);
    }
    const global = stats(timings.map((t) => t.ms));
    for (const [tag, xs] of [...porRuta.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 8)) {
        console.log(`  ${c.dim}${tag.padEnd(28)} ${fmt(stats(xs))}${c.off}`);
    }
    console.log(`  ${c.dim}${'TOTAL'.padEnd(28)} ${fmt(global)}${c.off}`);
    check('El percentil 95 de todas las peticiones se mantiene por debajo de 2 s',
        global.p95 < 2000, `p95 = ${global.p95} ms`);
    console.log(`  ${c.dim}duración de la prueba: ${((Date.now() - t0) / 1000).toFixed(1)} s${c.off}`);
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
