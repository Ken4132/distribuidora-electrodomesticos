/**
 * BLOQUE 4.2 — depósitos y conciliación.
 *
 *   npm run test:deposits
 *
 * Prueba el flujo por la API y, donde la regla es crítica, la comprueba
 * ADEMÁS por SQL directo: si algo solo lo impide el servicio, cualquiera con
 * acceso a la base lo saltaría.
 */
import { pool, closePool } from '../config/db.js';

const BASE = (process.env.API_URL ?? 'http://localhost:4000').replace(/\/$/, '') + '/api';
const ADMIN_USER = process.env.SEED_ADMIN_USERNAME ?? 'admin';
const ADMIN_PASS = process.env.SEED_ADMIN_PASSWORD ?? 'Admin123!';
const TEST_PASS = 'Prueba123';

/** IP simulada propia de esta suite: el limitador de login no se relaja. */
const SUITE_IP = '198.18.10.8';

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

const fails = async (sql, params = []) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query(sql, params);
        await client.query('ROLLBACK');
        return null;
    } catch (error) {
        try {
            await client.query('ROLLBACK');
        } catch {
            /* ya estaba abortada */
        }
        return error;
    } finally {
        client.release();
    }
};

const q = (n) => Number(n).toFixed(2);
/**
 * IDENTIFICADOR ÚNICO DE ESTA EJECUCIÓN.
 *
 * La suite crea su propia sucursal, sus usuarios y sus clientes. Contra una
 * base REAL —donde los datos que dejó la ejecución anterior siguen ahí, y
 * deben seguir— ninguno de esos nombres puede ser fijo:
 *
 *   * `branches` tiene un índice único sobre `normalize_business_text(name)`,
 *     así que un nombre de sucursal literal revienta la segunda vez que se
 *     ejecuta la prueba, aunque el código de sucursal sea distinto;
 *   * `users.username` y `customers.dpi` también son únicos.
 *
 * Son 10 dígitos —los 8 últimos del reloj en milisegundos más 2 al azar— y
 * ANTES de usarlos se comprueba contra la base que no estén ocupados. Así la
 * prueba arranca siempre con un juego de datos libre (es determinista) y no
 * borra ni modifica absolutamente nada de lo que ya existe.
 *
 * Tiene que ser numérico porque el DPI son 13 dígitos exactos.
 */
let RUN = null;

/** Código de la sucursal de prueba: cumple `^[A-Z0-9_-]{2,20}$`. */
const codigoSucursal = (run) => `D42-${run}`;
/** Nombre de la sucursal de prueba: es lo que exige ser único de verdad. */
const nombreSucursal = (run) => `SUCURSAL PRUEBA DEPOSITOS ${run}`;

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
            [`%\_${candidato}`, codigoSucursal(candidato), nombreSucursal(candidato), `4${candidato}%`]
        );
        if (rows.length === 0) return candidato;
    }
    throw new Error('No se encontró un identificador de ejecución libre para la prueba de depósitos');
}
const reason = (r) => r.body?.error?.details?.reason ?? r.body?.details?.reason ?? null;

