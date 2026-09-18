/**
 * Prueba del BLOQUE 3.1: solicitudes de crédito.
 *
 * Contra la API en ejecución y con acceso directo a la base de datos (solo
 * para preparar planes de financiamiento, que todavía no tienen endpoint, y
 * para comprobar restricciones e integridad).
 *
 * Crea sus propios usuarios, sucursal, clientes y productos con un sufijo
 * único: no depende de datos previos ni modifica los existentes.
 *
 *   npm run test:credits
 *   API_URL=http://localhost:4000 npm run test:credits
 */
import { pool, closePool } from '../config/db.js';
import {
    centsToMoney,
    effectiveMinimumInstallment,
    effectiveMinimumPrice,
    moneyToCents,
    planMatchesPredefinedRule,
    predefinedPercentage,
    priceFromCost,
    specialPercentage,
} from '../utils/creditPricing.js';
import { PAYMENT_MODES as HISTORIC_MODES, priceTable as historicPriceTable } from '../utils/pricing.js';

const BASE = (process.env.API_URL ?? 'http://localhost:4000').replace(/\/$/, '') + '/api';
const ADMIN_USER = process.env.SEED_ADMIN_USERNAME ?? 'admin';
const ADMIN_PASS = process.env.SEED_ADMIN_PASSWORD ?? 'Admin123!';
const TEST_PASS = 'Prueba123';

let passed = 0;
let failed = 0;
const serverErrors = [];
const c = { ok: '\x1b[32m', bad: '\x1b[31m', dim: '\x1b[2m', off: '\x1b[0m' };

function check(name, condition, extra = '') {
    if (condition) {
        passed += 1;
        console.log(`  ${c.ok}PASA${c.off}  ${name}`);
    } else {
        failed += 1;
        console.log(`  ${c.bad}FALLA${c.off} ${name} ${c.dim}${extra}${c.off}`);
    }
}

/**
 * Regla 9 (3.2): un cliente con operaciones previas debe reconfirmar sus datos
 * antes de cada nueva solicitud. Estas pruebas de 3.1 crean muchas solicitudes
 * del mismo cliente, así que se reconfirma automáticamente antes de cada
 * POST /credit-applications (con la sesión de Administración). La regla en sí
 * se prueba sin este atajo en credit-workflow-test.js.
 */
let confirmToken = '';

/**
 * Cada suite se presenta como un cliente distinto (su propia IP simulada), igual
 * que lo serían dos sucursales. El limitador de login NO se desactiva ni se
 * relaja: sigue contando igual que en producción, y el backend solo hace caso
 * de esta cabecera cuando quien conecta es de confianza según TRUST_PROXY.
 * Gracias a esto varias suites corren seguidas sin reiniciar el backend.
 */
const SUITE_IP = '198.18.10.4';

