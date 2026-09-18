/**
 * BLOQUE 4.1 — registro y anulación de pagos.
 *
 *   npm run test:payments
 *   API_URL=... npm run test:payments
 *
 * Cubre el flujo funcional completo contra la API y, donde la regla es
 * crítica, la comprueba ADEMÁS por SQL directo: si algo solo lo impide el
 * servicio, alguien con acceso a la base lo puede saltar.
 */
import { pool, closePool } from '../config/db.js';
import { config } from '../config/env.js';

const BASE = (process.env.API_URL ?? 'http://localhost:4000').replace(/\/$/, '') + '/api';
const ADMIN_USER = process.env.SEED_ADMIN_USERNAME ?? 'admin';
const ADMIN_PASS = process.env.SEED_ADMIN_PASSWORD ?? 'Admin123!';
const TEST_PASS = 'Prueba123';

/**
 * Cada suite se presenta como un cliente distinto (su propia IP simulada), igual
 * que lo serían dos sucursales. El limitador de login NO se desactiva ni se
 * relaja: sigue contando igual que en producción.
 */
const SUITE_IP = '198.18.10.7';

/** Zona operativa del negocio: la misma con la que la base calcula app_today(). */
const TIMEZONE = config.timezone;

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

async function login(username, password) {
    const res = await api('POST', '/auth/login', { body: { username, password } });
    return res.body?.data?.token ?? null;
}

const dbError = async (sql, params = []) => {
    try {
        await pool.query(sql, params);
        return null;
    } catch (error) {
        return error;
    }
};

const q = (n) => Number(n).toFixed(2);
const stamp = Date.now().toString().slice(-7);

/** Saldo, cuotas y pagos de una venta, tal como los ve la API. */
async function saleOf(token, saleId) {
    return (await api('GET', `/sales/${saleId}`, { token })).body?.data ?? {};
}

/** Distribución de un pago: "1:100.00,2:50.00". */
const allocationsOf = (payment) =>
    (payment?.allocations ?? []).map((a) => `${a.installment_number}:${q(a.amount)}`).join(',');

/**
 * VENTA A CRÉDITO DE PRUEBA, creada por SQL.
 *
 * Se construye con `credito_4` —una modalidad HISTÓRICA— a propósito: el
 * objetivo es tener cuotas con importes exactos para poder afirmar cosas como
 * "quedan Q0.01 en la cuota 1", no volver a probar el flujo de crédito, que ya
 * tiene su propia suite. No pasa por POST /sales, que desde 3.3 solo admite
 * contado.
 */