/** Venta a crédito con cuotas, por SQL: aquí se prueban depósitos, no ventas. */
async function ventaConCuotas({ customerId, createdBy, branchId, cuotas }) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const total = cuotas.reduce((a, b) => a + b, 0);
        const { rows: [sale] } = await client.query(
            `INSERT INTO sales (customer_id, sale_date, payment_mode, installments_count, subtotal, total, created_by, branch_id, notes)
             VALUES ($1, app_today() - 30, 'credito_4', 4, $2, $2, $3, $4, 'venta de prueba del bloque 4.2')
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

async function main() {
    console.log(`\n=== Depósitos y conciliación (bloque 4.2) contra ${BASE} ===\n`);

    // ============================================================ PREPARACIÓN
    console.log('[0] Preparación');
    const admin = await login(ADMIN_USER, ADMIN_PASS);
    if (!admin) throw new Error('Sin sesión de administrador. ¿Ejecutaste `npm run seed`?');

    RUN = await reservarRun();
    console.log(`  ${c.dim}identificador de esta ejecución: ${RUN}${c.off}`);

    const { rows: [adminRow] } = await pool.query(
        'SELECT id, branch_id FROM users WHERE lower(username) = lower($1)', [ADMIN_USER]);
    check('El administrador no tiene sucursal asignada (por eso tiene que indicarla)',
        adminRow.branch_id === null, String(adminRow.branch_id));

    const { rows: [bA] } = await pool.query('SELECT id FROM branches WHERE is_default');
    const branchA = Number(bA.id);
    // La sucursal de la prueba se REUTILIZA si ya existe y solo se crea si
    // falta. No se borra ni se modifica ninguna sucursal: ni la de prueba ni
    // las reales.
    const { rows: yaEstaba } = await pool.query(
        `SELECT id FROM branches
          WHERE code = $1 OR normalize_business_text(name) = normalize_business_text($2)`,
        [codigoSucursal(RUN), nombreSucursal(RUN)]);
    const bB = yaEstaba[0]
        ? yaEstaba[0]
        : (await pool.query('INSERT INTO branches (code, name) VALUES ($1, $2) RETURNING id',
            [codigoSucursal(RUN), nombreSucursal(RUN)])).rows[0];
    const branchB = Number(bB.id);
    check('La sucursal de prueba es propia de esta ejecución y no pisa ninguna existente',
        Number.isFinite(branchB) && branchB !== branchA, JSON.stringify({ branchA, branchB }));

    const mkUser = async (prefix, role, branchId) => {
        const username = `${prefix}_${RUN}`;
        const res = await api('POST', '/users', {
            token: admin,
            body: {
                username,
                full_name: `PRUEBA DEPOSITOS ${prefix}`,
                password: TEST_PASS,
                role,
                ...(branchId ? { branch_id: branchId } : {}),
            },
        });
        return { id: res.body?.data?.id, username, res };
    };
    const uCob = await mkUser('d42_c', 'cobrador', branchA);
    const uCobB = await mkUser('d42_cb', 'cobrador', branchB);
    const uVen = await mkUser('d42_v', 'vendedor', branchA);
    const uGer = await mkUser('d42_g', 'gerencia', branchA);
    const cobrador = await login(uCob.username, TEST_PASS);
    const cobradorB = await login(uCobB.username, TEST_PASS);
    const vendedor = await login(uVen.username, TEST_PASS);
    const gerencia = await login(uGer.username, TEST_PASS);
    check('Entran cobrador A, cobrador B, vendedor y gerencia',
        Boolean(cobrador && cobradorB && vendedor && gerencia),
        JSON.stringify({ cobrador: Boolean(cobrador), cobradorB: Boolean(cobradorB) }));

    const mkCustomer = async (sufijo, nombre) => {
        const res = await api('POST', '/customers', {
            token: admin,
            body: {
                dpi: `4${RUN}${sufijo}`.slice(0, 13).padEnd(13, '0'),
                full_name: nombre,
                phone: '55552222',
                address: 'DIRECCION DE PRUEBA 4.2',
            },
        });
        return Number(res.body?.data?.id);
    };
    const cliA = await mkCustomer('01', 'CLIENTE DEPOSITOS UNO');
    const cliB = await mkCustomer('02', 'CLIENTE DEPOSITOS DOS');

    /** Registra un pago y devuelve su identificador. */
    const cobrar = async (saleId, amount, extra = {}) => {
        const res = await api('POST', '/payments', {
            token: admin,
            body: { sale_id: saleId, amount, method: 'efectivo', ...extra },
        });
        if (res.status !== 201) throw new Error(`No se pudo registrar el pago: ${show(res)}`);
        return Number(res.body?.data?.payment?.id);
    };

    const ventaA = await ventaConCuotas({ customerId: cliA, createdBy: uCob.id, branchId: branchA, cuotas: [100, 100, 100, 100] });
    const ventaA2 = await ventaConCuotas({ customerId: cliA, createdBy: uCob.id, branchId: branchA, cuotas: [200, 200, 200, 200] });
    const ventaB = await ventaConCuotas({ customerId: cliB, createdBy: uCobB.id, branchId: branchB, cuotas: [100, 100, 100, 100] });
    const ventaSinSucursal = await ventaConCuotas({ customerId: cliB, createdBy: uCob.id, branchId: null, cuotas: [100, 100, 100, 100] });

    const p1 = await cobrar(ventaA.id, 100);
    const p2 = await cobrar(ventaA.id, 150);
    const p3 = await cobrar(ventaA2.id, 250);
    const pB = await cobrar(ventaB.id, 100);
    const pSin = await cobrar(ventaSinSucursal.id, 100);
    check('Se registran los pagos de prueba (A: 100+150, A2: 250, B: 100, sin sucursal: 100)',
        [p1, p2, p3, pB, pSin].every(Number.isFinite), JSON.stringify([p1, p2, p3, pB, pSin]));

    // ==================================================== 1. PERMISOS Y CREACIÓN
    console.log('\n[1] Quién crea un depósito');

    const vendedorCrea = await api('POST', '/deposits', {
        token: vendedor, body: { declared_amount: 100 },
    });
    check('El VENDEDOR no puede crear depósitos (no maneja caja)', vendedorCrea.status === 403, show(vendedorCrea));

    const gerenciaCrea = await api('POST', '/deposits', {
        token: gerencia, body: { declared_amount: 100 },
    });
    check('GERENCIA supervisa: tampoco arma depósitos', gerenciaCrea.status === 403, show(gerenciaCrea));

    const adminSinSucursal = await api('POST', '/deposits', {
        token: admin, body: { declared_amount: 100 },
    });
    check('Administración, que no tiene sucursal, debe indicarla', adminSinSucursal.status === 422, show(adminSinSucursal));

    const cobradorOtraSucursal = await api('POST', '/deposits', {
        token: cobrador, body: { declared_amount: 100, branch_id: branchB },
    });
    check('Un cobrador no puede registrar un depósito de OTRA sucursal',
        cobradorOtraSucursal.status === 403, show(cobradorOtraSucursal));

    // ==================================================== 2. DEPÓSITO QUE CUADRA
    console.log('\n[2] Depósito con varios pagos: conciliación exacta');

    const exacto = await api('POST', '/deposits', {
        token: cobrador,
        body: {
            declared_amount: 250,
            bank: 'Banco de Prueba',
            account: '123-4567-8',
            reference: `BOL-${RUN}-1`,
            notes: 'deposito del dia',
            payment_ids: [p1, p2],
        },
    });
    check('El COBRADOR registra el depósito (201)', exacto.status === 201, show(exacto));
    const dep1 = exacto.body?.data ?? {};
    check('Nace REVISADO y con la sucursal del cobrador, sin pedirla',
        dep1.status === 'REVISADO' && Number(dep1.branch_id) === branchA,
        JSON.stringify({ status: dep1.status, branch: dep1.branch_id }));
    check('Agrupa los dos pagos incluidos', dep1.payments_count === 2 && dep1.payments?.length === 2,
        String(dep1.payments_count));
    check('MONTO ESPERADO = suma de los pagos aplicables incluidos (100 + 150)',
        q(dep1.reconciliation?.monto_esperado) === '250.00', JSON.stringify(dep1.reconciliation));
    check('MONTO DECLARADO es el que declaró el empleado', q(dep1.reconciliation?.monto_declarado) === '250.00');
    check('DIFERENCIA cero cuando lo declarado coincide con lo cobrado',
        q(dep1.reconciliation?.diferencia) === '0.00' && dep1.reconciliation?.cuadra === true,
        JSON.stringify(dep1.reconciliation));
    check('El historial registra la creación y la inclusión de cada pago',
        (dep1.events ?? []).filter((e) => e.event === 'CREADO').length === 1 &&
            (dep1.events ?? []).filter((e) => e.event === 'PAGO_AGREGADO').length === 2 &&
            (dep1.events ?? []).filter((e) => e.event === 'PAGO_AGREGADO').every((e) => e.payment_id),
        (dep1.events ?? []).map((e) => e.event).join(','));

    // ==================================================== 3. DIFERENCIAS
    console.log('\n[3] Diferencias: se registran, no se fuerzan a cero y no revierten pagos');

    const faltante = await api('POST', '/deposits', {
        token: cobrador, body: { declared_amount: 200, payment_ids: [p3] },
    });
    const dep2 = faltante.body?.data ?? {};
    check('DIFERENCIA NEGATIVA: se cobró 250 y se depositaron 200 -> -50.00',
        faltante.status === 201 && q(dep2.reconciliation?.diferencia) === '-50.00' &&
            dep2.reconciliation?.cuadra === false,
        JSON.stringify(dep2.reconciliation));
    const { rows: [pagoIntacto] } = await pool.query('SELECT status, amount FROM payments WHERE id = $1', [p3]);
    check('La diferencia NO revierte ni modifica el pago',
        pagoIntacto.status === 'aplicado' && q(pagoIntacto.amount) === '250.00', JSON.stringify(pagoIntacto));

    const ventaC = await ventaConCuotas({ customerId: cliA, createdBy: uCob.id, branchId: branchA, cuotas: [100, 100, 100, 100] });
    const p4 = await cobrar(ventaC.id, 80);
    const sobrante = await api('POST', '/deposits', {
        token: cobrador, body: { declared_amount: 130, payment_ids: [p4] },
    });
    check('DIFERENCIA POSITIVA: se depositó de más -> +50.00',
        sobrante.status === 201 && q(sobrante.body?.data?.reconciliation?.diferencia) === '50.00',
        JSON.stringify(sobrante.body?.data?.reconciliation));

    const vacio = await api('POST', '/deposits', { token: cobrador, body: { declared_amount: 0 } });
    check('Un depósito puede nacer sin pagos y con monto cero', vacio.status === 201,
        show(vacio));

    // ==================================================== 4. QUÉ PAGO PUEDE ENTRAR
    console.log('\n[4] Integridad de la inclusión de pagos');

    const repetidoEnCuerpo = await api('POST', '/deposits', {
        token: cobrador, body: { declared_amount: 100, payment_ids: [p1, p1] },
    });
    check('No se admite el mismo pago dos veces en la misma petición',
        repetidoEnCuerpo.status === 422, show(repetidoEnCuerpo));

    const yaDepositado = await api('POST', '/deposits', {
        token: cobrador, body: { declared_amount: 100, payment_ids: [p1] },
    });
    check('Un pago que ya está en un depósito no entra en otro',
        yaDepositado.status === 409 && reason(yaDepositado) === 'PAYMENT_ALREADY_DEPOSITED', show(yaDepositado));

    const inexistente = await api('POST', '/deposits', {
        token: cobrador, body: { declared_amount: 100, payment_ids: [99999999] },
    });
    check('Un pago inexistente se rechaza con 404', inexistente.status === 404, show(inexistente));

    const otraSucursal = await api('POST', '/deposits', {
        token: cobrador, body: { declared_amount: 100, payment_ids: [pB] },
    });
    check('Un pago de OTRA sucursal no entra en el depósito',
        otraSucursal.status === 409 && reason(otraSucursal) === 'PAYMENT_OTHER_BRANCH', show(otraSucursal));

    const sinSucursalCobrador = await api('POST', '/deposits', {
        token: cobrador, body: { declared_amount: 100, payment_ids: [pSin] },
    });
    check('Un pago de una venta SIN sucursal se rechaza al cobrador',
        sinSucursalCobrador.status === 409 && reason(sinSucursalCobrador) === 'PAYMENT_WITHOUT_BRANCH',
        show(sinSucursalCobrador));

    const sinSucursalAdmin = await api('POST', '/deposits', {
        token: admin, body: { declared_amount: 100, branch_id: branchA, payment_ids: [pSin] },
    });
    const depExcepcion = sinSucursalAdmin.body?.data ?? {};
    check('Solo administración puede incluirlo, y queda constancia de la excepción',
        sinSucursalAdmin.status === 201 &&
            (depExcepcion.events ?? []).some(
                (e) => e.event === 'PAGO_AGREGADO' && /Excepci[oó]n autorizada/i.test(e.comment ?? '')),
        show(sinSucursalAdmin));

    // ---- por SQL directo
    const sqlOtraSucursal = await fails(
        `INSERT INTO deposit_payments (deposit_id, payment_id, added_by) VALUES ($1, $2, $3)`,
        [dep1.id, pB, adminRow.id]);
    check('Por SQL directo tampoco entra un pago de otra sucursal',
        sqlOtraSucursal?.code === '23001', sqlOtraSucursal?.message);

    // ==================================================== 5. REVISIÓN
    console.log('\n[5] Revisión: observación, explicación y rechazo son historial');

    const cobradorObserva = await api('POST', `/deposits/${dep2.id}/observations`, {
        token: cobrador, body: { comment: 'me parece que falta dinero' },
    });
    check('El cobrador no observa: la revisión es de administración y gerencia',
        cobradorObserva.status === 403, show(cobradorObserva));

    const observacion = await api('POST', `/deposits/${dep2.id}/observations`, {
        token: gerencia, body: { comment: 'faltan Q50 respecto de lo cobrado' },
    });
    check('GERENCIA observa el depósito y sigue REVISADO',
        observacion.status === 200 && observacion.body?.data?.status === 'REVISADO', show(observacion));

    const explicacion = await api('POST', `/deposits/${dep2.id}/explanations`, {
        token: cobrador, body: { comment: 'se me quedo una boleta, la llevo manana' },
    });
    check('El empleado explica y el depósito sigue REVISADO',
        explicacion.status === 200 && explicacion.body?.data?.status === 'REVISADO', show(explicacion));

    const rechazo = await api('POST', `/deposits/${dep2.id}/rejections`, {
        token: admin, body: { comment: 'se rechaza mientras se aclara la diferencia' },
    });
    const trasRechazo = rechazo.body?.data ?? {};
    check('El RECHAZO es un evento: el depósito NO pasa a estado RECHAZADO',
        rechazo.status === 200 && trasRechazo.status === 'REVISADO' && trasRechazo.last_event === 'RECHAZADO',
        JSON.stringify({ status: trasRechazo.status, last: trasRechazo.last_event }));
    check('Observación, explicación y rechazo quedan los tres en el historial',
        ['OBSERVADO', 'EXPLICADO', 'RECHAZADO'].every((e) => (trasRechazo.events ?? []).some((x) => x.event === e)),
        (trasRechazo.events ?? []).map((e) => e.event).join(','));
    check('El rechazo no revierte ni saca el pago del depósito',
        trasRechazo.payments_count === 1 && q(trasRechazo.reconciliation?.monto_esperado) === '250.00',
        JSON.stringify(trasRechazo.reconciliation));

    const estadoInventado = await fails(`UPDATE deposits SET status = 'RECHAZADO' WHERE id = $1`, [dep2.id]);
    check('La base tampoco admite un estado RECHAZADO', estadoInventado?.code === '23514', estadoInventado?.message);

    // ==================================================== 6. VALIDACIÓN
    console.log('\n[6] Validación: REVISADO -> VALIDADO, terminal');

    const cobradorValida = await api('POST', `/deposits/${dep1.id}/validate`, { token: cobrador, body: {} });
    check('El cobrador no valida su propio depósito', cobradorValida.status === 403, show(cobradorValida));

    const validado = await api('POST', `/deposits/${dep1.id}/validate`, {
        token: gerencia, body: { comment: 'cuadra con el estado de cuenta' },
    });
    check('GERENCIA valida el depósito',
        validado.status === 200 && validado.body?.data?.status === 'VALIDADO' &&
            validado.body?.data?.validated_by_username === uGer.username,
        show(validado));
    check('La validación queda en el historial con el cambio de estado',
        (validado.body?.data?.events ?? []).some(
            (e) => e.event === 'VALIDADO' && e.from_status === 'REVISADO' && e.to_status === 'VALIDADO'));

    const validarDosVeces = await api('POST', `/deposits/${dep1.id}/validate`, { token: admin, body: {} });
    check('Un depósito validado no se vuelve a validar', validarDosVeces.status === 409, show(validarDosVeces));

    const validarConDiferencia = await api('POST', `/deposits/${dep2.id}/validate`, {
        token: admin, body: { comment: 'se acepta la diferencia, se descuenta al cobrador' },
    });
    check('Una diferencia NO impide validar: la decisión queda documentada',
        validarConDiferencia.status === 200 && validarConDiferencia.body?.data?.status === 'VALIDADO' &&
            q(validarConDiferencia.body?.data?.reconciliation?.diferencia) === '-50.00',
        show(validarConDiferencia));

    // ---- SEPARACIÓN DE FUNCIONES: quien registra el depósito no lo valida
    const uAdmin2 = await mkUser('d42_a2', 'admin', null);
    const admin2 = await login(uAdmin2.username, TEST_PASS);
    const propio = await api('POST', '/deposits', {
        token: admin2, body: { declared_amount: 0, branch_id: branchA },
    });
    check('Administración registra un depósito indicando la sucursal', propio.status === 201, show(propio));
    const depPropio = propio.body?.data ?? {};

    const validarPropio = await api('POST', `/deposits/${depPropio.id}/validate`, { token: admin2, body: {} });
    check('QUIEN CREA UN DEPÓSITO NO LO VALIDA, aunque sea administrador y tenga el permiso',
        validarPropio.status === 403 && reason(validarPropio) === 'SELF_VALIDATION', show(validarPropio));
    const { rows: [sigueRevisado] } = await pool.query('SELECT status FROM deposits WHERE id = $1', [depPropio.id]);
    check('El intento de autovalidación no deja el depósito a medias',
        sigueRevisado.status === 'REVISADO', sigueRevisado.status);

    const validaOtro = await api('POST', `/deposits/${depPropio.id}/validate`, {
        token: admin, body: { comment: 'revisado por otro usuario autorizado' },
    });
    check('Otro usuario con deposits.review sí lo valida',
        validaOtro.status === 200 && validaOtro.body?.data?.status === 'VALIDADO' &&
            Number(validaOtro.body?.data?.validated_by) !== Number(uAdmin2.id),
        show(validaOtro));

    const ventaD = await ventaConCuotas({ customerId: cliA, createdBy: uCob.id, branchId: branchA, cuotas: [100, 100, 100, 100] });
    const p5 = await cobrar(ventaD.id, 60);
    const agregarAValidado = await api('POST', `/deposits/${dep1.id}/payments`, {
        token: cobrador, body: { payment_ids: [p5] },
    });
    check('Un depósito validado ya no admite más pagos', agregarAValidado.status === 409, show(agregarAValidado));

    const observarValidado = await api('POST', `/deposits/${dep1.id}/observations`, {
        token: admin, body: { comment: 'ya no deberia poder observarse' },
    });
    check('Un depósito validado ya no se observa: su revisión terminó',
        observarValidado.status === 409, show(observarValidado));

    // ==================================================== 7. INMUTABILIDAD
    console.log('\n[7] Inmutabilidad y bypass por SQL directo');

    const sqlEnValidado = await fails(
        `INSERT INTO deposit_payments (deposit_id, payment_id, added_by) VALUES ($1, $2, $3)`,
        [dep1.id, p5, adminRow.id]);
    check('Por SQL directo tampoco se le meten pagos a un depósito validado',
        sqlEnValidado?.code === '23001', sqlEnValidado?.message);

    const sqlCambiarMonto = await fails(`UPDATE deposits SET declared_amount = 9999 WHERE id = $1`, [dep1.id]);
    check('El monto de un depósito validado no se modifica', sqlCambiarMonto?.code === '23001', sqlCambiarMonto?.message);

    const sqlVolverAtras = await fails(
        `UPDATE deposits SET status = 'REVISADO', validated_by = NULL, validated_at = NULL WHERE id = $1`, [dep1.id]);
    check('Un depósito validado no vuelve a revisión', sqlVolverAtras?.code === '23001', sqlVolverAtras?.message);

    const sqlSacarPago = await fails('DELETE FROM deposit_payments WHERE deposit_id = $1', [dep2.id]);
    check('Un pago no se saca del depósito ni borrando la relación',
        sqlSacarPago?.code === '23001', sqlSacarPago?.message);

    const sqlMoverPago = await fails(
        'UPDATE deposit_payments SET deposit_id = $1 WHERE payment_id = $2', [dep2.id, p1]);
    check('La relación depósito-pago tampoco se puede cambiar', sqlMoverPago?.code === '23001', sqlMoverPago?.message);

    const sqlBorrarDeposito = await fails('DELETE FROM deposits WHERE id = $1', [dep2.id]);
    check('Un depósito no se elimina', sqlBorrarDeposito?.code === '23001', sqlBorrarDeposito?.message);

    const sqlBorrarHistorial = await fails('DELETE FROM deposit_events WHERE deposit_id = $1', [dep2.id]);
    check('El historial del depósito no se borra ni se edita',
        sqlBorrarHistorial?.code === '23001', sqlBorrarHistorial?.message);

    const { rows: [depAuto] } = await pool.query(
        `INSERT INTO deposits (branch_id, declared_amount, created_by) VALUES ($1, 10, $2) RETURNING id`,
        [branchA, adminRow.id]);
    const sqlAutoValida = await fails(
        `UPDATE deposits SET status = 'VALIDADO', validated_by = $2, validated_at = now() WHERE id = $1`,
        [depAuto.id, adminRow.id]);
    check('Por SQL directo tampoco se autovalida un depósito',
        sqlAutoValida?.code === '23514', sqlAutoValida?.message);

    const sqlCambiarSucursal = await fails('UPDATE deposits SET branch_id = $2 WHERE id = $1', [dep2.id, branchB]);
    check('No se cambia la sucursal de un depósito que ya tiene pagos',
        sqlCambiarSucursal?.code === '23001', sqlCambiarSucursal?.message);

    // ==================================================== 8. ANULACIÓN DE UN PAGO DEPOSITADO
    console.log('\n[8] Un pago depositado que se anula');

    const enRevision = await api('POST', '/deposits', {
        token: cobrador, body: { declared_amount: 60, payment_ids: [p5] },
    });
    const dep3 = enRevision.body?.data ?? {};
    const anulacion = await api('PATCH', `/payments/${p5}/void`, {
        token: admin, body: { reason: 'el cliente reclamo el cobro' },
    });
    check('Un pago ya depositado SÍ se puede anular', anulacion.status === 200, show(anulacion));

    const trasAnular = (await api('GET', `/deposits/${dep3.id}`, { token: admin })).body?.data ?? {};
    check('El pago NO se saca del depósito', trasAnular.payments_count === 1,
        String(trasAnular.payments_count));
    check('La conciliación refleja la anulación: esperado 0, anulado 60, incluido 60',
        q(trasAnular.reconciliation?.monto_esperado) === '0.00' &&
            q(trasAnular.reconciliation?.monto_anulado) === '60.00' &&
            q(trasAnular.reconciliation?.monto_incluido) === '60.00',
        JSON.stringify(trasAnular.reconciliation));
    check('La diferencia pasa a ser todo lo declarado (60 - 0)',
        q(trasAnular.reconciliation?.diferencia) === '60.00', JSON.stringify(trasAnular.reconciliation));
    check('La anulación deja evento en el historial del depósito, señalando el pago',
        (trasAnular.events ?? []).some((e) => e.event === 'OBSERVADO' && Number(e.payment_id) === p5),
        (trasAnular.events ?? []).map((e) => `${e.event}:${e.payment_id}`).join(','));
    check('El depósito no se oculta ni cambia de estado por una anulación',
        trasAnular.status === 'REVISADO', trasAnular.status);

    const anuladoEntraDeNuevo = await api('POST', '/deposits', {
        token: cobrador, body: { declared_amount: 60, payment_ids: [p5] },
    });
    check('Un pago ANULADO no se puede incluir en un depósito nuevo',
        anuladoEntraDeNuevo.status === 409 && reason(anuladoEntraDeNuevo) === 'PAYMENT_VOIDED',
        show(anuladoEntraDeNuevo));

    const ventaE = await ventaConCuotas({ customerId: cliA, createdBy: uCob.id, branchId: branchA, cuotas: [100, 100, 100, 100] });
    const p6 = await cobrar(ventaE.id, 90);
    await api('PATCH', `/payments/${p6}/void`, { token: admin, body: { reason: 'prueba de bypass por sql' } });
    const { rows: [depLibre] } = await pool.query(
        `INSERT INTO deposits (branch_id, declared_amount, created_by) VALUES ($1, 90, $2) RETURNING id`,
        [branchA, adminRow.id]);
    const sqlAnulado = await fails(
        'INSERT INTO deposit_payments (deposit_id, payment_id, added_by) VALUES ($1, $2, $3)',
        [depLibre.id, p6, adminRow.id]);
    check('Por SQL directo tampoco entra un pago anulado', sqlAnulado?.code === '23001', sqlAnulado?.message);

    // ==================================================== 9. CONCURRENCIA
    console.log('\n[9] Concurrencia: el mismo pago en dos depósitos a la vez');

    const ventaF = await ventaConCuotas({ customerId: cliA, createdBy: uCob.id, branchId: branchA, cuotas: [100, 100, 100, 100] });
    const p7 = await cobrar(ventaF.id, 70);
    const dA = (await api('POST', '/deposits', { token: cobrador, body: { declared_amount: 70 } })).body?.data;
    const dB = (await api('POST', '/deposits', { token: cobrador, body: { declared_amount: 70 } })).body?.data;
    const [r1, r2] = await Promise.all([
        api('POST', `/deposits/${dA.id}/payments`, { token: cobrador, body: { payment_ids: [p7] } }),
        api('POST', `/deposits/${dB.id}/payments`, { token: cobrador, body: { payment_ids: [p7] } }),
    ]);
    const okCount = [r1, r2].filter((r) => r.status === 200).length;
    check('Dos inclusiones simultáneas del mismo pago: solo una gana',
        okCount === 1 && [r1, r2].some((r) => r.status === 409),
        JSON.stringify([r1.status, r2.status]));
    const { rows: [unaSola] } = await pool.query(
        'SELECT COUNT(*)::int AS n FROM deposit_payments WHERE payment_id = $1', [p7]);
    check('El pago quedó en un único depósito', unaSola.n === 1, String(unaSola.n));

    // ==================================================== 10. CONSULTA Y AUDITORÍA
    console.log('\n[10] Consulta y bitácora');

    const listado = await api('GET', '/deposits?pageSize=100', { token: cobrador });
    check('El cobrador consulta el listado de depósitos', listado.status === 200 &&
        (listado.body?.data ?? []).length > 0, show(listado));

    const soloConDiferencia = await api('GET', '/deposits?withDifference=true&pageSize=100', { token: admin });
    check('Se pueden listar solo los depósitos que no cuadran',
        soloConDiferencia.status === 200 &&
            (soloConDiferencia.body?.data ?? []).every((d) => d.has_difference === true),
        show(soloConDiferencia));

    const vendedorConsulta = await api('GET', '/deposits', { token: vendedor });
    check('El vendedor no consulta depósitos', vendedorConsulta.status === 403, show(vendedorConsulta));

    const { rows: bitacora } = await pool.query(
        `SELECT action, COUNT(*)::int AS n FROM audit_log
          WHERE action LIKE 'deposit.%' GROUP BY action ORDER BY action`);
    const acciones = Object.fromEntries(bitacora.map((r) => [r.action, r.n]));
    check('La bitácora registra creación, inclusión, observación, explicación, rechazo y validación',
        ['deposit.create', 'deposit.payments.add', 'deposit.observe', 'deposit.explain',
            'deposit.reject', 'deposit.validate'].every((a) => acciones[a] > 0),
        JSON.stringify(acciones));

    const { rows: [denegado] } = await pool.query(
        `SELECT COUNT(*)::int AS n FROM audit_log WHERE action = 'acceso.denegado' AND details::text LIKE '%deposits.%'`);
    check('Los intentos sin permiso también quedan registrados', denegado.n > 0, String(denegado.n));

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