async function api(method, path, { body, token, headers = {}, skipConfirm = false } = {}) {
    if (confirmToken && !skipConfirm && method === 'POST' && path === '/credit-applications' && body?.customer_id) {
        await fetch(`${BASE}/customers/${body.customer_id}/confirmations`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${confirmToken}` },
            body: '{}',
        });
    }
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
    let json = null;
    try {
        json = await res.json();
    } catch {
        /* sin cuerpo */
    }
    if (res.status >= 500) serverErrors.push(`${method} ${path} -> ${res.status} ${JSON.stringify(json)}`);
    return { status: res.status, body: json };
}

const show = (r) => `estado ${r.status} ${JSON.stringify(r.body?.error ?? r.body?.data ?? r.body).slice(0, 300)}`;

async function login(username, password) {
    const r = await api('POST', '/auth/login', { body: { username, password } });
    return r.body?.data?.token ?? '';
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const stamp = Date.now().toString().slice(-7);

async function main() {
    console.log(`\n=== Solicitudes de crédito (Bloque 3.1) contra ${BASE} ===\n`);

    // ================================================== 0. REGLAS (sin API)
    console.log('[0] Reglas comerciales vigentes (cálculo puro)');

    check('Predefinidos: 4->40, 5->50, 6->60, 10->80, 12->100',
        [[4, 40], [5, 50], [6, 60], [10, 80], [12, 100]].every(([t, p]) => predefinedPercentage(t) === p));
    check('Predefinidos: 8, 7, 9, 11 y 3 cuotas NO son plazos predefinidos',
        [8, 7, 9, 11, 3].every((t) => predefinedPercentage(t) === null));
    check('Especiales: 6->60, 7->65, 8->70, 9->75, 10->80, 11->90, 12->100',
        [[6, 60], [7, 65], [8, 70], [9, 75], [10, 80], [11, 90], [12, 100]].every(([t, p]) => specialPercentage(t) === p));
    check('Especiales: más de 12 suma 10 puntos por cuota (13->110, 18->160, 24->220)',
        specialPercentage(13) === 110 && specialPercentage(18) === 160 && specialPercentage(24) === 220);
    check('Especiales: menos de 6 cuotas no admite financiamiento especial',
        [1, 4, 5].every((t) => specialPercentage(t) === null));
    check('La regla histórica NO se reutiliza: 4 cuotas predefinido es +40 (no +50) y 8 no es predefinido (no +70)',
        predefinedPercentage(4) === 40 && predefinedPercentage(8) === null);
    check('Un plan configurado con +50% en 4 cuotas NO cumple la regla',
        planMatchesPredefinedRule(4, '50.00') === false);
    check('Un plan con +40.00% en 4 cuotas SÍ cumple la regla (comparación exacta de NUMERIC)',
        planMatchesPredefinedRule(4, '40.00') && planMatchesPredefinedRule(4, '40'));
    check('Un plan de 8 cuotas nunca cumple la regla predefinida',
        planMatchesPredefinedRule(8, '70.00') === false);
    check('Precio desde costo con redondeo del medio centavo hacia arriba (777.77 +65% = 1283.32)',
        centsToMoney(priceFromCost(moneyToCents('777.77'), 6500n)) === '1283.32');
    check('Medio centavo exacto sube (0.01 +50% = 0.02)',
        centsToMoney(priceFromCost(moneyToCents('0.01'), 5000n)) === '0.02');
    let rejected = 0;
    for (const bad of ['1.555', '-1', '1e3', 'abc', '', '123456789.00']) {
        try {
            moneyToCents(bad);
        } catch {
            rejected += 1;
        }
    }
    check('Los importes con más de 2 decimales o mal formados se rechazan', rejected === 6, `${rejected}/6`);

    // ============================================================ PREPARACIÓN
    console.log('\n[1] Preparación: sucursales, usuarios, clientes, productos y planes');

    const admin = await login(ADMIN_USER, ADMIN_PASS);
    confirmToken = admin;
    check('El administrador inicia sesión', Boolean(admin));
    if (!admin) throw new Error('Sin sesión de administrador no se puede continuar. ¿Ejecutaste `npm run seed`?');
    const gerencia = await login('gerencia', TEST_PASS);
    check('Gerencia de prueba inicia sesión', Boolean(gerencia));

    const { rows: defaultBranch } = await pool.query('SELECT id FROM branches WHERE is_default');
    const branchA = Number(defaultBranch[0]?.id);
    const newBranch = await api('POST', '/branches', {
        token: admin,
        body: { code: `CR${stamp}`, name: `Sucursal Créditos ${stamp}` },
    });
    const branchB = Number(newBranch.body?.data?.id);
    check('Existe la sucursal A (predeterminada) y se crea la sucursal B', branchA > 0 && branchB > 0, show(newBranch));

    async function createUser(prefix, role, branchId) {
        const username = `${prefix}${stamp}`;
        const r = await api('POST', '/users', {
            token: admin,
            body: { username, full_name: `Prueba ${prefix}`, password: TEST_PASS, role, branch_id: branchId },
        });
        return { id: Number(r.body?.data?.id), username, status: r.status };
    }

    const uVendedorA = await createUser('cv_a', 'vendedor', branchA);
    const uVendedorA2 = await createUser('cv_a2', 'vendedor', branchA);
    const uCobradorA = await createUser('cc_a', 'cobrador', branchA);
    const uCobradorB = await createUser('cc_b', 'cobrador', branchB);
    const uVendedorSinSucursal = await createUser('cv_x', 'vendedor', null);
    const uAdminB = await createUser('ca_b', 'admin', branchB);
    check('Se crean los usuarios de prueba de cada rol',
        [uVendedorA, uVendedorA2, uCobradorA, uCobradorB, uVendedorSinSucursal, uAdminB].every((u) => u.status === 201));

    const vendedorA = await login(uVendedorA.username, TEST_PASS);
    const vendedorA2 = await login(uVendedorA2.username, TEST_PASS);
    const cobradorA = await login(uCobradorA.username, TEST_PASS);
    const cobradorB = await login(uCobradorB.username, TEST_PASS);
    const vendedorSinSucursal = await login(uVendedorSinSucursal.username, TEST_PASS);
    const adminB = await login(uAdminB.username, TEST_PASS);
    check('Todos los usuarios de prueba inician sesión',
        [vendedorA, vendedorA2, cobradorA, cobradorB, vendedorSinSucursal, adminB].every(Boolean));

    const dpiBase = `4${stamp.padStart(10, '0')}`;
    const customer = await api('POST', '/customers', {
        token: admin,
        body: {
            dpi: `${dpiBase}01`,
            full_name: 'María José Peña Álvarez',
            phone: '55554444',
            address: '5a avenida 3-10 zona 1',
            municipality: 'Mixco',
            department: 'Guatemala',
        },
    });
    const customerId = Number(customer.body?.data?.id);
    const customerNoZone = await api('POST', '/customers', {
        token: admin,
        body: { dpi: `${dpiBase}02`, full_name: 'Pedro Pena', phone: '55553333', address: 'Aldea El Rosario casa 4' },
    });
    const customerNoZoneId = Number(customerNoZone.body?.data?.id);
    const inactiveCustomer = await api('POST', '/customers', {
        token: admin,
        body: { dpi: `${dpiBase}03`, full_name: 'Cliente Inactivo', phone: '55552222', address: 'Zona 18 casa 1' },
    });
    const inactiveCustomerId = Number(inactiveCustomer.body?.data?.id);
    const deactivated = await api('PATCH', `/customers/${inactiveCustomerId}/status`, {
        token: admin,
        body: { is_active: false },
    });
    check('Se crean clientes (con zona, sin zona e inactivo)',
        customerId > 0 && customerNoZoneId > 0 && deactivated.status === 200, show(deactivated));

    async function createProduct(code, cost) {
        const r = await api('POST', '/products', {
            token: admin,
            body: { code: `${code}-${stamp}`, name: `Producto crédito ${code}`, category: 'Pruebas', cost, stock: 5 },
        });
        return Number(r.body?.data?.id);
    }
    const product1 = await createProduct('CRA', 1000);
    const product2 = await createProduct('CRB', 777.77);
    const inactiveProduct = await createProduct('CRX', 500);
    const productOff = await api('PATCH', `/products/${inactiveProduct}/status`, { token: admin, body: { is_active: false } });
    check('Se crean productos (dos activos y uno inactivo)', product1 > 0 && product2 > 0 && productOff.status === 200);

    const { rows: adminRow } = await pool.query('SELECT id FROM users WHERE lower(username) = lower($1)', [ADMIN_USER]);
    const adminId = Number(adminRow[0].id);
    const insertPlan = (productId, term, pct, minPrice, minInstallment, active = true) =>
        pool.query(
            `INSERT INTO product_financing_plans
                (product_id, installments_count, financing_percentage, minimum_price, minimum_installment, is_active, created_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [productId, term, pct, minPrice, minInstallment, active, adminId]
        );
    await insertPlan(product1, 12, '100.00', '2000.00', '166.67');
    await insertPlan(product1, 4, '40.00', '1400.00', '350.00');
    await insertPlan(product1, 10, '80.00', '1800.00', '180.00', false);
    check('Se configuran planes predefinidos válidos (12 y 4 activos; 10 inactivo)', true);

    // ================================================== 2. REGLA EN BD
    console.log('\n[2] La base de datos impide planes predefinidos fuera de regla');

    for (const [term, pct, label] of [[4, '50.00', '4 cuotas con +50% (regla histórica)'], [8, '70.00', '8 cuotas (+70% histórico)'], [5, '45.00', '5 cuotas con +45%']]) {
        let code = null;
        let constraint = null;
        try {
            // Mínimo alto a propósito: aquí se prueba la regla del porcentaje, no la del mínimo.
            await insertPlan(product2, term, pct, '99999.00', '1.00');
        } catch (error) {
            code = error.code;
            constraint = error.constraint;
        }
        check(`Plan ${label} rechazado por la restricción`, code === '23514' && constraint === 'product_financing_plans_predefined_rule',
            `${code} ${constraint}`);
    }

    // ================================================== 3. CREACIÓN VÁLIDA
    console.log('\n[3] Creación válida: precio unitario, cantidad, líneas, enganche y normalización');

    const validBody = {
        customer_id: customerId,
        customer_municipality: 'Villa Nueva',
        customer_department: 'Escuintla',
        housing_type: '  casa   propia ',
        residence_time: '5 años',
        employer_name: '  Pañalera   José Álvarez ',
        employer_phone: '2222-3333',
        job_position: 'Encargado de bodega',
        monthly_income: '4500.50',
        personal_reference_name: 'Ana Lucía Ñuñez',
        personal_reference_phone: '4444 5555',
        guarantor_name: 'Óscar Peña',
        guarantor_dpi: '1234 56789 0123',
        proposed_down_payment: 500,
        items: [
            { product_id: product1, quantity: 2, financing_type: 'PREDEFINIDO', installments_count: 12, proposed_price: '2100.00' },
            { product_id: product2, quantity: 1, financing_type: 'ESPECIAL', installments_count: 12, proposed_price: 1500 },
        ],
    };
    const created = await api('POST', '/credit-applications', { token: vendedorA, body: validBody });
    const app1 = created.body?.data ?? {};
    check('Vendedor crea una solicitud válida (201)', created.status === 201, show(created));
    check('Estado inicial SOLICITADO, sucursal del usuario y creador correcto',
        app1.status === 'SOLICITADO' && Number(app1.branch_id) === branchA && Number(app1.created_by) === uVendedorA.id,
        JSON.stringify({ s: app1.status, b: app1.branch_id, u: app1.created_by }));
    check('Tiene número de solicitud', Number(app1.application_number) > 0);

    const line1 = app1.items?.find((i) => Number(i.product_id) === product1) ?? {};
    const line2 = app1.items?.find((i) => Number(i.product_id) === product2) ?? {};
    check('Precio unitario conservado (2100.00) y cantidad 2', line1.proposed_unit_price === '2100.00' && line1.quantity === 2,
        JSON.stringify(line1));
    check('Total de línea = precio unitario x cantidad (4200.00 y 1500.00)',
        line1.line_total === '4200.00' && line2.line_total === '1500.00', `${line1.line_total} ${line2.line_total}`);
    check('Cuota de la línea sin enganche: 4200/12 = 350.00 y 1500/12 = 125.00',
        line1.line_installment === '350.00' && line2.line_installment === '125.00', `${line1.line_installment} ${line2.line_installment}`);
    check('Mínimo PREDEFINIDO sale del plan (2000.00) y mínimo de línea x2 (4000.00)',
        line1.minimum_unit_price === '2000.00' && line1.line_minimum_total === '4000.00', JSON.stringify(line1));
    check('Mínimo ESPECIAL sale de la fórmula: 777.77 +100% = 1555.54',
        line2.minimum_unit_price === '1555.54', line2.minimum_unit_price);
    check('Excepción de precio por LÍNEA: solo la línea bajo el mínimo la requiere',
        line1.requires_price_exception === false && line2.requires_price_exception === true);
    check('La solicitud indica que contiene al menos una línea con excepción', app1.requires_price_exception === true);
    check('Total 5700.00, enganche 500.00 incluido, financiado 5200.00',
        app1.total === '5700.00' && app1.proposed_down_payment === '500.00' && app1.financed_amount === '5200.00',
        `${app1.total} ${app1.proposed_down_payment} ${app1.financed_amount}`);
    check('Cuota consolidada: (5700 - 500) / 12 = 433.33', app1.installments_count === 12 && app1.proposed_installment === '433.33',
        `${app1.installments_count} ${app1.proposed_installment}`);
    check('El vendedor NO recibe costo ni porcentaje de recargo (RN-0001)',
        !('cost_snapshot' in line1) && !('financing_percentage_snapshot' in line1));
    check('No se exponen los campos técnicos de idempotencia', !('client_request_id' in app1) && !('request_fingerprint' in app1));

    check('Normalización: textos en MAYÚSCULAS, sin tildes y conservando la Ñ',
        app1.employer_name_snapshot === 'PAÑALERA JOSE ALVAREZ' &&
            app1.housing_type_snapshot === 'CASA PROPIA' &&
            app1.residence_time_snapshot === '5 AÑOS' &&
            app1.personal_reference_name_snapshot === 'ANA LUCIA ÑUÑEZ' &&
            app1.guarantor_name_snapshot === 'OSCAR PEÑA' &&
            app1.job_position_snapshot === 'ENCARGADO DE BODEGA',
        JSON.stringify([app1.employer_name_snapshot, app1.housing_type_snapshot, app1.residence_time_snapshot, app1.personal_reference_name_snapshot, app1.guarantor_name_snapshot]));
    check('Datos técnicos NO se pasan a mayúsculas: teléfonos y DPI solo se limpian',
        app1.employer_phone_snapshot === '22223333' && app1.personal_reference_phone_snapshot === '44445555' &&
            app1.guarantor_dpi_snapshot === '1234567890123');
    check('Cliente con ficha completa: nombre desde la ficha ya normalizado (PEÑA conservada)',
        app1.customer_full_name_snapshot === 'MARIA JOSE PEÑA ALVAREZ', app1.customer_full_name_snapshot);
    check('Municipio y departamento se toman de la FICHA del cliente, no del formulario',
        app1.customer_municipality_snapshot === 'MIXCO' && app1.customer_department_snapshot === 'GUATEMALA',
        `${app1.customer_municipality_snapshot} ${app1.customer_department_snapshot}`);
    check('Ingreso mensual con decimales exactos', app1.monthly_income_snapshot === '4500.50', app1.monthly_income_snapshot);

    const noZone = await api('POST', '/credit-applications', {
        token: vendedorA,
        body: {
            customer_id: customerNoZoneId,
            customer_municipality: '  san   josé pinula ',
            customer_department: 'guatemala',
            items: [{ product_id: product1, financing_type: 'ESPECIAL', installments_count: 7, quantity: 3, proposed_price: '1700' }],
        },
    });
    const app2 = noZone.body?.data ?? {};
    check('Cliente sin zona en la ficha: se usa el formulario, normalizado',
        noZone.status === 201 && app2.customer_municipality_snapshot === 'SAN JOSE PINULA' && app2.customer_department_snapshot === 'GUATEMALA',
        show(noZone));
    check('PEÑA y PENA son distintos: el nombre PENA no se convierte en PEÑA', app2.customer_full_name_snapshot === 'PEDRO PENA');
    check('Especial 7 cuotas: mínimo 1000 +65% = 1650.00; línea 3 x 1700 = 5100.00; cuota 728.57',
        app2.items?.[0]?.minimum_unit_price === '1650.00' && app2.total === '5100.00' && app2.proposed_installment === '728.57',
        JSON.stringify({ min: app2.items?.[0]?.minimum_unit_price, t: app2.total, q: app2.proposed_installment }));
    check('Sin enganche: por defecto 0.00 y financiado = total',
        app2.proposed_down_payment === '0.00' && app2.financed_amount === '5100.00');
    check('La cantidad enviada (3) se conserva', app2.items?.[0]?.quantity === 3);

    const special18 = await api('POST', '/credit-applications', {
        token: vendedorA,
        body: { customer_id: customerId, items: [{ product_id: product1, financing_type: 'ESPECIAL', installments_count: 18, proposed_price: '2600.00' }] },
    });
    check('Especial 18 cuotas válido: mínimo 1000 +160% = 2600.00 y cantidad por defecto 1',
        special18.status === 201 && special18.body?.data?.items?.[0]?.minimum_unit_price === '2600.00' &&
            special18.body?.data?.items?.[0]?.quantity === 1,
        show(special18));

    const predefined4 = await api('POST', '/credit-applications', {
        token: vendedorA,
        body: { customer_id: customerId, items: [{ product_id: product1, financing_type: 'PREDEFINIDO', installments_count: 4, proposed_price: '1400.00' }] },
    });
    check('Predefinido 4 cuotas usa el plan de +40% (no el histórico +50%)', predefined4.status === 201, show(predefined4));

    const { rows: sideEffects } = await pool.query(
        `SELECT (SELECT COUNT(*)::int FROM sales WHERE customer_id = ANY($1::bigint[])) AS sales,
                (SELECT COUNT(*)::int FROM payments WHERE customer_id = ANY($1::bigint[])) AS payments,
                (SELECT stock FROM products WHERE id = $2) AS stock1`,
        [[customerId, customerNoZoneId], product1]
    );
    check('Una solicitud NO crea ventas, pagos ni mueve inventario',
        sideEffects[0].sales === 0 && sideEffects[0].payments === 0 && sideEffects[0].stock1 === 5, JSON.stringify(sideEffects[0]));

    const adminDetail = await api('GET', `/credit-applications/${app1.id}`, { token: admin });
    const adminLine2 = adminDetail.body?.data?.items?.find((i) => Number(i.product_id) === product2) ?? {};
    check('Administración SÍ ve costo congelado y porcentaje (777.77 y 100.00)',
        adminDetail.status === 200 && adminLine2.cost_snapshot === '777.77' && adminLine2.financing_percentage_snapshot === '100.00',
        show(adminDetail));

    await sleep(300);
    const { rows: auditRows } = await pool.query(
        `SELECT action, user_id, details FROM audit_log WHERE action = 'credit_application.create' AND entity_id = $1`,
        [app1.id]
    );
    check('La creación queda en la bitácora con el usuario y el total',
        auditRows.length === 1 && Number(auditRows[0].user_id) === uVendedorA.id && auditRows[0].details?.total === '5700.00',
        JSON.stringify(auditRows));

    // ================================================== 3b. MÍNIMOS (decisiones 1 y 2)
    console.log('\n[3b] Cuota mínima efectiva y precio mínimo predefinido (decisiones 2026-09-16)');

    // --- Cálculo puro
    const inst = (minUnit, qty, term, configured) =>
        effectiveMinimumInstallment(moneyToCents(minUnit), qty, term, configured === null ? null : moneyToCents(configured));
    const iLess = inst('1500.00', 1, 5, '250.00');
    check('Unidad: cuota configurada MENOR que la matemática -> manda la matemática (300.00)',
        centsToMoney(iLess.mathematical) === '300.00' && centsToMoney(iLess.effective) === '300.00');
    const iEqual = inst('2000.00', 1, 12, '166.67');
    check('Unidad: cuota configurada IGUAL a la matemática -> 166.67',
        centsToMoney(iEqual.mathematical) === '166.67' && centsToMoney(iEqual.effective) === '166.67');
    const iGreater = inst('1700.00', 1, 6, '300.00');
    check('Unidad: cuota configurada MAYOR que la matemática (283.33) -> manda la configurada (300.00)',
        centsToMoney(iGreater.mathematical) === '283.33' && centsToMoney(iGreater.effective) === '300.00');
    const iSpecial = inst('1650.00', 3, 7, null);
    check('Unidad: sin plan (ESPECIAL) la cuota mínima es la matemática (4950/7 = 707.14)',
        iSpecial.configured === null && centsToMoney(iSpecial.effective) === '707.14');
    check('Unidad: precio mínimo efectivo = MAX(matemático, configurado)',
        centsToMoney(effectiveMinimumPrice(moneyToCents('1400.00'), moneyToCents('1500.00'))) === '1500.00' &&
            centsToMoney(effectiveMinimumPrice(moneyToCents('1760.00'), moneyToCents('1700.00'))) === '1760.00' &&
            centsToMoney(effectiveMinimumPrice(moneyToCents('1650.00'), null)) === '1650.00');

    // --- Reglas históricas de ventas intactas (pricing.js y columnas generadas)
    check('pricing.js histórico intacto: contado 0.3, credito_4 0.5 (4 pagos), credito_8 0.7 (8 pagos)',
        HISTORIC_MODES.contado.markup === 0.3 && HISTORIC_MODES.contado.installments === 1 &&
            HISTORIC_MODES.credito_4.markup === 0.5 && HISTORIC_MODES.credito_4.installments === 4 &&
            HISTORIC_MODES.credito_8.markup === 0.7 && HISTORIC_MODES.credito_8.installments === 8 &&
            Object.keys(HISTORIC_MODES).join(',') === 'contado,credito_4,credito_8');
    const historicTable = historicPriceTable(1000);
    check('pricing.js histórico: costo 1000 -> 1300 / 1500 / 1700',
        historicTable.contado === 1300 && historicTable.credito_4 === 1500 && historicTable.credito_8 === 1700,
        JSON.stringify(historicTable));

    // --- Configuración de planes en base de datos (decisión 2)
    const product3 = await createProduct('CRM', 1000);
    const product4 = await createProduct('CRN', 1000);
    const { rows: generated } = await pool.query('SELECT price_cash, price_credit_4, price_credit_8 FROM products WHERE id = $1', [product3]);
    check('Columnas generadas históricas de products intactas (1300.00 / 1500.00 / 1700.00)',
        generated[0].price_cash === '1300.00' && generated[0].price_credit_4 === '1500.00' && generated[0].price_credit_8 === '1700.00',
        JSON.stringify(generated[0]));
    const modesHistoric = await api('GET', '/sales/payment-modes', { token: admin });
    check('El módulo de ventas sigue publicando 30/50/70',
        modesHistoric.body?.data?.map((m) => m.markup_percent).join(',') === '30,50,70');

    const planError = async (fn) => {
        try {
            await fn();
            return null;
        } catch (error) {
            return error;
        }
    };
    const below1399 = await planError(() => insertPlan(product4, 4, '40.00', '1399.00', '100.00'));
    check('Predefinido 4 cuotas con mínimo Q1399.00 (costo 1000 +40% = 1400) -> RECHAZADO',
        below1399?.code === '23514' && below1399?.constraint === 'product_financing_plans_minimum_price_rule',
        `${below1399?.code} ${below1399?.constraint} ${below1399?.message}`);
    const below139999 = await planError(() => insertPlan(product4, 4, '40.00', '1399.99', '100.00'));
    check('Predefinido 4 cuotas con mínimo Q1399.99 (un centavo menos) -> RECHAZADO',
        below139999?.constraint === 'product_financing_plans_minimum_price_rule', below139999?.message);
    const equal1400 = await planError(() => insertPlan(product4, 4, '40.00', '1400.00', '100.00'));
    check('Predefinido 4 cuotas con mínimo IGUAL al matemático (Q1400.00) -> válido', equal1400 === null, equal1400?.message);
    const above1801 = await planError(() => insertPlan(product4, 10, '80.00', '1800.01', '100.00'));
    check('Predefinido 10 cuotas con mínimo SUPERIOR al matemático (Q1800.01 > Q1800.00) -> válido', above1801 === null, above1801?.message);
    let allTerms = 0;
    for (const [term, pct, math] of [[5, '50.00', 1500], [6, '60.00', 1600], [12, '100.00', 2000]]) {
        const bad = await planError(() => insertPlan(product4, term, pct, (math - 0.01).toFixed(2), '1.00'));
        const good = await planError(() => insertPlan(product4, term, pct, math.toFixed(2), '1.00'));
        if (bad?.constraint === 'product_financing_plans_minimum_price_rule' && good === null) allTerms += 1;
    }
    check('La regla aplica a 5 (+50), 6 (+60) y 12 (+100): un centavo menos se rechaza y el exacto se acepta', allTerms === 3, `${allTerms}/3`);
    const lowerUpdate = await planError(() =>
        pool.query('UPDATE product_financing_plans SET minimum_price = 1300 WHERE product_id = $1 AND installments_count = 4', [product4]));
    check('Bajar el mínimo de un plan existente por debajo del matemático -> RECHAZADO',
        lowerUpdate?.constraint === 'product_financing_plans_minimum_price_rule', lowerUpdate?.message);
    const deactivate = await planError(() =>
        pool.query('UPDATE product_financing_plans SET is_active = FALSE WHERE product_id = $1 AND installments_count = 4', [product4]));
    check('Desactivar un plan no revalida el mínimo', deactivate === null, deactivate?.message);

    await insertPlan(product3, 5, '50.00', '1500.00', '250.00');  // mínimo igual; cuota configurada MENOR (matemática 300.00)
    await insertPlan(product3, 6, '60.00', '1700.00', '300.00');  // mínimo superior; cuota configurada MAYOR (matemática 283.33)
    await insertPlan(product3, 12, '100.00', '2000.00', '166.67'); // mínimo igual; cuota configurada IGUAL

    // --- Solicitudes reales (decisión 1)
    const lineOf = async (term, qty, price) => {
        const r = await api('POST', '/credit-applications', {
            token: vendedorA,
            body: { customer_id: customerId, items: [{ product_id: product3, financing_type: 'PREDEFINIDO', installments_count: term, quantity: qty, proposed_price: price }] },
        });
        return { r, app: r.body?.data ?? {}, line: r.body?.data?.items?.[0] ?? {} };
    };

    const less = await lineOf(5, 1, '1500.00');
    check('Solicitud: cuota configurada MENOR que la matemática -> cuota mínima efectiva 300.00 (no 250.00)',
        less.r.status === 201 && less.line.line_minimum_installment === '300.00' && less.line.configured_minimum_unit_installment === '250.00',
        show(less.r));
    check('Solicitud: precio en el mínimo y cuota en el mínimo -> sin excepción',
        less.line.requires_price_exception === false && less.line.requires_installment_exception === false && less.app.requires_exception === false);

    const equal = await lineOf(12, 1, '2000.00');
    check('Solicitud: cuota configurada IGUAL a la matemática -> 166.67 y sin excepción',
        equal.r.status === 201 && equal.line.line_minimum_installment === '166.67' && equal.line.requires_exception === false,
        show(equal.r));
    check('Solicitud: precio mínimo PREDEFINIDO igual al matemático -> 2000.00',
        equal.line.minimum_unit_price === '2000.00' && equal.line.configured_minimum_unit_price === '2000.00');

    const greater = await lineOf(6, 1, '1700.00');
    check('Solicitud: cuota configurada MAYOR que la matemática -> cuota mínima efectiva 300.00',
        greater.r.status === 201 && greater.line.line_minimum_installment === '300.00', show(greater.r));
    check('Solicitud: precio mínimo PREDEFINIDO superior al matemático -> se respeta el configurado (1700.00 > 1600.00)',
        greater.line.minimum_unit_price === '1700.00');
    check('Precio en el mínimo pero cuota (283.33) bajo la cuota mínima (300.00) -> requiere excepción por CUOTA',
        greater.line.line_installment === '283.33' && greater.line.requires_price_exception === false &&
            greater.line.requires_installment_exception === true && greater.line.requires_exception === true &&
            greater.app.requires_price_exception === false && greater.app.requires_installment_exception === true &&
            greater.app.requires_exception === true,
        JSON.stringify(greater.line));

    const qty2 = await lineOf(6, 2, '1800.00');
    check('Cantidad 2: cuota mínima = MAX(round(1700 x 2 / 6) = 566.67, 300.00 x 2 = 600.00) = 600.00',
        qty2.r.status === 201 && qty2.line.line_minimum_installment === '600.00' && qty2.line.line_installment === '600.00' &&
            qty2.line.requires_exception === false,
        JSON.stringify(qty2.line));

    const { rows: storedMinimums } = await pool.query(
        `SELECT minimum_price_snapshot, minimum_installment_snapshot, configured_minimum_price_snapshot, configured_minimum_installment_snapshot
           FROM credit_application_items WHERE credit_application_id = $1`,
        [greater.app.id]
    );
    check('Se congelan el mínimo efectivo y lo configurado por Administración',
        storedMinimums[0].minimum_price_snapshot === '1700.00' && storedMinimums[0].minimum_installment_snapshot === '300.00' &&
            storedMinimums[0].configured_minimum_price_snapshot === '1700.00' && storedMinimums[0].configured_minimum_installment_snapshot === '300.00',
        JSON.stringify(storedMinimums[0]));

    // Si el costo sube después de configurar el plan, el mínimo nunca queda por debajo del matemático.
    const costUp = await api('PUT', `/products/${product3}`, { token: admin, body: { cost: 1100 } });
    const afterCost = await lineOf(6, 1, '1700.00');
    check('Costo sube a 1100: mínimo efectivo = MAX(1100 +60% = 1760.00, configurado 1700.00) = 1760.00 y 1700 requiere excepción',
        costUp.status === 200 && afterCost.r.status === 201 && afterCost.line.minimum_unit_price === '1760.00' &&
            afterCost.line.configured_minimum_unit_price === '1700.00' && afterCost.line.requires_price_exception === true,
        JSON.stringify({ cost: costUp.status, line: afterCost.line }));
    const { rows: belowView } = await pool.query(
        'SELECT installments_count, minimum_price, mathematical_minimum_price FROM v_financing_plans_below_minimum WHERE product_id = $1 ORDER BY installments_count', [product3]);
    check('Los tres planes que quedaron bajo el mínimo por el nuevo costo aparecen en v_financing_plans_below_minimum sin modificarse (5->1650, 6->1760, 12->2200)',
        belowView.map((p) => `${p.installments_count}:${p.minimum_price}:${p.mathematical_minimum_price}`).join(',') ===
            '5:1500.00:1650.00,6:1700.00:1760.00,12:2000.00:2200.00',
        JSON.stringify(belowView));
    const { rows: specialLine } = await pool.query(
        `SELECT configured_minimum_price_snapshot, configured_minimum_installment_snapshot, minimum_installment_snapshot
           FROM credit_application_items WHERE credit_application_id = $1`, [app2.id]);
    check('ESPECIAL no tiene configuración: columnas configuradas NULL y cuota mínima matemática (1650 x 3 / 7 = 707.14)',
        specialLine[0].configured_minimum_price_snapshot === null && specialLine[0].configured_minimum_installment_snapshot === null &&
            specialLine[0].minimum_installment_snapshot === '707.14',
        JSON.stringify(specialLine[0]));

    // ================================================== 4. ERRORES HTTP
    console.log('\n[4] Errores esperables: códigos HTTP coherentes, nunca 500');

    const item = (over = {}) => ({ product_id: product1, quantity: 1, financing_type: 'ESPECIAL', installments_count: 12, proposed_price: '2000.00', ...over });
    const post = (body, token = vendedorA, headers = {}) => api('POST', '/credit-applications', { token, body, headers });

    const cases = [
        ['Cliente inexistente -> 400', { customer_id: 999999999, items: [item()] }, 400, 'BAD_REQUEST'],
        ['Cliente inactivo -> 422', { customer_id: inactiveCustomerId, items: [item()] }, 422, 'UNPROCESSABLE'],
        ['Producto inexistente -> 400', { customer_id: customerId, items: [item({ product_id: 999999999 })] }, 400, 'BAD_REQUEST'],
        ['Producto inactivo -> 422', { customer_id: customerId, items: [item({ product_id: inactiveProduct })] }, 422, 'UNPROCESSABLE'],
        ['Plan predefinido inexistente (5 cuotas) -> 422', { customer_id: customerId, items: [item({ financing_type: 'PREDEFINIDO', installments_count: 5 })] }, 422, 'UNPROCESSABLE'],
        ['Plan predefinido inactivo (10 cuotas) -> 422', { customer_id: customerId, items: [item({ financing_type: 'PREDEFINIDO', installments_count: 10 })] }, 422, 'UNPROCESSABLE'],
        ['Plazo que no es predefinido (8 cuotas) -> 422', { customer_id: customerId, items: [item({ financing_type: 'PREDEFINIDO', installments_count: 8 })] }, 422, 'UNPROCESSABLE'],
        ['Especial con menos de 6 cuotas (5) -> 422', { customer_id: customerId, items: [item({ installments_count: 5 })] }, 422, 'UNPROCESSABLE'],
        ['Tipo de financiamiento desconocido -> 422', { customer_id: customerId, items: [item({ financing_type: 'CONTADO' })] }, 422, 'UNPROCESSABLE'],
        ['Precio con 3 decimales -> 422', { customer_id: customerId, items: [item({ proposed_price: '2000.555' })] }, 422, 'UNPROCESSABLE'],
        ['Precio numérico con 3 decimales -> 422', { customer_id: customerId, items: [item({ proposed_price: 2000.555 })] }, 422, 'UNPROCESSABLE'],
        ['Precio en notación científica -> 422', { customer_id: customerId, items: [item({ proposed_price: '2e3' })] }, 422, 'UNPROCESSABLE'],
        ['Precio negativo -> 422', { customer_id: customerId, items: [item({ proposed_price: -5 })] }, 422, 'UNPROCESSABLE'],
        ['Precio cero -> 422', { customer_id: customerId, items: [item({ proposed_price: '0.00' })] }, 422, 'UNPROCESSABLE'],
        ['Precio no numérico -> 422', { customer_id: customerId, items: [item({ proposed_price: 'mil' })] }, 422, 'UNPROCESSABLE'],
        ['Cantidad cero -> 422', { customer_id: customerId, items: [item({ quantity: 0 })] }, 422, 'UNPROCESSABLE'],
        ['Cantidad decimal -> 422', { customer_id: customerId, items: [item({ quantity: 1.5 })] }, 422, 'UNPROCESSABLE'],
        ['Cantidad como texto -> 422', { customer_id: customerId, items: [item({ quantity: '2' })] }, 422, 'UNPROCESSABLE'],
        ['Enganche igual al total -> 422', { customer_id: customerId, proposed_down_payment: '2000.00', items: [item()] }, 422, 'UNPROCESSABLE'],
        ['Enganche mayor al total -> 422', { customer_id: customerId, proposed_down_payment: '2500', items: [item()] }, 422, 'UNPROCESSABLE'],
        ['Enganche con 3 decimales -> 422', { customer_id: customerId, proposed_down_payment: '10.001', items: [item()] }, 422, 'UNPROCESSABLE'],
        ['Enganche por línea (ya no se acepta) -> 422', { customer_id: customerId, items: [item({ proposed_down_payment: 10 })] }, 422, 'UNPROCESSABLE'],
        ['Sin productos -> 422', { customer_id: customerId, items: [] }, 422, 'UNPROCESSABLE'],
        ['Sin cliente -> 422', { items: [item()] }, 422, 'UNPROCESSABLE'],
        ['Campo no declarado (costo enviado por el cliente) -> 422', { customer_id: customerId, items: [item({ cost_snapshot: 1 })] }, 422, 'UNPROCESSABLE'],
        ['DPI de fiador inválido -> 422', { customer_id: customerId, guarantor_dpi: '123', items: [item()] }, 422, 'UNPROCESSABLE'],
        ['Teléfono inválido -> 422', { customer_id: customerId, employer_phone: '12', items: [item()] }, 422, 'UNPROCESSABLE'],
    ];
    for (const [name, body, status, code] of cases) {
        const r = await post(body);
        check(name, r.status === status && r.body?.ok === false && r.body?.error?.code === code, show(r));
    }

    const enganchePermitido = await post({ customer_id: customerId, proposed_down_payment: '1999.99', items: [item()] });
    check('Enganche un centavo menor al total SÍ se acepta (financiado 0.01)',
        enganchePermitido.status === 201 && enganchePermitido.body?.data?.financed_amount === '0.01', show(enganchePermitido));

    // Decisión confirmada: el enganche debe ser ESTRICTAMENTE menor que el total de la SOLICITUD
    // (precio unitario x cantidad, sumando todas las líneas).
    const twoLines = [item({ quantity: 2 }), item({ proposed_price: '1500.00' })]; // 4000.00 + 1500.00 = 5500.00
    const dpEqualMulti = await post({ customer_id: customerId, proposed_down_payment: '5500.00', items: twoLines });
    check('Varias líneas y cantidad: enganche IGUAL al total de la solicitud (5500.00) -> 422',
        dpEqualMulti.status === 422 && dpEqualMulti.body?.error?.code === 'UNPROCESSABLE', show(dpEqualMulti));
    const dpAboveLine = await post({ customer_id: customerId, proposed_down_payment: '4000.01', items: [item({ quantity: 2 })] });
    check('Cantidad 2: enganche mayor que el total de la línea (4000.01 > 4000.00) -> 422 (se compara contra unitario x cantidad)',
        dpAboveLine.status === 422, show(dpAboveLine));
    const dpBelowMulti = await post({ customer_id: customerId, proposed_down_payment: '5499.99', items: twoLines });
    check('Varias líneas y cantidad: enganche un centavo menor (5499.99) -> 201, financiado 0.01',
        dpBelowMulti.status === 201 && dpBelowMulti.body?.data?.total === '5500.00' && dpBelowMulti.body?.data?.financed_amount === '0.01',
        show(dpBelowMulti));

    const errorDetails = await post({ customer_id: customerId, items: [item({ proposed_price: '1.999' })] });
    check('El 422 de validación incluye detalle por campo',
        Array.isArray(errorDetails.body?.error?.details) && errorDetails.body.error.details.some((d) => d.campo === 'items.0.proposed_price'),
        JSON.stringify(errorDetails.body?.error?.details));

    const noBranch = await post({ customer_id: customerId, items: [item()] }, vendedorSinSucursal);
    check('Usuario sin sucursal asignada -> 422', noBranch.status === 422 && noBranch.body?.error?.code === 'UNPROCESSABLE', show(noBranch));

    const notFound = await api('GET', '/credit-applications/999999999', { token: admin });
    check('Solicitud inexistente -> 404 con formato de error estándar',
        notFound.status === 404 && notFound.body?.error?.code === 'NOT_FOUND', show(notFound));
    const badId = await api('GET', '/credit-applications/abc', { token: admin });
    check('Identificador inválido -> 422', badId.status === 422, show(badId));

    // ================================================== 5. PERMISOS
    console.log('\n[5] Permisos por rol');

    const noToken = await api('POST', '/credit-applications', { body: { customer_id: customerId, items: [item()] } });
    check('Sin token -> 401', noToken.status === 401, show(noToken));
    const noTokenList = await api('GET', '/credit-applications');
    check('Listar sin token -> 401', noTokenList.status === 401);
    check('Cobrador NO crea solicitudes (403)', (await post({ customer_id: customerId, items: [item()] }, cobradorA)).status === 403);
    check('Gerencia NO crea solicitudes (403)', (await post({ customer_id: customerId, items: [item()] }, gerencia)).status === 403);
    const adminCreates = await post({ customer_id: customerId, items: [item({ proposed_price: '2500.00' })] }, adminB);
    check('Administración SÍ crea solicitudes (en su sucursal B)',
        adminCreates.status === 201 && Number(adminCreates.body?.data?.branch_id) === branchB, show(adminCreates));
    const app3 = adminCreates.body?.data ?? {};
    const vendorA2Creates = await post({ customer_id: customerId, items: [item({ proposed_price: '2100.00' })] }, vendedorA2);
    check('Otro vendedor de la misma sucursal crea su propia solicitud', vendorA2Creates.status === 201, show(vendorA2Creates));
    const app4 = vendorA2Creates.body?.data ?? {};

    // ================================================== 6. ALCANCE
    console.log('\n[6] Alcance por rol en GET /credit-applications y GET /:id');

    const ids = (r) => (r.body?.data ?? []).map((row) => Number(row.id));
    const listFor = (token, query = '') =>
        api('GET', `/credit-applications?customer_id=${customerId}&pageSize=100${query}`, { token });

    const vA = await listFor(vendedorA);
    check('Vendedor A ve sus solicitudes', vA.status === 200 && ids(vA).includes(app1.id), show(vA));
    check('Vendedor A NO ve la del otro vendedor ni la de la sucursal B',
        !ids(vA).includes(app4.id) && !ids(vA).includes(app3.id), ids(vA).join(','));
    check('Vendedor A: todas las filas son suyas', (vA.body?.data ?? []).every((row) => Number(row.created_by) === uVendedorA.id));
    const vAOther = await listFor(vendedorA, `&created_by=${uVendedorA2.id}`);
    check('Vendedor A no amplía su alcance filtrando por otro creador (0 filas)', ids(vAOther).length === 0, ids(vAOther).join(','));
    check('Vendedor A: GET de una solicitud ajena -> 404', (await api('GET', `/credit-applications/${app4.id}`, { token: vendedorA })).status === 404);
    check('Vendedor A: GET de la propia -> 200', (await api('GET', `/credit-applications/${app1.id}`, { token: vendedorA })).status === 200);

    const cA = await listFor(cobradorA);
    check('Cobrador A ve las solicitudes de su sucursal por verificar (de ambos vendedores)',
        cA.status === 200 && ids(cA).includes(app1.id) && ids(cA).includes(app4.id), ids(cA).join(','));
    check('Cobrador A NO ve las de la sucursal B', !ids(cA).includes(app3.id));
    check('Cobrador A: todas las filas son de su sucursal y por verificar',
        (cA.body?.data ?? []).every((row) => Number(row.branch_id) === branchA && ['SOLICITADO', 'EN_VERIFICACION'].includes(row.status)));
    check('Cobrador A: GET de la sucursal B -> 404', (await api('GET', `/credit-applications/${app3.id}`, { token: cobradorA })).status === 404);
    const cAFilterB = await listFor(cobradorA, `&branch_id=${branchB}`);
    check('Cobrador A no amplía su alcance filtrando por la sucursal B (0 filas)', ids(cAFilterB).length === 0);

    const cB = await listFor(cobradorB);
    check('Cobrador B solo ve la solicitud de la sucursal B', ids(cB).length === 1 && ids(cB)[0] === app3.id, ids(cB).join(','));

    // Avance real del flujo (3.2): el cobrador de la sucursal verifica y envía a evaluación.
    const verified = await api('POST', `/credit-applications/${app4.id}/verifications`, {
        token: cobradorA,
        body: { result: 'FAVORABLE', recommendation: 'FAVORABLE', address_matches: 'SI', housing_verified: 'SI', residence_time_matches: 'SI', conclude: true },
    });
    check('El cobrador de la sucursal verifica y envía a evaluación (flujo 3.2)', verified.status === 201 && verified.body?.data?.status === 'EN_EVALUACION', show(verified));
    const cAAfter = await listFor(cobradorA);
    check('Una solicitud fuera de verificación (EN_EVALUACION) deja de estar en el alcance del cobrador',
        !ids(cAAfter).includes(app4.id) && ids(cAAfter).includes(app1.id), ids(cAAfter).join(','));
    check('Cobrador A: GET de una solicitud ya no verificable -> 404',
        (await api('GET', `/credit-applications/${app4.id}`, { token: cobradorA })).status === 404);
    check('El creador sigue viendo su solicitud en cualquier estado',
        (await api('GET', `/credit-applications/${app4.id}`, { token: vendedorA2 })).status === 200);
    const { rows: frozen } = await pool.query('SELECT employer_name_snapshot FROM credit_applications WHERE id = $1', [app1.id]);
    await pool.query('UPDATE credit_applications SET updated_at = now() WHERE id = $1', [app1.id]);
    const { rows: frozenAfter } = await pool.query('SELECT employer_name_snapshot FROM credit_applications WHERE id = $1', [app1.id]);
    check('Un UPDATE posterior no reescribe los datos congelados', frozen[0].employer_name_snapshot === frozenAfter[0].employer_name_snapshot);

    const g = await listFor(gerencia);
    check('Gerencia ve todas (ambas sucursales, todos los creadores y estados)',
        [app1.id, app3.id, app4.id].every((id) => ids(g).includes(id)), ids(g).join(','));
    const a = await listFor(admin);
    check('Administración ve todas', [app1.id, app3.id, app4.id].every((id) => ids(a).includes(id)));
    check('Gerencia: GET de cualquier solicitud -> 200', (await api('GET', `/credit-applications/${app3.id}`, { token: gerencia })).status === 200);

    const vendorSinSucursalList = await api('GET', '/credit-applications', { token: vendedorSinSucursal });
    check('Vendedor sin sucursal lista sin error (solo lo suyo: nada)', vendorSinSucursalList.status === 200 && ids(vendorSinSucursalList).length === 0);

    // ================================================== 7. FILTROS
    console.log('\n[7] Filtros del listado');

    const byStatus = await listFor(admin, '&status=EN_EVALUACION');
    check('Filtro por estado', ids(byStatus).length === 1 && ids(byStatus)[0] === app4.id, ids(byStatus).join(','));
    const byStatuses = await listFor(admin, '&status=solicitado,en_evaluacion');
    check('Filtro por varios estados (sin distinguir mayúsculas)', ids(byStatuses).includes(app4.id) && ids(byStatuses).includes(app1.id));
    const byBranch = await listFor(admin, `&branch_id=${branchB}`);
    check('Filtro por sucursal', ids(byBranch).length === 1 && ids(byBranch)[0] === app3.id);
    const byCreator = await listFor(admin, `&created_by=${uVendedorA2.id}`);
    check('Filtro por creador', ids(byCreator).length === 1 && ids(byCreator)[0] === app4.id);
    const byType = await api('GET', `/credit-applications?financing_type=predefinido&created_by=${uVendedorA.id}&pageSize=100`, { token: admin });
    check('Filtro por tipo de financiamiento de las líneas',
        byType.status === 200 && ids(byType).includes(app1.id) && ids(byType).includes(Number(predefined4.body?.data?.id)) &&
            !ids(byType).includes(Number(special18.body?.data?.id)),
        show(byType));
    const byException = await api('GET', `/credit-applications?requires_price_exception=true&created_by=${uVendedorA.id}&pageSize=100`, { token: admin });
    check('Filtro por solicitudes que requieren excepción de precio',
        ids(byException).includes(app1.id) && (byException.body?.data ?? []).every((row) => row.requires_price_exception === true));
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Guatemala' }).format(new Date());
    const byDate = await listFor(admin, `&from=${today}&to=${today}`);
    check('Filtro por fecha (hoy en Guatemala)', ids(byDate).includes(app1.id), show(byDate));
    const byOldDate = await listFor(admin, '&from=2000-01-01&to=2000-01-02');
    check('Filtro por fechas sin resultados', byOldDate.status === 200 && ids(byOldDate).length === 0);
    const byDpi = await api('GET', `/credit-applications?search=${dpiBase}01`, { token: admin });
    check('Búsqueda por DPI', ids(byDpi).includes(app1.id), show(byDpi));
    const byName = await api('GET', `/credit-applications?search=${encodeURIComponent('maría josé peña')}`, { token: admin });
    check('Búsqueda por nombre con tildes (normalizada)', ids(byName).includes(app1.id));
    const byWildcard = await api('GET', `/credit-applications?search=${encodeURIComponent('%')}&customer_id=${customerId}`, { token: admin });
    check('La búsqueda trata % como texto literal', byWildcard.status === 200 && ids(byWildcard).length === 0, show(byWildcard));
    const paged = await api('GET', `/credit-applications?customer_id=${customerId}&pageSize=1&page=1`, { token: admin });
    check('Paginación', ids(paged).length === 1 && paged.body?.pagination?.total >= 3, JSON.stringify(paged.body?.pagination));
    check('Estado inválido -> 422', (await listFor(admin, '&status=ACTIVA')).status === 422);
    check('Rango de fechas invertido -> 422', (await listFor(admin, '&from=2026-02-01&to=2026-01-01')).status === 422);
    check('Parámetro desconocido -> 422', (await listFor(admin, '&foo=1')).status === 422);
    check('El listado no expone costos al vendedor', (vA.body?.data ?? []).every((row) => !('cost_snapshot' in row)));

    // ================================================== 8. DOBLE ENVÍO
    console.log('\n[8] Protección contra doble envío (Idempotency-Key)');

    const key = `prueba-${stamp}-uno`;
    const dupBody = { customer_id: customerNoZoneId, items: [item({ proposed_price: '2222.00' })] };
    const countFor = async () =>
        (await pool.query('SELECT COUNT(*)::int AS n FROM credit_applications WHERE customer_id = $1', [customerNoZoneId])).rows[0].n;
    const before = await countFor();
    const first = await post(dupBody, vendedorA, { 'Idempotency-Key': key });
    const second = await post(dupBody, vendedorA, { 'Idempotency-Key': key });
    check('Primer envío con clave -> 201', first.status === 201 && first.body?.replayed === false, show(first));
    check('Reenvío con la misma clave -> 200, misma solicitud, marcada como reenvío',
        second.status === 200 && second.body?.replayed === true && second.body?.data?.id === first.body?.data?.id, show(second));
    check('El reenvío no crea otra fila', (await countFor()) === before + 1);
    const conflict = await post({ ...dupBody, items: [item({ proposed_price: '2333.00' })] }, vendedorA, { 'Idempotency-Key': key });
    check('Misma clave con datos distintos -> 409', conflict.status === 409 && conflict.body?.error?.code === 'CONFLICT', show(conflict));
    const otherUser = await post(dupBody, vendedorA2, { 'Idempotency-Key': key });
    check('La clave es por usuario: otro vendedor con la misma clave crea la suya (201)', otherUser.status === 201, show(otherUser));

    const raceKey = `prueba-${stamp}-carrera`;
    const beforeRace = await countFor();
    const race = await Promise.all([1, 2, 3].map(() => post(dupBody, vendedorA, { 'Idempotency-Key': raceKey })));
    const raceIds = new Set(race.map((r) => r.body?.data?.id));
    check('Tres envíos simultáneos con la misma clave: una sola solicitud',
        race.every((r) => [200, 201].includes(r.status)) && raceIds.size === 1 && (await countFor()) === beforeRace + 1,
        race.map((r) => r.status).join(','));
    check('Exactamente uno de los envíos simultáneos es la creación (201)', race.filter((r) => r.status === 201).length === 1);
    const badKey = await post(dupBody, vendedorA, { 'Idempotency-Key': 'x' });
    check('Clave con formato inválido -> 422', badKey.status === 422, show(badKey));
    const beforeNoKey = await countFor();
    await post(dupBody, vendedorA);
    await post(dupBody, vendedorA);
    check('Sin clave no hay deduplicación (regla comercial de duplicados: PENDIENTE DE DISEÑO)', (await countFor()) === beforeNoKey + 2);

    // ================================================== 9. BASE DE DATOS
    console.log('\n[9] Red de seguridad en base de datos');

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const { rows } = await client.query(
            `INSERT INTO credit_applications (customer_id, branch_id, created_by, customer_dpi_snapshot,
                customer_full_name_snapshot, customer_phone_snapshot, customer_address_snapshot, employer_name_snapshot,
                customer_email_snapshot)
             VALUES ($1, $2, $3, '1234567890123', '  josé   peña ', '55554444', 'zona   1', 'fábrica ñandú', ' Ana@Correo.COM ')
             RETURNING customer_full_name_snapshot, customer_address_snapshot, employer_name_snapshot, customer_email_snapshot`,
            [customerId, branchA, adminId]
        );
        check('El trigger normaliza aunque se inserte por SQL directo (y conserva la Ñ)',
            rows[0].customer_full_name_snapshot === 'JOSE PEÑA' && rows[0].customer_address_snapshot === 'ZONA 1' &&
                rows[0].employer_name_snapshot === 'FABRICA ÑANDU' && rows[0].customer_email_snapshot === 'ana@correo.com',
            JSON.stringify(rows[0]));
    } finally {
        await client.query('ROLLBACK');
        client.release();
    }

    const { rows: perms } = await pool.query(
        `SELECT role_code, permission_code FROM role_permissions WHERE permission_code LIKE 'credits.%' ORDER BY 1, 2`
    );
    const has = (role, perm) => perms.some((p) => p.role_code === role && p.permission_code === perm);
    check('Matriz: vendedor create + view.own; cobrador verify + view.branch; gerencia view + decide',
        has('vendedor', 'credits.create') && has('vendedor', 'credits.view.own') && !has('vendedor', 'credits.view') &&
            has('cobrador', 'credits.verify') && has('cobrador', 'credits.view.branch') && !has('cobrador', 'credits.view') &&
            has('gerencia', 'credits.view') && has('gerencia', 'credits.decide') && !has('gerencia', 'credits.create'),
        JSON.stringify(perms));
    check('Nadie fuera de Administración y Gerencia puede decidir',
        perms.filter((p) => p.permission_code === 'credits.decide').every((p) => ['admin', 'gerencia'].includes(p.role_code)));
    const { rows: verifRole } = await pool.query(`SELECT COUNT(*)::int AS n FROM roles WHERE code = 'verificador'`);
    check('El rol verificador no existe', verifRole[0].n === 0);

    check('Ninguna petición terminó en error 500', serverErrors.length === 0, serverErrors.join(' | '));
}

main()
    .catch((error) => {
        failed += 1;
        console.error(`\n${c.bad}Error ejecutando la prueba:${c.off}`, error.message);
    })
    .finally(async () => {
        await closePool();
        console.log(`\n=== Resultado: ${passed} correctas, ${failed} fallidas ===\n`);
        process.exit(failed === 0 ? 0 : 1);
    });