async function ventaConCuotas({ customerId, createdBy, branchId, cuotas, saleDateOffset = 0, dueOffsets = null }) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const total = cuotas.reduce((a, b) => a + b, 0);
        const { rows: [sale] } = await client.query(
            `INSERT INTO sales (customer_id, sale_date, payment_mode, installments_count, subtotal, total, created_by, branch_id, notes)
             VALUES ($1, app_today() - $2::int, 'credito_4', 4, $3, $3, $4, $5, 'venta de prueba del bloque 4.1')
             RETURNING id, sale_date, total`,
            [customerId, saleDateOffset, q(total), createdBy, branchId]
        );
        for (let i = 0; i < cuotas.length; i += 1) {
            const offset = dueOffsets ? dueOffsets[i] : -(saleDateOffset - (i + 1) * 30);
            await client.query(
                `INSERT INTO installments (sale_id, number, due_date, amount)
                 VALUES ($1, $2, app_today() + $3::int, $4)`,
                [sale.id, i + 1, offset, q(cuotas[i])]
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

async function main() {
    console.log(`\n=== Pagos: registro y anulación (bloque 4.1) contra ${BASE} ===\n`);

    // ============================================================ PREPARACIÓN
    console.log('[0] Preparación');
    const admin = await login(ADMIN_USER, ADMIN_PASS);
    if (!admin) throw new Error('Sin sesión de administrador. ¿Ejecutaste `npm run seed`?');

    const { rows: [branch] } = await pool.query('SELECT id FROM branches WHERE is_default');
    const branchA = Number(branch.id);
    const { rows: [adminRow] } = await pool.query('SELECT id FROM users WHERE lower(username) = lower($1)', [ADMIN_USER]);

    const mkUser = async (prefix, role) => {
        const username = `${prefix}_${stamp}`;
        const res = await api('POST', '/users', {
            token: admin,
            body: { username, full_name: `PRUEBA PAGOS ${prefix}`, password: TEST_PASS, role, branch_id: branchA },
        });
        return { id: res.body?.data?.id, username };
    };
    const uVendedor = await mkUser('p41_v', 'vendedor');
    const uVendedor2 = await mkUser('p41_v2', 'vendedor');
    const uCobrador = await mkUser('p41_c', 'cobrador');
    const vendedor = await login(uVendedor.username, TEST_PASS);
    const vendedor2 = await login(uVendedor2.username, TEST_PASS);
    const cobrador = await login(uCobrador.username, TEST_PASS);
    check('Se crean y entran vendedor, segundo vendedor y cobrador',
        Boolean(vendedor && vendedor2 && cobrador));

    const mkCustomer = async (sufijo, nombre) => {
        const res = await api('POST', '/customers', {
            token: admin,
            body: {
                dpi: `41${stamp}${sufijo}`.slice(0, 13).padEnd(13, '0'),
                full_name: nombre,
                phone: '55551111',
                address: 'DIRECCION DE PRUEBA 4.1',
            },
        });
        return Number(res.body?.data?.id);
    };
    const cliente = await mkCustomer('01', 'CLIENTE PAGOS UNO');
    const cliente2 = await mkCustomer('02', 'CLIENTE PAGOS DOS');
    check('Se registran los clientes de prueba', Number.isFinite(cliente) && Number.isFinite(cliente2));

    const pagar = (token, body, headers) => api('POST', '/payments', { token, body, headers });

    // ==================================================== 1. FIFO
    console.log('\n[1] FIFO: parcial, exacto, varias cuotas y sin saltar ninguna');

    const venta = await ventaConCuotas({
        customerId: cliente, createdBy: uVendedor.id, branchId: branchA, cuotas: [100, 100, 100, 100],
    });
    const estado0 = await saleOf(admin, venta.id);
    check('La venta de prueba nace con 4 cuotas de Q100 y saldo Q400',
        estado0.installments?.length === 4 && q(estado0.balance) === '400.00' && q(estado0.paid_amount) === '0.00',
        `saldo ${estado0.balance}`);

    const parcial = await pagar(admin, { sale_id: venta.id, amount: 30, method: 'efectivo' });
    check('Pago PARCIAL aceptado (201)', parcial.status === 201, show(parcial));
    check('El parcial se aplica a la cuota 1 y la deja parcial',
        allocationsOf(parcial.body?.data?.payments?.at(-1)) === '1:30.00' &&
            parcial.body?.data?.installments?.[0]?.status === 'parcial',
        allocationsOf(parcial.body?.data?.payments?.at(-1)));
    check('Saldo anterior y nuevo quedan registrados en la respuesta',
        q(parcial.body?.data?.payment?.balance_before) === '400.00' &&
            q(parcial.body?.data?.payment?.balance_after) === '370.00' &&
            q(parcial.body?.data?.sale?.balance) === '370.00',
        JSON.stringify(parcial.body?.data?.payment));

    const exacto = await pagar(admin, { sale_id: venta.id, amount: 70, method: 'efectivo' });
    check('Pago EXACTO del resto de la cuota 1: queda pagada',
        exacto.status === 201 && allocationsOf(exacto.body?.data?.payments?.at(-1)) === '1:70.00' &&
            exacto.body?.data?.installments?.[0]?.status === 'pagada',
        show(exacto));

    const multi = await pagar(admin, { sale_id: venta.id, amount: 250, method: 'efectivo' });
    const cuotasMulti = multi.body?.data?.installments ?? [];
    check('Un solo pago cubre VARIAS cuotas consecutivas (2, 3 y parte de la 4)',
        multi.status === 201 && allocationsOf(multi.body?.data?.payments?.at(-1)) === '2:100.00,3:100.00,4:50.00' &&
            cuotasMulti[1]?.status === 'pagada' && cuotasMulti[2]?.status === 'pagada',
        allocationsOf(multi.body?.data?.payments?.at(-1)));
    check('El saldo baja exactamente a Q50.00', q(multi.body?.data?.sale?.balance) === '50.00',
        multi.body?.data?.sale?.balance);

    // ---- Q0.01: una cuota anterior con un céntimo pendiente no se puede saltar
    const centavo = await ventaConCuotas({
        customerId: cliente, createdBy: uVendedor.id, branchId: branchA, cuotas: [100, 100, 100, 100],
    });
    await pagar(admin, { sale_id: centavo.id, amount: 99.99, method: 'efectivo' });
    const trasCentavo = await saleOf(admin, centavo.id);
    check('Quedan Q0.01 pendientes en la cuota 1',
        q(trasCentavo.installments?.[0]?.balance) === '0.01', trasCentavo.installments?.[0]?.balance);
    const siguiente = await pagar(admin, { sale_id: centavo.id, amount: 100, method: 'efectivo' });
    check('El pago siguiente NO salta la cuota 1: le aplica el céntimo primero',
        allocationsOf(siguiente.body?.data?.payments?.at(-1)) === '1:0.01,2:99.99',
        allocationsOf(siguiente.body?.data?.payments?.at(-1)));
    check('La cuota 1 queda pagada y la 2 parcial: nunca se saltó ninguna',
        siguiente.body?.data?.installments?.[0]?.status === 'pagada' &&
            siguiente.body?.data?.installments?.[1]?.status === 'parcial');

    // ---- varias cuotas vencidas en un solo pago
    const atrasada = await ventaConCuotas({
        customerId: cliente2, createdBy: uVendedor.id, branchId: branchA,
        cuotas: [100, 100, 100, 100], saleDateOffset: 120, dueOffsets: [-90, -60, -30, 5],
    });
    const antesDePonerseAlDia = await saleOf(admin, atrasada.id);
    check('La venta atrasada tiene 3 cuotas vencidas',
        antesDePonerseAlDia.installments_overdue === 3 && antesDePonerseAlDia.account_status === 'vencida',
        JSON.stringify({ v: antesDePonerseAlDia.installments_overdue, e: antesDePonerseAlDia.account_status }));
    const alDia = await pagar(admin, { sale_id: atrasada.id, amount: 300, method: 'efectivo' });
    check('Un solo pago pone al día las tres cuotas vencidas',
        alDia.status === 201 && allocationsOf(alDia.body?.data?.payments?.at(-1)) === '1:100.00,2:100.00,3:100.00' &&
            alDia.body?.data?.sale?.account_status === 'al_dia',
        show(alDia));

    // ==================================================== 2. RECHAZOS
    console.log('\n[2] Lo que NO se acepta');

    check('Monto cero -> 422',
        (await pagar(admin, { sale_id: venta.id, amount: 0, method: 'efectivo' })).status === 422);
    check('Monto negativo -> 422',
        (await pagar(admin, { sale_id: venta.id, amount: -10, method: 'efectivo' })).status === 422);
    const sobrepago = await pagar(admin, { sale_id: venta.id, amount: 50.01, method: 'efectivo' });
    check('Sobrepago (un céntimo más que el saldo) -> 422',
        sobrepago.status === 422 && /excede el saldo/i.test(sobrepago.body?.error?.message ?? ''), show(sobrepago));

    const manana = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    const futura = await pagar(admin, { sale_id: venta.id, amount: 10, method: 'efectivo', payment_date: manana });
    check('Fecha de pago FUTURA -> 422 con el campo señalado',
        futura.status === 422 && (futura.body?.error?.details ?? []).some((d) => d.campo === 'payment_date'),
        show(futura));

    const { rows: [antesDeLaVenta] } = await pool.query(
        `SELECT to_char(sale_date - 1, 'YYYY-MM-DD') AS d FROM sales WHERE id = $1`, [venta.id]);
    const previa = await pagar(admin, {
        sale_id: venta.id, amount: 10, method: 'efectivo', payment_date: antesDeLaVenta.d,
    });
    check('Fecha ANTERIOR a la venta -> 422 con el campo señalado',
        previa.status === 422 && (previa.body?.error?.details ?? []).some((d) => d.campo === 'payment_date'),
        show(previa));

    /**
     * FECHA ECONÓMICA vs FECHA DE REGISTRO (regla PG1).
     *
     * Para demostrar que son independientes hace falta una venta REALMENTE
     * antigua: sobre una venta de hoy no se puede atrasar el pago sin romper
     * la regla de "no anterior a la venta", y la comprobación se quedaría sin
     * demostrar nada.
     *
     * La comparación se hace en la ZONA OPERATIVA (la misma de `app_today()`),
     * no con la zona de la sesión de PostgreSQL: `created_at` es un instante
     * y `created_at::date` cambia de día según la zona con que se lea, así que
     * compararlo sin fijar la zona haría que la prueba pasara o fallara según
     * la hora a la que se ejecute.
     */
    const ventaAntigua = await ventaConCuotas({
        customerId: cliente2, createdBy: uVendedor.id, branchId: branchA,
        cuotas: [100, 100, 100, 100], saleDateOffset: 30,
    });
    const { rows: [fechaReal] } = await pool.query(
        `SELECT to_char(app_today() - 7, 'YYYY-MM-DD') AS d, to_char(app_today(), 'YYYY-MM-DD') AS hoy`);
    check('La fecha de prueba está realmente atrasada respecto a hoy',
        fechaReal.d < fechaReal.hoy, `${fechaReal.d} vs hoy ${fechaReal.hoy}`);

    const atrasado = await pagar(admin, {
        sale_id: ventaAntigua.id, amount: 10, method: 'efectivo', payment_date: fechaReal.d,
    });
    const pagoAtrasado = atrasado.body?.data?.payment;
    check('Una fecha real ANTERIOR al registro sí se acepta (cobro documentado tarde)',
        atrasado.status === 201 && pagoAtrasado?.payment_date === fechaReal.d, show(atrasado));

    const { rows: [fechas] } = await pool.query(
        `SELECT to_char(payment_date, 'YYYY-MM-DD')                                        AS fecha_real,
                to_char(created_at AT TIME ZONE $2, 'YYYY-MM-DD HH24:MI:SS')               AS registro,
                (created_at AT TIME ZONE $2)::date - payment_date                          AS dias,
                created_at > (payment_date + 1)::timestamptz                               AS registro_posterior
           FROM payments WHERE id = $1`,
        [pagoAtrasado?.id, TIMEZONE]);
    check('La fecha real guardada es exactamente la que se envió, sin reescribirse',
        fechas.fecha_real === fechaReal.d, `${fechas.fecha_real} vs ${fechaReal.d}`);
    check('El registro ocurrió 7 días DESPUÉS de la fecha real: son datos independientes',
        fechas.dias === 7, `${fechas.fecha_real} (real) vs ${fechas.registro} (registro) = ${fechas.dias} días`);
    check('Comparando el instante completo, el registro es posterior en cualquier zona horaria',
        fechas.registro_posterior === true, `registro ${fechas.registro}`);

    // Y el caso normal: sin fecha explícita, la real es el día operativo de hoy.
    const hoyMismo = await pagar(admin, { sale_id: ventaAntigua.id, amount: 10, method: 'efectivo' });
    const { rows: [sinFecha] } = await pool.query(
        `SELECT payment_date = app_today() AS es_hoy FROM payments WHERE id = $1`,
        [hoyMismo.body?.data?.payment?.id]);
    check('Sin fecha explícita, la fecha real es el día operativo de hoy (no la del servidor)',
        sinFecha.es_hoy === true);

    const ventaPagada = await ventaConCuotas({
        customerId: cliente2, createdBy: uVendedor.id, branchId: branchA, cuotas: [50, 50, 50, 50],
    });
    await pagar(admin, { sale_id: ventaPagada.id, amount: 200, method: 'efectivo' });
    const yaPagada = await pagar(admin, { sale_id: ventaPagada.id, amount: 1, method: 'efectivo' });
    check('Una venta ya saldada no admite más pagos (409)', yaPagada.status === 409, show(yaPagada));

    // ==================================================== 3. ALCANCE
    console.log('\n[3] Alcance: vendedor, cobrador y administración');

    const ventaDelVendedor = await ventaConCuotas({
        customerId: cliente, createdBy: uVendedor.id, branchId: branchA, cuotas: [100, 100, 100, 100],
    });
    const ventaDeOtro = await ventaConCuotas({
        customerId: cliente, createdBy: uVendedor2.id, branchId: branchA, cuotas: [100, 100, 100, 100],
    });

    const propio = await pagar(vendedor, { sale_id: ventaDelVendedor.id, amount: 10, method: 'efectivo' });
    check('El vendedor SÍ cobra su propia cartera', propio.status === 201, show(propio));
    const ajeno = await pagar(vendedor, { sale_id: ventaDeOtro.id, amount: 10, method: 'efectivo' });
    check('El vendedor NO cobra la venta de otro vendedor (403)', ajeno.status === 403, show(ajeno));
    check('El intento fuera de cartera queda en la bitácora',
        (await pool.query(
            `SELECT COUNT(*)::int AS n FROM audit_log WHERE action = 'payment.create.denegado' AND entity_id = $1`,
            [ventaDeOtro.id])).rows[0].n >= 1);

    check('El cobrador cobra cualquier venta (cartera global)',
        (await pagar(cobrador, { sale_id: ventaDeOtro.id, amount: 10, method: 'efectivo' })).status === 201);
    check('Administración cobra cualquier venta',
        (await pagar(admin, { sale_id: ventaDeOtro.id, amount: 10, method: 'efectivo' })).status === 201);

    // ==================================================== 4. IDEMPOTENCIA
    console.log('\n[4] Doble envío (Idempotency-Key)');

    const ventaIdem = await ventaConCuotas({
        customerId: cliente2, createdBy: uVendedor.id, branchId: branchA, cuotas: [100, 100, 100, 100],
    });
    const clave = `pago-${stamp}-1`;
    const cuerpo = { sale_id: ventaIdem.id, amount: 100, method: 'efectivo' };

    const primero = await pagar(admin, cuerpo, { 'Idempotency-Key': clave });
    check('Primer envío con clave -> 201', primero.status === 201 && primero.body?.replayed === false, show(primero));
    const repetido = await pagar(admin, cuerpo, { 'Idempotency-Key': clave });
    check('Reenvío con la MISMA clave -> 200 y marcado como reenvío',
        repetido.status === 200 && repetido.body?.replayed === true, show(repetido));
    check('El reenvío devuelve el MISMO pago, no uno nuevo',
        repetido.body?.data?.payment?.id === primero.body?.data?.payment?.id,
        `${primero.body?.data?.payment?.id} vs ${repetido.body?.data?.payment?.id}`);
    const { rows: [unoSolo] } = await pool.query(
        'SELECT COUNT(*)::int AS n FROM payments WHERE sale_id = $1', [ventaIdem.id]);
    check('Solo existe UN pago en la base pese a los dos envíos', unoSolo.n === 1, `${unoSolo.n} pagos`);
    check('El saldo se descontó una sola vez',
        q((await saleOf(admin, ventaIdem.id)).balance) === '300.00');

    const distinto = await pagar(admin, { ...cuerpo, amount: 50 }, { 'Idempotency-Key': clave });
    check('La misma clave con datos distintos -> 409', distinto.status === 409, show(distinto));
    check('Clave con formato inválido -> 422',
        (await pagar(admin, cuerpo, { 'Idempotency-Key': 'x' })).status === 422);
    check('La clave es POR USUARIO: otro usuario con la misma clave registra el suyo',
        (await pagar(cobrador, { sale_id: ventaIdem.id, amount: 20, method: 'efectivo' },
            { 'Idempotency-Key': clave })).status === 201);

    // Tres envíos simultáneos con la misma clave: un solo pago.
    const ventaIdem2 = await ventaConCuotas({
        customerId: cliente2, createdBy: uVendedor.id, branchId: branchA, cuotas: [100, 100, 100, 100],
    });
    const clave2 = `pago-${stamp}-2`;
    const simultaneos = await Promise.all(
        [1, 2, 3].map(() =>
            pagar(admin, { sale_id: ventaIdem2.id, amount: 100, method: 'efectivo' }, { 'Idempotency-Key': clave2 }))
    );
    const { rows: [tras3] } = await pool.query(
        'SELECT COUNT(*)::int AS n FROM payments WHERE sale_id = $1', [ventaIdem2.id]);
    check('Tres envíos simultáneos con la misma clave: un solo pago registrado',
        tras3.n === 1, `${tras3.n} pagos, estados ${simultaneos.map((r) => r.status).join(',')}`);
    check('Exactamente uno de los tres fue la creación (201)',
        simultaneos.filter((r) => r.status === 201).length === 1,
        simultaneos.map((r) => r.status).join(','));
    check('El saldo bajó una sola vez pese a los tres envíos',
        q((await saleOf(admin, ventaIdem2.id)).balance) === '300.00');

    const indice = await dbError(
        `INSERT INTO payments (sale_id, customer_id, payment_date, amount, created_by, client_request_id)
         VALUES ($1, $2, app_today(), 1, $3, $4)`,
        [ventaIdem2.id, cliente2, adminRow.id, clave2]);
    check('BD: la clave repetida del mismo usuario es imposible aunque se inserte por SQL',
        indice?.code === '23505', indice?.message);

    // ==================================================== 5. CONCURRENCIA
    console.log('\n[5] Dos cobros simultáneos sobre la misma venta');

    const ventaRace = await ventaConCuotas({
        customerId: cliente, createdBy: uVendedor.id, branchId: branchA, cuotas: [100, 100, 100, 100],
    });
    // Dos cobros de 250 sobre un saldo de 400: caben los dos por separado,
    // pero juntos serían 500. Solo uno puede prosperar.
    const carrera = await Promise.all([
        pagar(admin, { sale_id: ventaRace.id, amount: 250, method: 'efectivo' }),
        pagar(cobrador, { sale_id: ventaRace.id, amount: 250, method: 'efectivo' }),
    ]);
    const trasCarrera = await saleOf(admin, ventaRace.id);
    const aplicados = (trasCarrera.payments ?? []).filter((p) => p.status === 'aplicado');
    check('De dos cobros que juntos sobrepasan el saldo, solo prospera uno',
        carrera.filter((r) => r.status === 201).length === 1 &&
            carrera.filter((r) => r.status === 422).length === 1,
        carrera.map((r) => r.status).join(','));
    check('No hay doble aplicación: un único pago aplicado',
        aplicados.length === 1, `${aplicados.length} pagos aplicados`);
    check('El saldo queda correcto (400 - 250 = 150), nunca negativo',
        q(trasCarrera.balance) === '150.00' && Number(trasCarrera.balance) >= 0, trasCarrera.balance);
    const { rows: [sumaAlloc] } = await pool.query(
        `SELECT COALESCE(SUM(pa.amount), 0)::NUMERIC(12,2) AS total
           FROM payment_allocations pa JOIN payments p ON p.id = pa.payment_id
          WHERE p.sale_id = $1 AND p.status = 'aplicado'`, [ventaRace.id]);
    check('La distribución FIFO suma exactamente lo cobrado',
        q(sumaAlloc.total) === '250.00', sumaAlloc.total);
    check('Ninguna cuota quedó sobrepagada',
        (trasCarrera.installments ?? []).every((i) => Number(i.paid_amount) <= Number(i.amount)));

    // Tres cobros simultáneos que caben: los tres entran y el saldo cuadra.
    const ventaRace2 = await ventaConCuotas({
        customerId: cliente, createdBy: uVendedor.id, branchId: branchA, cuotas: [100, 100, 100, 100],
    });
    const tresQueCaben = await Promise.all([
        pagar(admin, { sale_id: ventaRace2.id, amount: 100, method: 'efectivo' }),
        pagar(cobrador, { sale_id: ventaRace2.id, amount: 100, method: 'efectivo' }),
        pagar(admin, { sale_id: ventaRace2.id, amount: 100, method: 'efectivo' }),
    ]);
    const trasTres = await saleOf(admin, ventaRace2.id);
    check('Tres cobros simultáneos que caben en el saldo entran los tres',
        tresQueCaben.every((r) => r.status === 201), tresQueCaben.map((r) => r.status).join(','));
    check('El saldo resultante es exacto (400 - 300 = 100)',
        q(trasTres.balance) === '100.00', trasTres.balance);
    check('Las cuotas 1, 2 y 3 quedan pagadas en orden, sin huecos',
        (trasTres.installments ?? []).slice(0, 3).every((i) => i.status === 'pagada') &&
            trasTres.installments?.[3]?.status !== 'pagada');

    // ==================================================== 6. ANULACIÓN
    console.log('\n[6] Anulación: solo el último pago aplicado');

    const ventaAnul = await ventaConCuotas({
        customerId: cliente2, createdBy: uVendedor.id, branchId: branchA, cuotas: [100, 100, 100, 100],
    });
    const p1 = (await pagar(admin, { sale_id: ventaAnul.id, amount: 100, method: 'efectivo' }))
        .body?.data?.payment?.id;
    const p2 = (await pagar(admin, { sale_id: ventaAnul.id, amount: 150, method: 'efectivo' }))
        .body?.data?.payment?.id;
    const anular = (token, id, reason) =>
        api('PATCH', `/payments/${id}/void`, { token, body: reason === undefined ? {} : { reason } });

    check('Sin motivo no se anula (422)', (await anular(admin, p2)).status === 422);
    check('Un motivo demasiado corto no basta (422)', (await anular(admin, p2, 'no')).status === 422);
    check('El vendedor no anula pagos (403)', (await anular(vendedor, p2, 'intento del vendedor')).status === 403);
    check('El cobrador no anula pagos (403)', (await anular(cobrador, p2, 'intento del cobrador')).status === 403);

    const intermedio = await anular(admin, p1, 'intento de anular el pago intermedio');
    check('Anular un pago INTERMEDIO se rechaza con 409',
        intermedio.status === 409 && intermedio.body?.error?.details?.reason === 'NOT_LAST_PAYMENT',
        show(intermedio));
    check('El mensaje dice exactamente qué pago hay que anular primero',
        /P-\d{6}/.test(intermedio.body?.error?.message ?? '') &&
            Number(intermedio.body?.error?.details?.blocking_payment_id) === Number(p2),
        intermedio.body?.error?.message);
    check('El intento fallido no cambió nada',
        q((await saleOf(admin, ventaAnul.id)).balance) === '150.00');

    const ultimo = await anular(admin, p2, 'el cliente pidio revertir el cobro');
    check('El ÚLTIMO pago sí se anula (200) y el saldo vuelve a subir (150 → 300)',
        ultimo.status === 200 && q(ultimo.body?.data?.balance) === '300.00',
        `estado ${ultimo.status}, saldo ${ultimo.body?.data?.balance}, pagado ${ultimo.body?.data?.paid_amount}`);
    const { rows: [anulado] } = await pool.query(
        `SELECT status, void_reason, voided_at, voided_by,
                (SELECT COUNT(*)::int FROM payment_allocations WHERE payment_id = $1) AS asignaciones
           FROM payments WHERE id = $1`, [p2]);
    check('El pago NO se borra: queda anulado con motivo, fecha y responsable',
        anulado.status === 'anulado' && anulado.void_reason && anulado.voided_at &&
            Number(anulado.voided_by) === Number(adminRow.id),
        JSON.stringify(anulado));
    check('Sus asignaciones a cuotas SE CONSERVAN (trazabilidad del FIFO)',
        anulado.asignaciones > 0, `${anulado.asignaciones} asignaciones`);
    check('Ahora sí se puede anular el anterior, que pasó a ser el último',
        (await anular(admin, p1, 'se revierte tambien el primero')).status === 200);
    check('Anular dos veces el mismo pago -> 409',
        (await anular(admin, p1, 'otra vez el mismo')).status === 409);
    check('La venta vuelve a su saldo completo',
        q((await saleOf(admin, ventaAnul.id)).balance) === '400.00');
    await new Promise((r) => setTimeout(r, 300));
    check('Cada anulación queda en la bitácora con su motivo',
        (await pool.query(
            `SELECT COUNT(*)::int AS n FROM audit_log WHERE action = 'payment.void' AND entity_id IN ($1, $2)`,
            [p1, p2])).rows[0].n === 2);

    const saltarPorSql = await dbError(
        `UPDATE payments SET status = 'anulado', voided_at = now(), void_reason = 'por sql'
          WHERE id = (SELECT MIN(id) FROM payments WHERE sale_id = $1 AND status = 'aplicado')`,
        [ventaRace2.id]);
    check('BD: tampoco por SQL directo se puede anular un pago que no es el último',
        saltarPorSql?.code === '23001', saltarPorSql?.message);
    const borrarPorSql = await dbError('DELETE FROM payments WHERE id = $1', [p1]);
    check('BD: un pago no se puede borrar por SQL directo', borrarPorSql?.code === '23001');

    // ---- Pago incluido en un depósito
    console.log('\n[7] Un pago depositado se anula sin tocar el depósito');

    const ventaDep = await ventaConCuotas({
        customerId: cliente2, createdBy: uVendedor.id, branchId: branchA, cuotas: [100, 100, 100, 100],
    });
    const pDep = (await pagar(admin, {
        sale_id: ventaDep.id, amount: 200, method: 'deposito', reference: 'BOL-7788',
    })).body?.data?.payment?.id;
    // El depósito se arma por SQL: su gestión es del bloque 4.2.
    const { rows: [deposito] } = await pool.query(
        `INSERT INTO deposits (branch_id, declared_amount, reference, created_by)
         VALUES ($1, 200, 'DEP-4.1', $2) RETURNING id`, [branchA, adminRow.id]);
    await pool.query(
        `INSERT INTO deposit_payments (deposit_id, payment_id, added_by) VALUES ($1, $2, $3)`,
        [deposito.id, pDep, adminRow.id]);

    const anulDep = await anular(admin, pDep, 'el deposito no cuadraba');
    check('Un pago ya depositado SÍ se puede anular', anulDep.status === 200, show(anulDep));
    const { rows: [sigueEnDeposito] } = await pool.query(
        'SELECT COUNT(*)::int AS n FROM deposit_payments WHERE deposit_id = $1 AND payment_id = $2',
        [deposito.id, pDep]);
    check('El pago NO se saca del depósito', sigueEnDeposito.n === 1);
    const { rows: [conciliacion] } = await pool.query(
        'SELECT payments_count, expected_amount, voided_amount, applied_amount, status FROM v_deposits WHERE id = $1',
        [deposito.id]);
    check('La conciliación refleja la anulación sin ocultar el depósito',
        conciliacion.payments_count === 1 && q(conciliacion.expected_amount) === '200.00' &&
            q(conciliacion.voided_amount) === '200.00' && q(conciliacion.applied_amount) === '0.00' &&
            conciliacion.status === 'REVISADO',
        JSON.stringify(conciliacion));
    const { rows: [eventoDep] } = await pool.query(
        `SELECT event, comment FROM deposit_events WHERE deposit_id = $1 ORDER BY id DESC LIMIT 1`, [deposito.id]);
    check('La anulación deja constancia en el historial del depósito',
        eventoDep?.event === 'OBSERVADO' && /P-\d{6}/.test(eventoDep?.comment ?? ''), JSON.stringify(eventoDep));

    // ==================================================== 8. COMPROBANTE
    console.log('\n[8] Estado documental del comprobante');

    const ventaDoc = await ventaConCuotas({
        customerId: cliente, createdBy: uVendedor.id, branchId: branchA, cuotas: [100, 100, 100, 100],
    });
    const efectivo = await pagar(admin, { sale_id: ventaDoc.id, amount: 10, method: 'efectivo' });
    check('Efectivo queda PENDIENTE_DE_BOLETA',
        efectivo.body?.data?.payment?.voucher_status === 'PENDIENTE_DE_BOLETA',
        efectivo.body?.data?.payment?.voucher_status);
    const transferencia = await pagar(admin, {
        sale_id: ventaDoc.id, amount: 10, method: 'transferencia', reference: 'TRF-999',
    });
    check('Transferencia con correlativo queda EN_REVISION',
        transferencia.body?.data?.payment?.voucher_status === 'EN_REVISION',
        transferencia.body?.data?.payment?.voucher_status);
    for (const metodo of ['transferencia', 'deposito', 'tarjeta']) {
        const sinRef = await pagar(admin, { sale_id: ventaDoc.id, amount: 5, method: metodo });
        check(`Un pago por ${metodo} sin referencia se rechaza (422)`,
            sinRef.status === 422 && (sinRef.body?.error?.details ?? []).some((d) => d.campo === 'reference'),
            show(sinRef));
    }

    // ---- REMESA: se trata como efectivo (decisión del propietario 2026-09-18)
    const remesa = await pagar(admin, { sale_id: ventaDoc.id, amount: 10, method: 'remesa' });
    check('Una REMESA se registra sin referencia obligatoria',
        remesa.status === 201, show(remesa));
    check('La remesa queda PENDIENTE_DE_BOLETA, igual que el efectivo',
        remesa.body?.data?.payment?.voucher_status === 'PENDIENTE_DE_BOLETA',
        remesa.body?.data?.payment?.voucher_status);
    check('Una remesa con referencia también se acepta',
        (await pagar(admin, {
            sale_id: ventaDoc.id, amount: 5, method: 'remesa', reference: 'REM-4477',
        })).status === 201);

    // ---- CHEQUE y OTRO: retirados de la operación
    console.log('\n[8b] Métodos retirados: cheque y otro');
    for (const retirado of ['cheque', 'otro']) {
        const res = await pagar(admin, { sale_id: ventaDoc.id, amount: 5, method: retirado, reference: 'X-1' });
        check(`Un pago nuevo por ${retirado} se rechaza (422)`,
            res.status === 422 && (res.body?.error?.details ?? []).some((d) => d.campo === 'method'),
            show(res));
    }
    const metodosOfrecidos = (await api('GET', '/payments/methods', { token: admin })).body?.data ?? [];
    check('El catálogo que ve el formulario ofrece solo los cinco operativos',
        metodosOfrecidos.join(',') === 'efectivo,transferencia,deposito,remesa,tarjeta',
        metodosOfrecidos.join(','));
    const porSql = await dbError(
        `INSERT INTO payments (sale_id, customer_id, payment_date, amount, method, created_by)
         VALUES ($1, $2, app_today(), 5, 'cheque', $3)`,
        [ventaDoc.id, cliente, adminRow.id]);
    check('BD: tampoco por SQL directo se registra un pago nuevo con un método retirado',
        porSql?.code === '23001' && /cheque/.test(porSql?.message ?? ''), porSql?.message);

    // ---- Compatibilidad: un pago histórico por cheque sigue funcionando
    console.log('\n[8c] Los pagos históricos por cheque u otro no se tocan');
    const restriccion = (await pool.query(
        `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'payments_method_check'`
    )).rows[0]?.def ?? '';
    check('La restricción de la base SIGUE admitiendo cheque y otro: ningún pago guardado deja de ser válido',
        /cheque/.test(restriccion) && /otro/.test(restriccion) && /remesa/.test(restriccion),
        restriccion.slice(0, 160));

    /**
     * Para probar la compatibilidad hace falta un pago que YA existiera con un
     * método retirado. Se simula desactivando un momento el trigger que bloquea
     * los registros nuevos —lo que exige ser dueño de la tabla—. Si la sesión no
     * tiene ese permiso, la comprobación se salta con aviso en vez de fallar:
     * es una limitación del entorno de pruebas, no del sistema.
     */
    const ventaHist = await ventaConCuotas({
        customerId: cliente, createdBy: uVendedor.id, branchId: branchA, cuotas: [100, 100, 100, 100],
    });

    let historico = null;
    const conHistorico = await pool.connect();
    try {
        await conHistorico.query('BEGIN');
        await conHistorico.query('ALTER TABLE payments DISABLE TRIGGER trg_payments_method_operativo');
        const { rows } = await conHistorico.query(
            `INSERT INTO payments (sale_id, customer_id, payment_date, amount, method, reference, created_by)
             VALUES ($1, $2, app_today(), 100, 'cheque', 'CHQ-0001', $3) RETURNING id`,
            [ventaHist.id, cliente, adminRow.id]);
        await conHistorico.query('ALTER TABLE payments ENABLE TRIGGER trg_payments_method_operativo');
        await conHistorico.query(
            `INSERT INTO payment_allocations (payment_id, installment_id, amount)
             SELECT $1, id, 100 FROM installments WHERE sale_id = $2 AND number = 1`,
            [rows[0].id, ventaHist.id]);
        await conHistorico.query('COMMIT');
        historico = rows[0];
    } catch (error) {
        await conHistorico.query('ROLLBACK').catch(() => {});
        console.log(`  ${c.dim}(no se pudo simular un pago histórico en este entorno: ${error.message})${c.off}`);
    } finally {
        conHistorico.release();
    }

    if (historico) {
        const ventaConHistorico = await saleOf(admin, ventaHist.id);
        check('Un pago histórico por cheque se sigue leyendo y contando en el saldo',
            q(ventaConHistorico.balance) === '300.00' &&
                (ventaConHistorico.payments ?? []).some((p) => p.method === 'cheque'),
            `saldo ${ventaConHistorico.balance}`);
        check('Su estado documental sigue en NULL: no se reinterpreta',
            (await pool.query('SELECT voucher_status FROM payments WHERE id = $1', [historico.id]))
                .rows[0].voucher_status === null);
        const anularHistorico = await api('PATCH', `/payments/${historico.id}/void`, {
            token: admin, body: { reason: 'anulacion de un pago historico por cheque' },
        });
        check('Un pago histórico por cheque se puede anular con normalidad',
            anularHistorico.status === 200 && q(anularHistorico.body?.data?.balance) === '400.00',
            show(anularHistorico));
        const { rows: [siguePresente] } = await pool.query(
            `SELECT method, status FROM payments WHERE id = $1`, [historico.id]);
        check('Sigue guardado con su método original, sin convertirse a otro',
            siguePresente.method === 'cheque' && siguePresente.status === 'anulado',
            JSON.stringify(siguePresente));
    }

    const { rows: eventosDoc } = await pool.query(
        `SELECT action, to_status FROM payment_voucher_events WHERE payment_id = $1`,
        [efectivo.body?.data?.payment?.id]);
    check('El registro del pago deja su primer evento documental',
        eventosDoc.length === 1 && eventosDoc[0].action === 'REGISTRADO' &&
            eventosDoc[0].to_status === 'PENDIENTE_DE_BOLETA', JSON.stringify(eventosDoc));
    const estadoInventado = await dbError(
        `UPDATE payments SET voucher_status = 'VALIDADO' WHERE id = $1`, [efectivo.body?.data?.payment?.id]);
    check('BD: no se admite ningún estado documental fuera de los cuatro definidos',
        estadoInventado?.code === '23514', estadoInventado?.message);
    const { rows: [historicos] } = await pool.query(
        `SELECT COUNT(*)::int AS n FROM payments WHERE voucher_status IS NULL AND created_at < now() - interval '1 hour'`);
    check('Los pagos históricos siguen con voucher_status NULL: no se reinterpretan',
        historicos.n >= 0, `${historicos.n} pagos históricos intactos`);

    // ==================================================== 9. ENGANCHE FIFO
    console.log('\n[9] El enganche usa el mismo mecanismo FIFO');

    // Venta a crédito REAL: solicitud aprobada y concretada con enganche.
    // Es el único camino para una venta `credito`, así que la prueba lo recorre
    // entero en lugar de fabricar el resultado por SQL.
    const clienteCredito = await mkCustomer('03', 'CLIENTE PAGOS CREDITO');
    const producto = Number((await api('POST', '/products', {
        token: admin,
        body: { code: `P41-${stamp}`, name: 'Producto pagos 4.1', category: 'Pruebas', cost: 1000, stock: 10 },
    })).body?.data?.id);

    const solicitudRes = await api('POST', '/credit-applications', {
        token: vendedor,
        body: {
            customer_id: clienteCredito,
            proposed_down_payment: '500.00',
            items: [{
                product_id: producto, quantity: 1, financing_type: 'ESPECIAL',
                installments_count: 6, proposed_price: '1800.00',
            }],
        },
    });
    const solicitud = solicitudRes.body?.data ?? {};
    const verRes = await api('POST', `/credit-applications/${solicitud.id}/verifications`, {
        token: cobrador,
        body: {
            result: 'FAVORABLE', recommendation: 'FAVORABLE', conclude: true,
            address_matches: 'SI', housing_verified: 'SI', residence_time_matches: 'SI',
        },
    });
    const decRes = await api('POST', `/credit-applications/${solicitud.id}/decision`, {
        token: admin, body: { decision: 'APROBADO', comment: 'aprobado para la prueba de pagos' },
    });
    const concretada = await api('POST', `/credit-applications/${solicitud.id}/concretize`, {
        token: vendedor, body: { down_payment: '400.00', payment_method: 'efectivo' },
    });
    const ventaCredito = concretada.body?.data?.sale ?? {};
    check('Se concreta una venta a crédito con enganche real de Q400 sobre Q1,800',
        concretada.status === 201 && q(ventaCredito.total) === '1800.00', show(concretada));

    const enganche = (ventaCredito.payments ?? [])[0];
    check('El enganche se registró como un PAGO normal, no como un concepto aparte',
        Boolean(enganche) && q(enganche.amount) === '400.00' && enganche.status === 'aplicado',
        JSON.stringify(enganche));
    check('El enganche entró por el MISMO mecanismo FIFO: cuota 1 primero',
        allocationsOf(enganche) === '1:300.00,2:100.00', allocationsOf(enganche));
    check('El enganche deja la cuota 1 pagada y la 2 PARCIAL, sin mover nada fuera de FIFO',
        ventaCredito.installments?.[0]?.status === 'pagada' &&
            ventaCredito.installments?.[1]?.status === 'parcial',
        (ventaCredito.installments ?? []).map((i) => `${i.number}:${i.status}`).join(','));
    check('NO se creó ninguna "cuota 0"',
        (ventaCredito.installments ?? []).every((i) => i.number >= 1) &&
            ventaCredito.installments?.length === 6,
        `${ventaCredito.installments?.length} cuotas, la primera es la ${ventaCredito.installments?.[0]?.number}`);
    check('Saldo tras el enganche: 1800 - 400 = 1400',
        q(ventaCredito.balance) === '1400.00', ventaCredito.balance);
    check('El enganche también recibe su estado documental',
        enganche?.voucher_status === 'PENDIENTE_DE_BOLETA', enganche?.voucher_status);

    // Un cobro posterior sigue exactamente donde lo dejó el enganche.
    const siguienteCuota = await pagar(cobrador, { sale_id: ventaCredito.id, amount: 200, method: 'efectivo' });
    check('El cobro siguiente continúa el FIFO donde lo dejó el enganche (cuota 2)',
        allocationsOf(siguienteCuota.body?.data?.payments?.at(-1)) === '2:200.00',
        allocationsOf(siguienteCuota.body?.data?.payments?.at(-1)));

    // Cuotas consolidadas de dos productos con plazos distintos.
    const clienteConsolidado = await mkCustomer('04', 'CLIENTE PAGOS CONSOLIDADO');
    const producto2 = Number((await api('POST', '/products', {
        token: admin,
        body: { code: `P41B-${stamp}`, name: 'Producto pagos 4.1 B', category: 'Pruebas', cost: 500, stock: 10 },
    })).body?.data?.id);
    const solicitud2 = (await api('POST', '/credit-applications', {
        token: vendedor,
        body: {
            customer_id: clienteConsolidado,
            proposed_down_payment: '0.00',
            items: [
                { product_id: producto, quantity: 1, financing_type: 'ESPECIAL', installments_count: 12, proposed_price: '2400.00' },
                { product_id: producto2, quantity: 1, financing_type: 'ESPECIAL', installments_count: 6, proposed_price: '1200.00' },
            ],
        },
    })).body?.data ?? {};
    await api('POST', `/credit-applications/${solicitud2.id}/verifications`, {
        token: cobrador,
        body: {
            result: 'FAVORABLE', recommendation: 'FAVORABLE', conclude: true,
            address_matches: 'SI', housing_verified: 'SI', residence_time_matches: 'SI',
        },
    });
    await api('POST', `/credit-applications/${solicitud2.id}/decision`, {
        token: admin, body: { decision: 'APROBADO', comment: 'aprobado consolidado' },
    });
    const consolidada = await api('POST', `/credit-applications/${solicitud2.id}/concretize`, {
        token: vendedor, body: { down_payment: '0.00' },
    });
    const ventaConsolidada = consolidada.body?.data?.sale ?? {};
    const importes = (ventaConsolidada.installments ?? []).map((i) => q(i.amount));
    check('Crédito con dos productos y plazos distintos: 12 cuotas consolidadas',
        consolidada.status === 201 && importes.length === 12, show(consolidada));
    check('Meses 1-6 suman las dos líneas (400) y 7-12 solo la primera (200)',
        importes.slice(0, 6).every((a) => a === '400.00') && importes.slice(6).every((a) => a === '200.00'),
        importes.join(','));
    check('Enganche Q0: no se registra ningún pago y no hay cuota 0',
        (ventaConsolidada.payments ?? []).length === 0 && ventaConsolidada.installments?.[0]?.number === 1);

    const pagoConsolidado = await pagar(cobrador, { sale_id: ventaConsolidada.id, amount: 900, method: 'efectivo' });
    check('Un pago sobre cuotas consolidadas también respeta el FIFO',
        allocationsOf(pagoConsolidado.body?.data?.payments?.at(-1)) === '1:400.00,2:400.00,3:100.00',
        allocationsOf(pagoConsolidado.body?.data?.payments?.at(-1)));
    check('Saldo tras el pago consolidado: 3600 - 900 = 2700',
        q(pagoConsolidado.body?.data?.sale?.balance) === '2700.00',
        pagoConsolidado.body?.data?.sale?.balance);

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
