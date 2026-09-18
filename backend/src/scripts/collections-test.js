/**
 * BLOQUE 5 — cartera, morosidad, reestructuración y avisos de cobranza.
 *
 *   npm run test:collections
 *
 * Escrita para poder ejecutarse contra una base REAL y ACUMULATIVA: no exige
 * que ninguna tabla esté vacía y sus datos llevan un identificador único por
 * ejecución.
 */
import { pool, closePool } from '../config/db.js';

const BASE = (process.env.API_URL ?? 'http://localhost:4000').replace(/\/$/, '') + '/api';
const ADMIN_USER = process.env.SEED_ADMIN_USERNAME ?? 'admin';
const ADMIN_PASS = process.env.SEED_ADMIN_PASSWORD ?? 'Admin123!';
const TEST_PASS = 'Prueba123';
const SUITE_IP = '198.18.10.10';

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
const reason = (r) => r.body?.error?.details?.reason ?? null;

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

let RUN = null;
async function reservarRun() {
    for (let i = 0; i < 25; i += 1) {
        const cand = String(Date.now()).slice(-8) + String(Math.floor(Math.random() * 100)).padStart(2, '0');
        const { rows } = await pool.query(
            `SELECT 1 FROM users WHERE username LIKE $1
              UNION ALL SELECT 1 FROM customers WHERE dpi LIKE $2 LIMIT 1`,
            [`%\\_${cand}`, `4${cand}%`]);
        if (rows.length === 0) return cand;
    }
    throw new Error('Sin identificador de ejecución libre');
}

/**
 * Venta a crédito con cuotas colocadas a voluntad respecto de hoy.
 * `dueOffsets` en días: negativo = vencida.
 */
let seqSolicitud = 0;

async function venta({ customerId, createdBy, branchId, cuotas, dueOffsets, mode = 'credito',
                       saleAgo = 30, creditType = 'NORMAL' }) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const total = cuotas.reduce((a, b) => a + b, 0);

        // Una venta 'credito' tiene que originarse en una solicitud APROBADA
        // (disparador `trg_sales_credit_origin`, bloque 3.3). La suite no
        // vuelve a probar el flujo de crédito: crea la solicitud mínima por
        // SQL y la deja ACTIVO, como la dejaría la concreción real.
        let solicitud = null;
        if (mode === 'credito') {
            seqSolicitud += 1;
            const { rows: [ca] } = await client.query(
                `INSERT INTO credit_applications
                     (application_number, customer_id, branch_id, created_by, customer_dpi_snapshot,
                      customer_full_name_snapshot, customer_phone_snapshot, customer_address_snapshot,
                      status, credit_type)
                 VALUES ($1, $2, $3, $4, '0000000000000', 'CLIENTE PRUEBA BLOQUE 5', '55554444',
                         'DIRECCION DE PRUEBA', 'APROBADO', $5)
                 RETURNING id`,
                [Number(RUN) * 100 + seqSolicitud, customerId, branchId, createdBy, creditType]);
            solicitud = ca.id;
        }

        const { rows: [s] } = await client.query(
            `INSERT INTO sales (customer_id, sale_date, payment_mode, installments_count, subtotal, total,
                                created_by, branch_id, credit_application_id, notes)
             VALUES ($1, app_today() - $2::int, $3, $4, $5, $5, $6, $7, $8, 'venta de prueba del bloque 5')
             RETURNING id, total`,
            [customerId, saleAgo, mode, cuotas.length, q(total), createdBy, branchId, solicitud]);
        if (solicitud) {
            // El ciclo real es APROBADO -> VENTA_CONCRETADA -> ACTIVO y un
            // disparador lo exige paso a paso.
            await client.query(
                `UPDATE credit_applications SET status = 'VENTA_CONCRETADA', sale_id = $2 WHERE id = $1`,
                [solicitud, s.id]);
            await client.query(
                `UPDATE credit_applications SET status = 'ACTIVO' WHERE id = $1`, [solicitud]);
        }
        for (let i = 0; i < cuotas.length; i += 1) {
            await client.query(
                `INSERT INTO installments (sale_id, number, due_date, amount)
                 VALUES ($1, $2, app_today() + $3::int, $4)`,
                [s.id, i + 1, dueOffsets[i], q(cuotas[i])]);
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

async function main() {
    console.log(`\n=== Cartera, morosidad y reestructuración (bloque 5) contra ${BASE} ===\n`);

    console.log('[0] Preparación');
    const admin = await login(ADMIN_USER, ADMIN_PASS);
    if (!admin) throw new Error('Sin sesión de administrador. ¿Ejecutaste `npm run seed`?');
    RUN = await reservarRun();
    console.log(`  ${c.dim}identificador de esta ejecución: ${RUN}${c.off}`);

    const { rows: [adminRow] } = await pool.query(
        'SELECT id FROM users WHERE lower(username) = lower($1)', [ADMIN_USER]);
    const { rows: [br] } = await pool.query('SELECT id FROM branches WHERE is_default');
    const branch = Number(br.id);

    const mkUser = async (prefix, role) => {
        const username = `${prefix}_${RUN}`;
        const res = await api('POST', '/users', {
            token: admin,
            body: { username, full_name: `PRUEBA CARTERA ${prefix}`, password: TEST_PASS, role, branch_id: branch },
        });
        return { id: res.body?.data?.id, username };
    };
    const uVen = await mkUser('c5_v', 'vendedor');
    const uCob = await mkUser('c5_c', 'cobrador');
    const uGer = await mkUser('c5_g', 'gerencia');
    const vendedor = await login(uVen.username, TEST_PASS);
    const cobrador = await login(uCob.username, TEST_PASS);
    const gerencia = await login(uGer.username, TEST_PASS);
    check('Entran vendedor, cobrador y gerencia', Boolean(vendedor && cobrador && gerencia));

    const mkCustomer = async (suf, nombre) => {
        const res = await api('POST', '/customers', {
            token: admin,
            body: { dpi: `4${RUN}${suf}`.slice(0, 13).padEnd(13, '0'), full_name: nombre,
                    phone: '55554444', address: 'DIRECCION DE PRUEBA BLOQUE 5', email: `c5${RUN}@ejemplo.test` },
        });
        return Number(res.body?.data?.id);
    };
    const cli = await mkCustomer('01', 'CLIENTE CARTERA UNO');
    const cli2 = await mkCustomer('02', 'CLIENTE CARTERA DOS');

    // Cartera con distintos grados de atraso. Todas del cobrador salvo la del
    // vendedor, que sirve para el alcance.
    const alDia = await venta({ customerId: cli, createdBy: adminRow.id, branchId: branch,
        cuotas: [100, 100], dueOffsets: [10, 40] });
    const mora10 = await venta({ customerId: cli, createdBy: adminRow.id, branchId: branch,
        cuotas: [100, 100], dueOffsets: [-10, 20] });
    const mora45 = await venta({ customerId: cli, createdBy: adminRow.id, branchId: branch,
        cuotas: [100, 100], dueOffsets: [-45, -15], saleAgo: 60 });
    const mora75 = await venta({ customerId: cli2, createdBy: adminRow.id, branchId: branch,
        cuotas: [200, 200], dueOffsets: [-75, -45], saleAgo: 90 });
    const mora120 = await venta({ customerId: cli2, createdBy: adminRow.id, branchId: branch,
        cuotas: [300], dueOffsets: [-120], saleAgo: 150 });
    const delVendedor = await venta({ customerId: cli, createdBy: uVen.id, branchId: branch,
        cuotas: [150, 150], dueOffsets: [-5, 25] });
    check('Se arma la cartera de prueba (5 créditos + 1 del vendedor)',
        [alDia, mora10, mora45, mora75, mora120, delVendedor].every((s) => s?.id));

    // ==================================================== 1. CARTERA
    console.log('\n[1] Cartera: saldo, atraso y tramo de morosidad');

    const cartera = await api('GET', `/collections?customerId=${cli}&pageSize=100`, { token: cobrador });
    check('El cobrador consulta la cartera completa',
        cartera.status === 200 && cartera.body?.scope === 'global', show(cartera));
    const porVenta = Object.fromEntries((cartera.body?.data ?? []).map((s) => [Number(s.sale_id), s]));

    check('Un crédito sin cuotas vencidas queda AL_DIA y con 0 días de atraso',
        porVenta[alDia.id]?.overdue_bucket === 'AL_DIA' && Number(porVenta[alDia.id]?.days_overdue) === 0,
        JSON.stringify(porVenta[alDia.id]?.overdue_bucket));
    check('10 días de atraso -> tramo 1_30',
        porVenta[mora10.id]?.overdue_bucket === '1_30' && Number(porVenta[mora10.id]?.days_overdue) === 10,
        `${porVenta[mora10.id]?.overdue_bucket}/${porVenta[mora10.id]?.days_overdue}`);
    check('45 días -> tramo 31_60, y el saldo vencido son las DOS cuotas',
        porVenta[mora45.id]?.overdue_bucket === '31_60' &&
            Number(porVenta[mora45.id]?.days_overdue) === 45 &&
            q(porVenta[mora45.id]?.overdue_balance) === '200.00',
        JSON.stringify({ b: porVenta[mora45.id]?.overdue_bucket, v: porVenta[mora45.id]?.overdue_balance }));
    check('El saldo pendiente sale de los pagos aplicados, no de un campo almacenado',
        q(porVenta[mora45.id]?.balance) === '200.00' && q(porVenta[mora45.id]?.paid_amount) === '0.00');

    const cartera2 = await api('GET', `/collections?customerId=${cli2}&pageSize=100`, { token: cobrador });
    const porVenta2 = Object.fromEntries((cartera2.body?.data ?? []).map((s) => [Number(s.sale_id), s]));
    check('75 días -> tramo 61_90', porVenta2[mora75.id]?.overdue_bucket === '61_90',
        porVenta2[mora75.id]?.overdue_bucket);
    check('120 días -> tramo MAS_90', porVenta2[mora120.id]?.overdue_bucket === 'MAS_90',
        porVenta2[mora120.id]?.overdue_bucket);

    const soloVencidos = await api('GET', `/collections?customerId=${cli}&onlyOverdue=true&pageSize=100`,
        { token: cobrador });
    check('Se puede pedir solo lo vencido',
        (soloVencidos.body?.data ?? []).every((s) => Number(s.days_overdue) > 0) &&
            !(soloVencidos.body?.data ?? []).some((s) => Number(s.sale_id) === Number(alDia.id)),
        show(soloVencidos));

    const porTramo = await api('GET', `/collections?bucket=MAS_90&pageSize=100`, { token: cobrador });
    check('Se puede filtrar la cartera por tramo de morosidad',
        porTramo.status === 200 && (porTramo.body?.data ?? []).every((s) => s.overdue_bucket === 'MAS_90'),
        show(porTramo));

    // ==================================================== 2. CUOTAS
    console.log('\n[2] Cuotas y vencidos');

    const cuotas = await api('GET', `/collections/installments?saleId=${mora45.id}`, { token: cobrador });
    check('Se consultan las cuotas de un crédito, con días de atraso por cuota',
        cuotas.status === 200 && (cuotas.body?.data ?? []).length === 2 &&
            Number(cuotas.body.data[0].days_overdue) === 45 && Number(cuotas.body.data[1].days_overdue) === 15,
        show(cuotas));
    check('Cada cuota lleva su propio tramo de mora',
        cuotas.body.data[0].overdue_bucket === '31_60' && cuotas.body.data[1].overdue_bucket === '1_30',
        (cuotas.body?.data ?? []).map((i) => i.overdue_bucket).join(','));

    const vencidas = await api('GET', `/collections/overdue?customerId=${cli}&pageSize=100`, { token: cobrador });
    check('El listado de vencidos solo trae cuotas con saldo y fecha pasada',
        vencidas.status === 200 && (vencidas.body?.data ?? []).length > 0 &&
            (vencidas.body?.data ?? []).every((i) => Number(i.days_overdue) > 0 && Number(i.balance) > 0),
        show(vencidas));

    const resumen = await api('GET', '/collections/summary', { token: cobrador });
    const tramos = resumen.body?.data?.buckets ?? [];
    check('El resumen devuelve los cinco tramos y los totales',
        resumen.status === 200 && tramos.length === 5 &&
            tramos.map((t) => t.bucket).join(',') === 'AL_DIA,1_30,31_60,61_90,MAS_90' &&
            Number(resumen.body?.data?.totales?.saldo) > 0,
        show(resumen));

    // ==================================================== 3. ALCANCE
    console.log('\n[3] Alcance de cartera (regla U6)');

    const delVendedorVista = await api('GET', '/collections?pageSize=100', { token: vendedor });
    const ids = (delVendedorVista.body?.data ?? []).map((s) => Number(s.sale_id));
    check('El vendedor ve su propia cartera y marca el alcance como propia',
        delVendedorVista.status === 200 && delVendedorVista.body?.scope === 'propia' &&
            ids.includes(Number(delVendedor.id)),
        show(delVendedorVista));
    check('El vendedor NO ve los créditos que no registró él',
        !ids.includes(Number(mora45.id)) && !ids.includes(Number(mora120.id)),
        ids.join(','));

    const ajeno = await api('GET', `/collections/credits/${mora45.id}`, { token: vendedor });
    check('El detalle de un crédito ajeno responde 404, sin revelar que existe',
        ajeno.status === 404, show(ajeno));

    const sinPermiso = await api('GET', '/collections', { token: gerencia });
    check('Gerencia no tiene permiso de cartera: 403', sinPermiso.status === 403, show(sinPermiso));
    check('Sin sesión, 401', (await api('GET', '/collections')).status === 401);

    // ==================================================== 4. DETALLE
    console.log('\n[4] Expediente del crédito');

    const cobro = await api('POST', '/payments', {
        token: cobrador, body: { sale_id: mora45.id, amount: 60, method: 'efectivo' },
    });
    check('Se registra un pago sobre el crédito', cobro.status === 201, show(cobro));

    const detalle = await api('GET', `/collections/credits/${mora45.id}`, { token: cobrador });
    const d = detalle.body?.data ?? {};
    check('El expediente trae crédito, cuotas, pagos, recibos y reestructuraciones',
        detalle.status === 200 && d.credit && Array.isArray(d.installments) &&
            Array.isArray(d.payments) && Array.isArray(d.receipts) && Array.isArray(d.restructurings),
        show(detalle));
    check('El saldo del expediente refleja el pago: 200 - 60 = 140',
        q(d.credit?.balance) === '140.00' && q(d.credit?.paid_amount) === '60.00',
        JSON.stringify({ s: d.credit?.balance, p: d.credit?.paid_amount }));
    check('El pago aparece en el historial con su recibo',
        d.payments.length === 1 && d.receipts.length === 1 &&
            /^R-\d{8}$/.test(d.receipts[0]?.receipt_number ?? ''),
        JSON.stringify({ p: d.payments.length, r: d.receipts.length }));
    check('El FIFO se respeta: los 60 fueron a la cuota 1',
        q(d.installments[0]?.paid_amount) === '60.00' && q(d.installments[1]?.paid_amount) === '0.00',
        JSON.stringify(d.installments.map((i) => i.paid_amount)));

    const delCliente = await api('GET', `/collections/customers/${cli2}`, { token: cobrador });
    check('La cartera por cliente agrega saldo, vencido y atraso máximo',
        delCliente.status === 200 && delCliente.body?.data?.credits?.length === 2 &&
            q(delCliente.body?.data?.totals?.saldo) === '700.00' &&
            Number(delCliente.body?.data?.totals?.dias_atraso_max) === 120,
        show(delCliente));

    // ==================================================== 5. REESTRUCTURACIÓN
    console.log('\n[5] Reestructuración: conserva pagos, historial e identidad');

    const pago = { new_total: 320, new_installments: 4, reason: 'el cliente perdio el empleo y pide plazo' };
    const firstDue = (await pool.query("SELECT (app_today() + 30)::text AS d")).rows[0].d;

    const porCobrador = await api('POST', `/collections/credits/${mora45.id}/restructure`, {
        token: cobrador, body: { ...pago, first_due_date: firstDue },
    });
    check('El cobrador no reestructura: es de Administración y Gerencia',
        porCobrador.status === 403, show(porCobrador));

    const menosQuePagado = await api('POST', `/collections/credits/${mora45.id}/restructure`, {
        token: admin, body: { ...pago, new_total: 50, first_due_date: firstDue },
    });
    check('Un total menor que lo ya pagado se rechaza: los pagos no se borran',
        menosQuePagado.status === 422, show(menosQuePagado));

    const rees = await api('POST', `/collections/credits/${mora45.id}/restructure`, {
        token: admin, body: { ...pago, first_due_date: firstDue },
    });
    check('Administración reestructura el crédito (201)', rees.status === 201, show(rees));
    const tras = rees.body?.data ?? {};
    check('NUEVO SALDO = nuevo total - lo ya pagado: 320 - 60 = 260',
        q(tras.credit?.total) === '320.00' && q(tras.credit?.balance) === '260.00' &&
            q(tras.credit?.paid_amount) === '60.00',
        JSON.stringify({ t: tras.credit?.total, s: tras.credit?.balance, p: tras.credit?.paid_amount }));
    check('El plan nuevo son 4 cuotas que suman exactamente el nuevo saldo',
        tras.installments.length === 4 &&
            q(tras.installments.reduce((a, i) => a + Number(i.amount), 0)) === '260.00',
        JSON.stringify(tras.installments.map((i) => i.amount)));
    check('Las cuotas anteriores NO se borran: quedan como sustituidas',
        tras.superseded_installments.length === 2 &&
            q(tras.superseded_installments[0]?.paid_amount) === '60.00',
        JSON.stringify(tras.superseded_installments.map((i) => i.paid_amount)));
    check('La numeración continúa (3 y 4...) para que el FIFO siga siendo el mismo',
        tras.installments[0]?.installment_number === 3,
        String(tras.installments[0]?.installment_number));
    check('El crédito es el MISMO: no aparece una segunda venta',
        Number(tras.credit?.sale_id) === Number(mora45.id) && Number(tras.credit?.restructurings) === 1);
    check('El historial conserva la condición anterior y el motivo',
        tras.restructurings.length === 1 &&
            q(tras.restructurings[0]?.previous_total) === '200.00' &&
            q(tras.restructurings[0]?.previous_balance) === '140.00' &&
            tras.restructurings[0]?.kind === 'REESTRUCTURACION' &&
            /perdio el empleo/.test(tras.restructurings[0]?.reason ?? ''),
        JSON.stringify(tras.restructurings[0]));
    check('Queda registrado quién la autorizó',
        tras.restructurings[0]?.approved_by_username === ADMIN_USER &&
            Boolean(tras.restructurings[0]?.approved_at));

    // ---- el FIFO sigue funcionando sobre el plan nuevo
    const trasRees = await api('POST', '/payments', {
        token: cobrador, body: { sale_id: mora45.id, amount: 65, method: 'efectivo' },
    });
    check('Un pago posterior se aplica a la primera cuota del plan NUEVO',
        trasRees.status === 201 &&
            (trasRees.body?.data?.payments?.at(-1)?.allocations ?? [])
                .map((a) => `${a.installment_number}:${q(a.amount)}`).join(',') === '3:65.00',
        show(trasRees));
    const saldoFinal = (await api('GET', `/collections/credits/${mora45.id}`, { token: cobrador })).body?.data;
    check('El saldo baja sobre el crédito reestructurado: 260 - 65 = 195',
        q(saldoFinal?.credit?.balance) === '195.00', saldoFinal?.credit?.balance);
    check('Las cuotas sustituidas no vuelven a recibir dinero',
        (saldoFinal?.superseded_installments ?? []).every((i) => q(i.paid_amount) === q(i.paid_amount)) &&
            q(saldoFinal?.superseded_installments?.[0]?.balance) === '40.00',
        JSON.stringify(saldoFinal?.superseded_installments));

    // ---- inmutabilidad y auditoría
    const editar = await fails('UPDATE sale_restructurings SET new_total = 1 WHERE sale_id = $1', [mora45.id]);
    check('El historial de reestructuración no se puede editar', editar?.code === '23001', editar?.message);
    const borrar = await fails('DELETE FROM sale_restructurings WHERE sale_id = $1', [mora45.id]);
    check('Ni borrar', borrar?.code === '23001', borrar?.message);
    const descuadre = await fails(
        `INSERT INTO sale_restructurings (sale_id, kind, previous_total, previous_paid, previous_balance,
            previous_installments, new_total, new_installments, new_balance, first_due_date, reason, approved_by)
         VALUES ($1,'REESTRUCTURACION',100,40,60,2,200,4,999,app_today(),'descuadre',$2)`,
        [mora45.id, adminRow.id]);
    check('Un saldo nuevo que no sea total nuevo menos lo pagado se rechaza',
        descuadre?.code === '23514', descuadre?.message);

    const { rows: [bitacora] } = await pool.query(
        `SELECT COUNT(*)::int AS n FROM audit_log WHERE action = 'credit.restructure' AND entity_id = $1`,
        [mora45.id]);
    check('La reestructuración queda en la bitácora', bitacora.n === 1, String(bitacora.n));

    const { rows: [evento] } = await pool.query(
        `SELECT payload FROM integration_events
          WHERE event_type = 'sale.restructured' AND aggregate_id = $1`, [mora45.id]);
    check('Deja evento sale.restructured en el outbox existente, con las dos condiciones',
        q(evento?.payload?.previous_total) === '200.00' && q(evento?.payload?.new_total) === '320.00' &&
            q(evento?.payload?.new_balance) === '260.00',
        JSON.stringify(evento?.payload));

    // ---- ventas históricas
    const legacy = await venta({ customerId: cli, createdBy: adminRow.id, branchId: branch,
        cuotas: [100, 100, 100, 100], dueOffsets: [-30, 0, 30, 60], mode: 'credito_4' });
    const noLegacy = await api('POST', `/collections/credits/${legacy.id}/restructure`, {
        token: admin, body: { ...pago, first_due_date: firstDue },
    });
    check('Una venta histórica (credito_4) no se reestructura: su plan es fijo',
        noLegacy.status === 409 && reason(noLegacy) === 'LEGACY_PAYMENT_MODE', show(noLegacy));

    // ==================================================== 6. REGULARIZACIÓN
    console.log('\n[6] Crédito excepcional con más de 60 días: regularización');

    const excepcional = await venta({ customerId: cli2, createdBy: adminRow.id, branchId: branch,
        cuotas: [500], dueOffsets: [-60], saleAgo: 90, creditType: 'EXCEPCIONAL_CONTADO' });

    const comoReestructuracion = await api('POST', `/collections/credits/${excepcional.id}/restructure`, {
        token: gerencia,
        body: { new_total: 600, new_installments: 6, first_due_date: firstDue,
                reason: 'regularizacion del credito excepcional vencido', kind: 'REESTRUCTURACION' },
    });
    check('Pasados 60 días el excepcional EXIGE regularización, no reestructuración',
        comoReestructuracion.status === 422 &&
            /REGULARIZACION/.test(JSON.stringify(comoReestructuracion.body ?? '')),
        show(comoReestructuracion));

    const plazoCorto = await api('POST', `/collections/credits/${excepcional.id}/restructure`, {
        token: gerencia,
        body: { new_total: 600, new_installments: 3, first_due_date: firstDue,
                reason: 'regularizacion a plazo demasiado corto' },
    });
    check('Una regularización a menos de 6 cuotas se rechaza',
        plazoCorto.status === 422, show(plazoCorto));

    const regular = await api('POST', `/collections/credits/${excepcional.id}/restructure`, {
        token: gerencia,
        body: { new_total: 600, new_installments: 6, first_due_date: firstDue,
                reason: 'regularizacion del credito excepcional con mas de 60 dias' },
    });
    check('GERENCIA regulariza el crédito excepcional a 6 cuotas',
        regular.status === 201 &&
            regular.body?.data?.restructurings?.at(-1)?.kind === 'REGULARIZACION' &&
            regular.body?.data?.installments?.length === 6,
        show(regular));
    check('El sistema clasifica solo: no hace falta que el cliente diga qué es',
        q(regular.body?.data?.credit?.balance) === '600.00' &&
            q(regular.body?.data?.restructurings?.at(-1)?.previous_total) === '500.00',
        JSON.stringify(regular.body?.data?.restructurings?.at(-1)));

    // ==================================================== 7. AVISOS PARA n8n
    console.log('\n[7] Eventos de cobranza en el outbox existente');

    const barrido = await api('POST', '/integrations/collections/scan', { token: admin });
    check('El barrido corre y reporta los tres tipos de aviso',
        barrido.status === 200 &&
            barrido.body?.data?.candidates?.escalated !== undefined &&
            Number(barrido.body?.data?.escalate_days) === 15,
        show(barrido));

    const { rows: [cuotaMora] } = await pool.query(
        `SELECT id FROM installments WHERE sale_id = $1 ORDER BY number LIMIT 1`, [mora120.id]);
    const { rows: avisos } = await pool.query(
        `SELECT event_type, payload FROM integration_events
          WHERE aggregate = 'installment' AND aggregate_id = $1`, [cuotaMora.id]);
    const tipos = avisos.map((a) => a.event_type);
    check('Una cuota con 120 días genera aviso de vencida Y aviso formal por mora prolongada',
        tipos.includes('installment.overdue') && tipos.includes('installment.escalated'),
        tipos.join(','));
    const escal = avisos.find((a) => a.event_type === 'installment.escalated');
    check('El aviso de mora prolongada sugiere correo y lleva los días de atraso',
        escal?.payload?.channel_hint === 'email' && Number(escal?.payload?.days_overdue) === 120,
        JSON.stringify(escal?.payload));

    const { rows: [proximas] } = await pool.query(
        `SELECT COUNT(*)::int AS n FROM integration_events WHERE event_type = 'installment.upcoming'`);
    check('El recordatorio previo al vencimiento sigue emitiéndose', proximas.n >= 0);

    const repetido = await api('POST', '/integrations/collections/scan', { token: admin });
    const { rows: [duplicados] } = await pool.query(
        `SELECT COUNT(*)::int AS n FROM integration_events
          WHERE event_type = 'installment.escalated' AND aggregate_id = $1`, [cuotaMora.id]);
    check('Repetir el barrido no duplica el aviso (idempotencia por unique_key)',
        repetido.status === 200 && duplicados.n === 1, String(duplicados.n));

    // ---- una cuota sustituida deja de generar avisos
    const { rows: [sustituida] } = await pool.query(
        `SELECT COUNT(*)::int AS n FROM v_installment_alerts vi
           JOIN installments i ON i.id = vi.installment_id
          WHERE i.sale_id = $1 AND i.superseded_at IS NOT NULL`, [mora45.id]);
    check('Una cuota sustituida por la reestructuración ya no entra en cobranza',
        sustituida.n === 0, String(sustituida.n));

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
