/**
 * Prueba de los BLOQUES 3.2 y 3.3: flujo de crédito.
 *
 *   3.2  reconfirmación del cliente, verificación (Cobrador), modificación de
 *        condiciones y decisión (Administración/Gerencia), excepciones por
 *        línea, cancelación, crédito excepcional a precio de contado.
 *   3.3  venta concretada desde la solicitud aprobada (ver sección 3.3).
 *
 * Contra la API en ejecución, con usuarios, sucursal, clientes y productos
 * propios (sufijo único). Usa la base de datos solo para preparar planes y
 * comprobar protecciones e historiales.
 *
 *   npm run test:credit-flow
 */
import { pool, closePool } from '../config/db.js';

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
 * Cada suite se presenta como un cliente distinto (su propia IP simulada), igual
 * que lo serían dos sucursales. El limitador de login NO se desactiva ni se
 * relaja: sigue contando igual que en producción, y el backend solo hace caso
 * de esta cabecera cuando quien conecta es de confianza según TRUST_PROXY.
 * Gracias a esto varias suites corren seguidas sin reiniciar el backend.
 */
const SUITE_IP = '198.18.10.5';

async function api(method, path, { body, token, headers = {} } = {}) {
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

const show = (r) => `estado ${r.status} ${JSON.stringify(r.body?.error ?? r.body?.data ?? r.body).slice(0, 400)}`;
const login = async (username, password) =>
    (await api('POST', '/auth/login', { body: { username, password } })).body?.data?.token ?? '';
const dbError = async (sql, params = []) => {
    try {
        await pool.query(sql, params);
        return null;
    } catch (error) {
        return error;
    }
};

const stamp = Date.now().toString().slice(-7);
const CHECK_OK = { address_matches: 'SI', housing_verified: 'SI', residence_time_matches: 'SI' };

async function main() {
    console.log(`\n=== Flujo de crédito (3.2 / 3.3) contra ${BASE} ===\n`);

    // ============================================================ PREPARACIÓN
    console.log('[0] Preparación');
    const admin = await login(ADMIN_USER, ADMIN_PASS);
    if (!admin) throw new Error('Sin sesión de administrador. ¿Ejecutaste `npm run seed`?');
    const gerencia = await login('gerencia', TEST_PASS);
    check('Administración y Gerencia inician sesión', Boolean(admin && gerencia));

    const branchA = Number((await pool.query('SELECT id FROM branches WHERE is_default')).rows[0].id);
    const branchBRes = await api('POST', '/branches', { token: admin, body: { code: `WF${stamp}`, name: `Sucursal Flujo ${stamp}` } });
    const branchB = Number(branchBRes.body?.data?.id);

    const mkUser = async (prefix, role, branchId) => {
        const username = `${prefix}${stamp}`;
        const r = await api('POST', '/users', {
            token: admin,
            body: { username, full_name: `Flujo ${prefix}`, password: TEST_PASS, role, branch_id: branchId },
        });
        return { id: Number(r.body?.data?.id), username };
    };
    const uVA = await mkUser('wv_a', 'vendedor', branchA);
    const uVA2 = await mkUser('wv_b', 'vendedor', branchA);
    const uCA = await mkUser('wc_a', 'cobrador', branchA);
    const uCB = await mkUser('wc_b', 'cobrador', branchB);
    const vA = await login(uVA.username, TEST_PASS);
    const vA2 = await login(uVA2.username, TEST_PASS);
    const cA = await login(uCA.username, TEST_PASS);
    const cB = await login(uCB.username, TEST_PASS);
    check('Usuarios de prueba (2 vendedores y 2 cobradores en dos sucursales)', [vA, vA2, cA, cB].every(Boolean) && branchB > 0);

    const dpiBase = `5${stamp.padStart(10, '0')}`;
    const mkCustomer = async (suffix, name) => {
        const r = await api('POST', '/customers', {
            token: admin,
            body: { dpi: `${dpiBase}${suffix}`, full_name: name, phone: '55556666', address: 'Zona 3 casa 10' },
        });
        return Number(r.body?.data?.id);
    };
    const cust1 = await mkCustomer('01', 'Cliente Flujo Uno');
    const cust2 = await mkCustomer('02', 'Cliente Flujo Dos');
    const cust3 = await mkCustomer('03', 'Cliente Flujo Tres');

    const mkProduct = async (code, cost, stock = 10) => {
        const r = await api('POST', '/products', {
            token: admin,
            body: { code: `${code}-${stamp}`, name: `Producto flujo ${code}`, category: 'Pruebas', cost, stock },
        });
        return Number(r.body?.data?.id);
    };
    const p1 = await mkProduct('WFA', 1000);
    const p2 = await mkProduct('WFB', 500);
    const adminId = Number((await pool.query('SELECT id FROM users WHERE lower(username) = lower($1)', [ADMIN_USER])).rows[0].id);
    await pool.query(
        `INSERT INTO product_financing_plans (product_id, installments_count, financing_percentage, minimum_price, minimum_installment, created_by)
         VALUES ($1, 12, 100.00, 2000.00, 166.67, $2)`,
        [p1, adminId]
    );
    check('Clientes, productos y plan predefinido listos', cust1 > 0 && cust2 > 0 && cust3 > 0 && p1 > 0 && p2 > 0);

    const line = (over = {}) => ({ product_id: p1, quantity: 1, financing_type: 'PREDEFINIDO', installments_count: 12, proposed_price: '2100.00', ...over });
    const createApp = (token, body) => api('POST', '/credit-applications', { token, body });
    const confirm = (token, customerId, body = {}) => api('POST', `/customers/${customerId}/confirmations`, { token, body });
    const verify = (token, id, over = {}) =>
        api('POST', `/credit-applications/${id}/verifications`, { token, body: { result: 'FAVORABLE', recommendation: 'FAVORABLE', ...CHECK_OK, ...over } });
    const decideApp = (token, id, body) => api('POST', `/credit-applications/${id}/decision`, { token, body });
    const getApp = (token, id) => api('GET', `/credit-applications/${id}`, { token });

    // ============================================================ 1. RECONFIRMACIÓN
    console.log('\n[1] Cliente existente: reconfirmación obligatoria de datos');

    const app1Res = await createApp(vA, { customer_id: cust1, proposed_down_payment: '300.00', items: [line(), line({ product_id: p2, financing_type: 'ESPECIAL', installments_count: 6, proposed_price: '800.00' })] });
    const app1 = app1Res.body?.data ?? {};
    check('Cliente nuevo: la primera solicitud no exige reconfirmación', app1Res.status === 201 && app1.customer_confirmation_id === null, show(app1Res));
    check('Nace con historial de estado (∅ → SOLICITADO) y tipo NORMAL',
        app1.status_history?.length === 1 && app1.status_history[0].to_status === 'SOLICITADO' && app1.credit_type === 'NORMAL');

    const noConfirm = await createApp(vA, { customer_id: cust1, items: [line()] });
    check('Cliente existente sin reconfirmar -> 422 con motivo CUSTOMER_RECONFIRMATION_REQUIRED',
        noConfirm.status === 422 && noConfirm.body?.error?.details?.reason === 'CUSTOMER_RECONFIRMATION_REQUIRED', show(noConfirm));

    check('El Cobrador no puede reconfirmar datos (403)', (await confirm(cA, cust1)).status === 403);
    const conf = await confirm(vA, cust1, { phone: '44443333', confirmation_notes: 'confirmado por teléfono con la señora' });
    check('El vendedor reconfirma y actualiza el teléfono (201, campos cambiados registrados, nota normalizada)',
        conf.status === 201 && conf.body?.data?.confirmation?.changed_fields?.join(',') === 'phone' &&
            conf.body?.data?.confirmation?.notes === 'CONFIRMADO POR TELEFONO CON LA SEÑORA' && conf.body?.data?.customer?.phone === '44443333',
        show(conf));
    const conf2 = await confirm(vA, cust1);
    check('Reconfirmar sin cambios también queda registrado (sin campos modificados)',
        conf2.status === 201 && conf2.body?.data?.confirmation?.changed_fields?.length === 0);
    const app2Res = await createApp(vA, { customer_id: cust1, items: [line({ proposed_price: '2000.00' })] });
    const app2 = app2Res.body?.data ?? {};
    check('Tras reconfirmar, la nueva solicitud se registra y enlaza la reconfirmación usada',
        app2Res.status === 201 && Number(app2.customer_confirmation_id) === Number(conf2.body?.data?.confirmation?.id), show(app2Res));
    check('La reconfirmación sirve UNA vez: otra solicitud vuelve a exigirla',
        (await createApp(vA, { customer_id: cust1, items: [line()] })).status === 422);

    const saleForCust2 = await api('POST', '/sales', { token: admin, body: { customer_id: cust2, payment_mode: 'contado', items: [{ product_id: p2, quantity: 1 }] } });
    const withSale = await createApp(vA, { customer_id: cust2, items: [line()] });
    check('Un cliente con ventas (sin solicitudes previas) también es cliente existente -> 422',
        saleForCust2.status === 201 && withSale.status === 422 && withSale.body?.error?.details?.reason === 'CUSTOMER_RECONFIRMATION_REQUIRED', show(withSale));
    const confList = await api('GET', `/customers/${cust1}/confirmations`, { token: vA });
    check('Historial de reconfirmaciones consultable', confList.status === 200 && confList.body?.data?.length === 2);
    const confImmutable = await dbError('UPDATE customer_confirmations SET notes = $1 WHERE customer_id = $2', ['x', cust1]);
    check('Las reconfirmaciones no se pueden modificar en la base', confImmutable?.code === '23001', confImmutable?.message);

    // ============================================================ 2. VERIFICACIÓN
    console.log('\n[2] Verificación por el Cobrador');

    check('El vendedor no verifica (403)', (await verify(vA, app1.id)).status === 403);
    check('Un cobrador de otra sucursal no ve la solicitud (404)', (await verify(cB, app1.id)).status === 404);
    const badChecklist = await api('POST', `/credit-applications/${app1.id}/verifications`, { token: cA, body: { result: 'FAVORABLE', recommendation: 'FAVORABLE' } });
    check('Checklist incompleto -> 422', badChecklist.status === 422, show(badChecklist));
    check('Latitud sin longitud -> 422', (await verify(cA, app1.id, { latitude: 14.6 })).status === 422);
    check('Enviar a evaluación una verificación NECESITA_REVISION -> 422',
        (await verify(cA, app1.id, { result: 'NECESITA_REVISION', conclude: true })).status === 422);
    const decideEarly = await decideApp(admin, app1.id, { decision: 'APROBADO' });
    check('Administración no puede decidir sin verificación (409)', decideEarly.status === 409, show(decideEarly));
    check('Tampoco se puede concluir sin verificaciones (409: aún SOLICITADO)',
        (await api('POST', `/credit-applications/${app1.id}/verifications/conclude`, { token: cA, body: {} })).status === 409);

    const v1 = await verify(cA, app1.id, { result: 'NECESITA_REVISION', recommendation: 'NECESITA_REVISION', comments: 'no se encontró a nadie', latitude: 14.634915, longitude: -90.506882 });
    check('Primera verificación -> EN_VERIFICACION automáticamente (201)',
        v1.status === 201 && v1.body?.data?.status === 'EN_VERIFICACION' && v1.body?.data?.verifications?.length === 1, show(v1));
    check('La verificación conserva checklist, coordenadas, usuario y comentario normalizado',
        v1.body?.data?.verifications?.[0]?.latitude === '14.6349150' && Number(v1.body?.data?.verifications?.[0]?.verified_by) === uCA.id &&
            v1.body?.data?.verifications?.[0]?.comments === 'NO SE ENCONTRO A NADIE');
    const concludeReview = await api('POST', `/credit-applications/${app1.id}/verifications/conclude`, { token: cA, body: {} });
    check('Con la última verificación NECESITA_REVISION no se concluye: permanece en verificación (422)', concludeReview.status === 422, show(concludeReview));
    check('Administración tampoco decide en EN_VERIFICACION (409)', (await decideApp(gerencia, app1.id, { decision: 'RECHAZADO', comment: 'no procede aun' })).status === 409);

    const v2 = await verify(cA, app1.id, { comments: 'visita completada' });
    check('Segunda verificación sin concluir: sigue EN_VERIFICACION y se conservan ambas',
        v2.status === 201 && v2.body?.data?.status === 'EN_VERIFICACION' && v2.body?.data?.verifications?.length === 2);
    const concluded = await api('POST', `/credit-applications/${app1.id}/verifications/conclude`, { token: cA, body: {} });
    check('El cobrador concluye -> EN_EVALUACION (el cobrador ya no la ve: respuesta resumida)',
        concluded.status === 200 && concluded.body?.data?.status === 'EN_EVALUACION' && concluded.body?.data?.out_of_scope === true, show(concluded));
    const { rows: appRow } = await pool.query('SELECT verification_concluded_by, verification_concluded_at FROM credit_applications WHERE id = $1', [app1.id]);
    check('Se registra quién y cuándo concluyó la verificación', Number(appRow[0].verification_concluded_by) === uCA.id && appRow[0].verification_concluded_at !== null);
    check('Una solicitud en evaluación ya no admite verificaciones (Administración -> 409)', (await verify(admin, app1.id)).status === 409);
    const verImmutable = await dbError('DELETE FROM credit_verifications WHERE credit_application_id = $1', [app1.id]);
    check('Las verificaciones no se pueden borrar en la base', verImmutable?.code === '23001', verImmutable?.message);

    // ============================================================ 3. MODIFICACIÓN
    console.log('\n[3] Modificación de condiciones por Administración / Gerencia');

    const lineP1 = app1.items.find((i) => Number(i.product_id) === p1);
    const lineP2 = app1.items.find((i) => Number(i.product_id) === p2);
    const patch = (token, id, body) => api('PATCH', `/credit-applications/${id}/conditions`, { token, body });

    // Corrección final 3.2/3.3: el vendedor creador SÍ modifica sus condiciones.
    // Antes de la decisión no hay nada que revisar; después de aprobar, la
    // modificación deja la solicitud pendiente de la última revisión ([10]).
    const modVendedor = await patch(vA, app1.id, { proposed_down_payment: '100.00', comment: 'ajuste del vendedor' });
    check('El vendedor creador SÍ modifica su solicitud antes de la decisión (200)',
        modVendedor.status === 200 && modVendedor.body?.data?.proposed_down_payment === '100.00', show(modVendedor));
    check('Antes de aprobar, modificar NO exige revisión final',
        modVendedor.body?.data?.requires_final_review === false, show(modVendedor));
    check('Otro vendedor no modifica una solicitud ajena (404)',
        (await patch(vA2, app1.id, { proposed_down_payment: '120.00', comment: 'ajeno' })).status === 404);
    check('El cobrador no modifica condiciones (403)', (await patch(cA, app1.id, { proposed_down_payment: '100.00' })).status === 403);
    check('Sin cambios indicados -> 422', (await patch(gerencia, app1.id, {})).status === 422);

    const mod1 = await patch(gerencia, app1.id, { items: [{ item_id: lineP1.id, proposed_price: '1900.00' }], proposed_down_payment: '500.00', comment: 'ajuste pedido por el cliente' });
    const m1P1 = mod1.body?.data?.items?.find((i) => Number(i.product_id) === p1) ?? {};
    check('Gerencia baja el precio de una línea y sube el enganche (200)',
        mod1.status === 200 && m1P1.proposed_unit_price === '1900.00' && mod1.body?.data?.proposed_down_payment === '500.00', show(mod1));
    check('La línea queda bajo el mínimo (precio y cuota) y la solicitud requiere excepción',
        m1P1.requires_price_exception === true && m1P1.requires_installment_exception === true && mod1.body?.data?.requires_exception === true);
    const changes1 = mod1.body?.data?.changes ?? [];
    const findChange = (list, field) => list.findLast((ch) => ch.field === field); // el cambio MÁS RECIENTE
    check('Historial: precio 2100.00 → 1900.00, cuota de línea y enganche 100.00 → 500.00, con usuario y comentario',
        findChange(changes1, 'proposed_price')?.old_value === '2100.00' && findChange(changes1, 'proposed_price')?.new_value === '1900.00' &&
            findChange(changes1, 'proposed_installment')?.new_value === '158.33' &&
            findChange(changes1, 'proposed_down_payment')?.old_value === '100.00' && findChange(changes1, 'proposed_down_payment')?.new_value === '500.00' &&
            changes1.filter((ch) => ch.comment === 'AJUSTE PEDIDO POR EL CLIENTE').every((ch) => ch.changed_by_username === 'gerencia'),
        JSON.stringify(changes1));

    const mod2 = await patch(admin, app1.id, { items: [{ item_id: lineP2.id, installments_count: 7 }] });
    const m2P2 = mod2.body?.data?.items?.find((i) => Number(i.product_id) === p2) ?? {};
    check('Administración cambia el plazo especial 6 → 7: mínimo recalculado 500 +65% = 825.00 y cuota mínima 117.86',
        mod2.status === 200 && m2P2.installments_count === 7 && m2P2.minimum_unit_price === '825.00' && m2P2.line_minimum_installment === '117.86',
        JSON.stringify(m2P2));
    const changes2 = mod2.body?.data?.changes ?? [];
    check('Historial del cambio de plazo: cuotas, porcentaje y mínimo', ['installments_count', 'financing_percentage_snapshot', 'minimum_price_snapshot'].every((f) => findChange(changes2, f)),
        JSON.stringify(changes2.map((ch) => ch.field)));
    const vendorView = await getApp(vA, app1.id);
    check('El vendedor ve el historial pero SIN los cambios de porcentaje ni costo (RN-0001)',
        vendorView.status === 200 && vendorView.body?.data?.changes?.length > 0 &&
            !vendorView.body.data.changes.some((ch) => ['financing_percentage_snapshot', 'cost_snapshot'].includes(ch.field)));

    check('Repetir los mismos valores -> 422 (no hay cambios)', (await patch(admin, app1.id, { items: [{ item_id: lineP1.id, proposed_price: '1900.00' }] })).status === 422);
    const before = (await pool.query('SELECT COUNT(*)::int AS n FROM credit_application_changes WHERE credit_application_id = $1', [app1.id])).rows[0].n;
    const tooMuch = await patch(admin, app1.id, { proposed_down_payment: '2700.00' });
    const after = (await pool.query('SELECT COUNT(*)::int AS n FROM credit_application_changes WHERE credit_application_id = $1', [app1.id])).rows[0].n;
    check('Enganche igual al total (2700.00) -> 422 y no queda ningún cambio a medias', tooMuch.status === 422 && before === after, show(tooMuch));
    check('Una línea de otra solicitud -> 422', (await patch(admin, app1.id, { items: [{ item_id: app2.items[0].id, proposed_price: '2500.00' }] })).status === 422);
    const changesImmutable = await dbError('DELETE FROM credit_application_changes WHERE credit_application_id = $1', [app1.id]);
    check('El historial de modificaciones no se puede borrar', changesImmutable?.code === '23001');

    // ============================================================ 4. DECISIÓN
    console.log('\n[4] Decisión con excepciones por línea');

    check('El vendedor no decide (403)', (await decideApp(vA, app1.id, { decision: 'APROBADO' })).status === 403);
    check('El cobrador no decide (403)', (await decideApp(cA, app1.id, { decision: 'APROBADO' })).status === 403);
    const noExc = await decideApp(admin, app1.id, { decision: 'APROBADO' });
    check('Aprobar sin autorizar las líneas bajo mínimo -> 422 con el detalle de ambas líneas',
        noExc.status === 422 && noExc.body?.error?.details?.length === 2, show(noExc));
    const partialExc = await decideApp(admin, app1.id, { decision: 'APROBADO', exceptions: [{ item_id: lineP1.id, reason: 'cliente con buen historial' }] });
    check('Autorizar solo una de las dos -> 422', partialExc.status === 422 && partialExc.body?.error?.details?.length === 1);
    check('Autorización para una línea ajena -> 422',
        (await decideApp(admin, app1.id, { decision: 'APROBADO', exceptions: [{ item_id: lineP1.id, reason: 'motivo valido' }, { item_id: lineP2.id, reason: 'motivo valido' }, { item_id: app2.items[0].id, reason: 'motivo valido' }] })).status === 422);
    check('Motivo de excepción vacío o corto -> 422',
        (await decideApp(admin, app1.id, { decision: 'APROBADO', exceptions: [{ item_id: lineP1.id, reason: 'ok' }, { item_id: lineP2.id, reason: 'motivo valido' }] })).status === 422);
    check('Rechazo sin razón -> 422', (await decideApp(admin, app1.id, { decision: 'RECHAZADO' })).status === 422);

    const approveBody = {
        decision: 'APROBADO',
        comment: 'aprobado con excepciones',
        exceptions: [
            { item_id: lineP1.id, reason: 'cliente recurrente puntual' },
            { item_id: lineP2.id, reason: 'promocion autorizada' },
        ],
    };
    const race = await Promise.all([decideApp(admin, app1.id, approveBody), decideApp(gerencia, app1.id, approveBody)]);
    const winner = race.find((r) => r.status === 201);
    check('Dos decisiones simultáneas: exactamente una se registra (201) y la otra choca (409)',
        race.filter((r) => r.status === 201).length === 1 && race.filter((r) => r.status === 409).length === 1, race.map((r) => r.status).join(','));
    const approved = winner?.body?.data ?? {};
    check('Estado APROBADO con una única decisión', approved.status === 'APROBADO' && approved.decision?.decision === 'APROBADO');
    const exc = approved.exceptions ?? [];
    check('Dos autorizaciones por línea con mínimo, propuesto, diferencia, motivo, usuario y sucursal',
        exc.length === 2 && exc.every((e) => e.exception_kind === 'PRECIO_Y_CUOTA' && e.reason && Number(e.branch_id) === branchA) &&
            exc.find((e) => Number(e.credit_application_item_id) === lineP1.id)?.unit_price_difference === '-100.00',
        JSON.stringify(exc));
    check('Historial de estados completo: SOLICITADO → EN_VERIFICACION → EN_EVALUACION → APROBADO',
        approved.status_history?.map((h) => h.to_status).join(',') === 'SOLICITADO,EN_VERIFICACION,EN_EVALUACION,APROBADO',
        approved.status_history?.map((h) => h.to_status).join(','));
    check('Decidir otra vez -> 409', (await decideApp(admin, app1.id, { decision: 'RECHAZADO', comment: 'cambio de opinion' })).status === 409);
    const itemDelete = await dbError('DELETE FROM credit_application_items WHERE id = $1', [lineP2.id]);
    check('BD: las líneas no se eliminan', itemDelete?.code === '23001');
    const badTransition = await dbError(`UPDATE credit_applications SET status = 'SOLICITADO' WHERE id = $1`, [app1.id]);
    check('BD: transición APROBADO → SOLICITADO rechazada', badTransition?.constraint === 'credit_applications_status_transition', badTransition?.message);
    const decImmutable = await dbError('UPDATE credit_decisions SET decision_comment = $1 WHERE credit_application_id = $2', ['x', app1.id]);
    check('BD: la decisión no se modifica', decImmutable?.code === '23001');
    await new Promise((r) => setTimeout(r, 300));
    const { rows: auditDecide } = await pool.query(`SELECT COUNT(*)::int AS n FROM audit_log WHERE action = 'credit_application.decide' AND entity_id = $1`, [app1.id]);
    check('La decisión queda en la bitácora', auditDecide[0].n === 1);

    const evalRes = await api('GET', `/credit-applications/${app1.id}/evaluation`, { token: gerencia });
    check('Gerencia consulta el contexto de evaluación con el historial crediticio del cliente',
        evalRes.status === 200 && evalRes.body?.data?.customer_history?.applications?.some((a) => Number(a.id) === app2.id) &&
            !evalRes.body.data.customer_history.applications.some((a) => Number(a.id) === app1.id) && evalRes.body.data.customer_history.account !== null,
        show(evalRes));
    check('El vendedor no consulta el contexto de evaluación (403)', (await api('GET', `/credit-applications/${app1.id}/evaluation`, { token: vA })).status === 403);

    // Rechazo definitivo
    const app3Res = await createApp(vA2, { customer_id: cust3, items: [line({ proposed_price: '2500.00' })] });
    const app3 = app3Res.body?.data ?? {};
    const v3 = await verify(cA, app3.id, { result: 'DESFAVORABLE', recommendation: 'DESFAVORABLE', address_matches: 'NO', conclude: true });
    check('Verificación DESFAVORABLE enviada directamente a evaluación', v3.status === 201 && v3.body?.data?.status === 'EN_EVALUACION', show(v3));
    check('Un rechazo no lleva autorizaciones de excepción -> 422',
        (await decideApp(gerencia, app3.id, { decision: 'RECHAZADO', comment: 'no califica', exceptions: [{ item_id: app3.items[0].id, reason: 'motivo valido' }] })).status === 422);
    const rejected = await decideApp(gerencia, app3.id, { decision: 'RECHAZADO', comment: 'dirección no coincide' });
    check('Gerencia rechaza con razón (conservada normalizada)',
        rejected.status === 201 && rejected.body?.data?.status === 'RECHAZADO' && rejected.body?.data?.decision?.decision_comment === 'DIRECCION NO COINCIDE', show(rejected));
    check('Un rechazo es definitivo: no se cancela ni se modifica (409)',
        (await api('POST', `/credit-applications/${app3.id}/cancel`, { token: admin, body: { reason: 'intento posterior' } })).status === 409 &&
            (await patch(admin, app3.id, { proposed_down_payment: '1.00' })).status === 409);

    // ============================================================ 5. CANCELACIÓN
    console.log('\n[5] Cancelación');
    await confirm(vA2, cust3);
    const app4 = (await createApp(vA2, { customer_id: cust3, items: [line()] })).body?.data ?? {};
    const cancelReq = (token, id, reason) => api('POST', `/credit-applications/${id}/cancel`, { token, body: reason === undefined ? {} : { reason } });
    check('Otro vendedor no ve la solicitud ajena (404)', (await cancelReq(vA, app4.id, 'no es mia')).status === 404);
    check('Gerencia no cancela (403)', (await cancelReq(gerencia, app4.id, 'motivo valido')).status === 403);
    check('Sin motivo -> 422', (await cancelReq(vA2, app4.id)).status === 422);
    const cancelled = await cancelReq(vA2, app4.id, 'el cliente desistió');
    const { rows: cancelRow } = await pool.query('SELECT cancelled_by, cancel_reason FROM credit_applications WHERE id = $1', [app4.id]);
    check('El vendedor creador cancela antes de la decisión (quién y motivo registrados)',
        cancelled.status === 200 && cancelled.body?.data?.status === 'CANCELADO' && Number(cancelRow[0].cancelled_by) === uVA2.id && cancelRow[0].cancel_reason === 'EL CLIENTE DESISTIO',
        show(cancelled));
    check('No se cancela dos veces (409)', (await cancelReq(admin, app4.id, 'otra vez')).status === 409);

    // ============================================================ 6. EXCEPCIONAL
    console.log('\n[6] Crédito excepcional a precio de contado');
    await confirm(vA, cust2);
    check('Excepcional con enganche distinto de Q0 -> 422',
        (await createApp(vA, { customer_id: cust2, credit_type: 'EXCEPCIONAL_CONTADO', proposed_down_payment: '100.00', items: [{ product_id: p1, quantity: 1 }] })).status === 422);
    check('Excepcional con plazo o precio enviados por el cliente -> 422',
        (await createApp(vA, { customer_id: cust2, credit_type: 'EXCEPCIONAL_CONTADO', items: [line()] })).status === 422);
    const exRes = await createApp(vA, { customer_id: cust2, credit_type: 'EXCEPCIONAL_CONTADO', items: [{ product_id: p1, quantity: 2 }] });
    const ex = exRes.body?.data ?? {};
    check('Excepcional registrado: precio de contado 1000 +30% = 1300.00, 1 pago, total 2600.00, enganche 0.00',
        exRes.status === 201 && ex.credit_type === 'EXCEPCIONAL_CONTADO' && ex.items?.[0]?.proposed_unit_price === '1300.00' &&
            ex.items?.[0]?.installments_count === 1 && ex.items?.[0]?.financing_type === 'CONTADO_EXCEPCIONAL' &&
            ex.total === '2600.00' && ex.proposed_down_payment === '0.00' && ex.requires_exception === false,
        show(exRes));
    check('Sus condiciones no se modifican (422)', (await patch(admin, ex.id, { proposed_down_payment: '0.00' })).status === 422);
    const exDecision = await decideApp(gerencia, ex.id, { decision: 'APROBADO', comment: 'autorizado por gerencia' });
    check('Gerencia lo aprueba directamente, sin verificación (201)', exDecision.status === 201 && exDecision.body?.data?.status === 'APROBADO', show(exDecision));

    await confirm(vA, cust2);
    const ex2 = (await createApp(vA, { customer_id: cust2, credit_type: 'EXCEPCIONAL_CONTADO', items: [{ product_id: p2, quantity: 1 }] })).body?.data ?? {};
    await decideApp(admin, ex2.id, { decision: 'APROBADO' });
    check('Una solicitud APROBADA no la cancela el vendedor (409)', (await cancelReq(vA, ex2.id, 'ya no la quiere')).status === 409);
    const adminCancel = await cancelReq(admin, ex2.id, 'aprobada pero no se concretará');
    check('Administración cancela una solicitud aprobada', adminCancel.status === 200 && adminCancel.body?.data?.status === 'CANCELADO', show(adminCancel));

    // ============================================================ 7. COTIZACIÓN
    console.log('\n[7] Cálculo en vivo');
    const quoteBody = { items: [line({ proposed_price: '1900.00' })], proposed_down_payment: '100.00' };
    const qV = await api('POST', '/credit-applications/quote', { token: vA, body: quoteBody });
    check('El vendedor obtiene mínimos y excepciones sin costo ni porcentaje',
        qV.status === 200 && qV.body?.data?.items?.[0]?.minimum_price_snapshot === '2000.00' && qV.body.data.items[0].requires_price_exception === true &&
            !('cost_snapshot' in qV.body.data.items[0]) && qV.body.data.financed_amount === '1800.00',
        show(qV));
    const qA = await api('POST', '/credit-applications/quote', { token: admin, body: quoteBody });
    check('Administración sí ve el costo en el cálculo', qA.body?.data?.items?.[0]?.cost_snapshot === '1000.00');
    check('El cobrador no cotiza (403)', (await api('POST', '/credit-applications/quote', { token: cA, body: quoteBody })).status === 403);

    // ============================================================ 8. 3.3 VENTA CONCRETADA
    console.log('\n[8] 3.3 — Venta concretada desde la solicitud aprobada');

    const { consolidateInstallments, splitLine } = await import('../services/creditSale.service.js');
    const unit = consolidateInstallments(
        [{ installments_count: 12, lineCents: 780000n }, { installments_count: 6, lineCents: 330000n }],
        '2026-01-31'
    );
    check('Cálculo: 12 x 650 + 6 x 550 → meses 1–6 = 1200.00 y 7–12 = 650.00 (12 cuotas)',
        unit.length === 12 && unit.slice(0, 6).every((i) => i.amount === '1200.00') && unit.slice(6).every((i) => i.amount === '650.00'),
        JSON.stringify(unit.map((i) => i.amount)));
    check('Cálculo: vencimientos mes a mes conservando el día (31-ene → 28-feb → 31-mar → 30-abr)',
        unit[0].dueDate === '2026-02-28' && unit[1].dueDate === '2026-03-31' && unit[2].dueDate === '2026-04-30');
    check('Cálculo: el residuo de centavos va a la última cuota de cada línea (1900 / 12)',
        splitLine(190000n, 12).slice(0, 11).every((p) => p === 15833n) && splitLine(190000n, 12)[11] === 15837n);

    const concretizeReq = (token, id, body = {}) => api('POST', `/credit-applications/${id}/concretize`, { token, body });
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Guatemala' }).format(new Date());
    const invOf = async (productId, branchId) =>
        (await pool.query('SELECT quantity FROM inventory WHERE product_id = $1 AND branch_id = $2', [productId, branchId])).rows[0]?.quantity ?? 0;

    check('El cobrador no concreta ventas (403)', (await concretizeReq(cA, app1.id)).status === 403);
    check('Otro vendedor no ve la solicitud ajena (404)', (await concretizeReq(vA2, app1.id)).status === 404);
    check('Una solicitud rechazada no se concreta (409)', (await concretizeReq(admin, app3.id)).status === 409);
    check('Una solicitud cancelada no se concreta (409)', (await concretizeReq(admin, app4.id)).status === 409);
    const overDown = await concretizeReq(vA, app1.id, { down_payment: '500.01', payment_method: 'efectivo' });
    check('Enganche real mayor que el aprobado (500.01 > 500.00) -> 422', overDown.status === 422, show(overDown));
    check('Enganche con método faltante -> 422', (await concretizeReq(vA, app1.id, { down_payment: '300.00' })).status === 422);
    check('Enganche con 3 decimales -> 422', (await concretizeReq(vA, app1.id, { down_payment: '300.001', payment_method: 'efectivo' })).status === 422);
    check('Método de pago inexistente -> 422', (await concretizeReq(vA, app1.id, { down_payment: '300.00', payment_method: 'bitcoin' })).status === 422);

    const stockP1Before = await invOf(p1, branchA);
    const stockP2Before = await invOf(p2, branchA);
    const conc = await concretizeReq(vA, app1.id, { down_payment: '300.00', payment_method: 'efectivo', payment_reference: 'caja 1' });
    const sale1 = conc.body?.data?.sale ?? {};
    const actApp1 = conc.body?.data?.application ?? {};
    check('El vendedor creador concreta la venta con enganche real MENOR al aprobado (201)', conc.status === 201, show(conc));
    check('Venta `credito` enlazada, sucursal de la solicitud, cartera del vendedor creador, fecha de hoy',
        sale1.payment_mode === 'credito' && sale1.installments_count === 12 && sale1.total === '2700.00' && sale1.sale_date === today &&
            Number(sale1.created_by) === uVA.id,
        JSON.stringify({ m: sale1.payment_mode, n: sale1.installments_count, t: sale1.total, d: sale1.sale_date, u: sale1.created_by }));
    const { rows: saleLink } = await pool.query('SELECT branch_id, credit_application_id FROM sales WHERE id = $1', [sale1.id]);
    check('La venta guarda sucursal y solicitud de origen', Number(saleLink[0]?.branch_id) === branchA && Number(saleLink[0]?.credit_application_id) === app1.id);
    check('Precios congelados de la solicitud (1900.00 y 800.00) en el detalle de la venta',
        sale1.items?.map((i) => i.unit_price).sort().join(',') === '1900.00,800.00' && sale1.items.every((i) => !('unit_cost' in i)),
        JSON.stringify(sale1.items));
    const amounts = sale1.installments?.map((i) => i.amount) ?? [];
    check('Cuotas consolidadas: meses 1–6 = 272.61, mes 7 = 272.65, meses 8–11 = 158.33, mes 12 = 158.37',
        amounts.slice(0, 6).every((a) => a === '272.61') && amounts[6] === '272.65' && amounts.slice(7, 11).every((a) => a === '158.33') && amounts[11] === '158.37',
        JSON.stringify(amounts));
    check('La suma de las cuotas es exactamente el total (sin cuota 0)',
        amounts.length === 12 && amounts.reduce((s, a) => s + Math.round(Number(a) * 100), 0) === 270000 && sale1.installments[0].number === 1);
    check('Primera cuota un mes después de la venta', sale1.installments?.[0]?.due_date === (await pool.query(`SELECT to_char(($1::date + interval '1 month')::date, 'YYYY-MM-DD') AS d`, [today])).rows[0].d);
    check('Enganche real Q300.00 registrado como pago inicial con fecha de la venta',
        sale1.payments?.length === 1 && sale1.payments[0].amount === '300.00' && sale1.payments[0].payment_date === today && sale1.payments[0].method === 'efectivo',
        JSON.stringify(sale1.payments));
    check('El enganche se aplica FIFO: cuota 1 pagada (272.61) y 27.39 a la cuota 2, sin redistribuir el resto',
        sale1.payments?.[0]?.allocations?.map((a) => `${a.installment_number}:${Number(a.amount).toFixed(2)}`).join(',') === '1:272.61,2:27.39' &&
            sale1.installments[1].balance === '245.22' && sale1.installments[2].balance === '272.61',
        JSON.stringify(sale1.payments?.[0]?.allocations));
    check('Saldo recalculado con el enganche real: 2700.00 - 300.00 = 2400.00', sale1.balance === '2400.00' && sale1.paid_amount === '300.00');
    check('Solicitud ACTIVA con venta, enganche real, quién concretó y cuándo',
        actApp1.status === 'ACTIVO' && Number(actApp1.sale_id) === Number(sale1.id) && actApp1.actual_down_payment === '300.00' &&
            Number(actApp1.concretized_by) === uVA.id && actApp1.activated_at !== null,
        JSON.stringify({ s: actApp1.status, sale: actApp1.sale_id, d: actApp1.actual_down_payment }));
    check('Historial: … → APROBADO → VENTA_CONCRETADA → ACTIVO',
        actApp1.status_history?.map((h) => h.to_status).slice(-3).join(',') === 'APROBADO,VENTA_CONCRETADA,ACTIVO');
    check('Inventario descontado en la sucursal de la solicitud',
        (await invOf(p1, branchA)) === stockP1Before - 1 && (await invOf(p2, branchA)) === stockP2Before - 1);
    const { rows: mismatch } = await pool.query('SELECT COUNT(*)::int AS n FROM v_inventory_mismatch');
    check('El inventario por sucursal sigue cuadrando con la existencia total', mismatch[0].n === 0);
    const { rows: events } = await pool.query(
        `SELECT event_type, payload FROM integration_events WHERE (aggregate = 'sale' AND aggregate_id = $1) OR (aggregate = 'payment' AND (payload->>'sale_id')::bigint = $1) ORDER BY id`,
        [sale1.id]
    );
    check('Outbox: sale.created (con la solicitud de origen) y payment.created del enganche',
        events.map((e) => e.event_type).join(',') === 'sale.created,payment.created' &&
            events[0].payload.credit_application?.id === app1.id && events[0].payload.credit_application?.down_payment === '300.00',
        JSON.stringify(events.map((e) => e.event_type)));
    check('Concretar otra vez -> 409', (await concretizeReq(admin, app1.id)).status === 409);
    check('La venta con el enganche aplicado no se anula sin anular antes el pago (409)', (await api('PATCH', `/sales/${sale1.id}/cancel`, { token: admin, body: { reason: 'prueba de anulacion' } })).status === 409);
    const ownPay = await api('POST', '/payments', { token: vA, body: { sale_id: sale1.id, amount: 100, method: 'efectivo' } });
    check('La venta queda en la cartera del vendedor creador: puede cobrarla (U6)', ownPay.status === 201, show(ownPay));
    check('Otro vendedor no cobra esa venta (403)', (await api('POST', '/payments', { token: vA2, body: { sale_id: sale1.id, amount: 1 } })).status === 403);
    await new Promise((r) => setTimeout(r, 300));
    const { rows: auditConc } = await pool.query(`SELECT COUNT(*)::int AS n FROM audit_log WHERE action = 'credit_application.concretize' AND entity_id = $1`, [app1.id]);
    check('La concreción queda en la bitácora', auditConc[0].n === 1);

    // Existencias: nunca de otra sucursal; Administración ingresa en la sucursal correcta.
    const p3 = await mkProduct('WFC', 100, 0);
    await confirm(vA2, cust3);
    const app5 = (await createApp(vA2, { customer_id: cust3, items: [line({ product_id: p3, financing_type: 'ESPECIAL', installments_count: 6, proposed_price: '200.00' })] })).body?.data ?? {};
    await verify(cA, app5.id, { conclude: true });
    const app5Approved = await decideApp(gerencia, app5.id, { decision: 'APROBADO' });
    check('Solicitud con producto sin existencias aprobada', app5Approved.body?.data?.status === 'APROBADO', show(app5Approved));
    const noStock = await concretizeReq(gerencia, app5.id);
    check('Sin existencia en la sucursal -> 422 con el detalle (disponible 0, requerido 1)',
        noStock.status === 422 && noStock.body?.error?.details?.[0]?.disponible === 0 && noStock.body?.error?.details?.[0]?.requerido === 1, show(noStock));
    const inB = await api('POST', '/inventory/adjust', { token: admin, body: { product_id: p3, branch_id: branchB, delta: 5, reason: 'ingreso' } });
    const stillNoStock = await concretizeReq(gerencia, app5.id);
    check('Con existencia SOLO en otra sucursal la venta sigue bloqueada (no toma stock ajeno)',
        inB.status === 201 || inB.status === 200 ? stillNoStock.status === 422 : false, `${inB.status} ${show(stillNoStock)}`);
    const { rows: noSale } = await pool.query('SELECT COUNT(*)::int AS n FROM sales WHERE credit_application_id = $1', [app5.id]);
    const app5Still = await getApp(admin, app5.id);
    check('El intento fallido no dejó venta ni cambió el estado', noSale[0].n === 0 && app5Still.body?.data?.status === 'APROBADO');
    await api('POST', '/inventory/adjust', { token: admin, body: { product_id: p3, branch_id: branchA, delta: 3, reason: 'ingreso' } });
    const gConc = await concretizeReq(gerencia, app5.id);
    check('Tras el ingreso en la sucursal correcta, Gerencia concreta como respaldo con enganche Q0 (sin pago)',
        gConc.status === 201 && gConc.body?.data?.sale?.payments?.length === 0 && gConc.body?.data?.sale?.balance === '200.00' &&
            Number(gConc.body?.data?.sale?.created_by) === uVA2.id && Number(gConc.body?.data?.application?.concretized_by) !== uVA2.id,
        show(gConc));
    check('Existencias: sucursal A 3 → 2, sucursal B intacta en 5', (await invOf(p3, branchA)) === 2 && (await invOf(p3, branchB)) === 5);

    // Crédito excepcional a precio de contado
    check('Excepcional con enganche distinto de Q0 -> 422', (await concretizeReq(vA, ex.id, { down_payment: '10.00', payment_method: 'efectivo' })).status === 422);
    const exConc = await concretizeReq(vA, ex.id);
    const exSale = exConc.body?.data?.sale ?? {};
    check('Excepcional concretado: un solo pago de 2600.00 al mismo día del mes siguiente, sin enganche',
        exConc.status === 201 && exSale.installments?.length === 1 && exSale.installments[0].amount === '2600.00' &&
            exSale.installments[0].due_date === (await pool.query(`SELECT to_char(($1::date + interval '1 month')::date, 'YYYY-MM-DD') AS d`, [today])).rows[0].d && exSale.payments?.length === 0,
        show(exConc));
    const { rows: control } = await pool.query('SELECT days_since_activation, requires_regularization, balance FROM v_exceptional_credit_control WHERE credit_application_id = $1', [ex.id]);
    check('Control de regularización del excepcional: 0 días, no requiere regularizar todavía',
        control.length === 1 && control[0].days_since_activation === 0 && control[0].requires_regularization === false && control[0].balance === '2600.00',
        JSON.stringify(control));

    // Ejemplo exacto del propietario con enganche aplicado FIFO
    const pRefri = await mkProduct('WFR', 3900);
    const pTv = await mkProduct('WFT', 2000);
    await pool.query(
        `INSERT INTO product_financing_plans (product_id, installments_count, financing_percentage, minimum_price, minimum_installment, created_by)
         VALUES ($1, 12, 100.00, 7800.00, 650.00, $2)`,
        [pRefri, adminId]
    );
    await confirm(vA, cust1);
    const app6 = (await createApp(vA, {
        customer_id: cust1,
        proposed_down_payment: '1500.00',
        items: [
            line({ product_id: pRefri, proposed_price: '7800.00' }),
            line({ product_id: pTv, financing_type: 'ESPECIAL', installments_count: 6, proposed_price: '3300.00' }),
        ],
    })).body?.data ?? {};
    await verify(cA, app6.id, { conclude: true });
    await decideApp(admin, app6.id, { decision: 'APROBADO' });
    const c6 = await concretizeReq(admin, app6.id, { down_payment: '1500.00', payment_method: 'deposito', payment_reference: 'BOL-123' });
    const s6 = c6.body?.data?.sale ?? {};
    check('Refrigeradora 12 x 650 + TV 6 x 550: meses 1–6 = 1200.00 y 7–12 = 650.00',
        c6.status === 201 && s6.installments?.slice(0, 6).every((i) => i.amount === '1200.00') && s6.installments?.slice(6).every((i) => i.amount === '650.00'),
        show(c6));
    check('Enganche 1500.00 FIFO: cuota 1 pagada y 300.00 a la cuota 2; saldo 9600.00',
        s6.payments?.[0]?.allocations?.map((a) => `${a.installment_number}:${Number(a.amount).toFixed(2)}`).join(',') === '1:1200.00,2:300.00' && s6.balance === '9600.00',
        JSON.stringify(s6.payments?.[0]?.allocations));

    // Concurrencia
    const pLast = await mkProduct('WFL', 100, 1);
    const approvedFor = async (vendorToken, customerId) => {
        await confirm(vendorToken, customerId);
        const a = (await createApp(vendorToken, { customer_id: customerId, items: [line({ product_id: pLast, financing_type: 'ESPECIAL', installments_count: 6, proposed_price: '200.00' })] })).body?.data ?? {};
        await verify(cA, a.id, { conclude: true });
        await decideApp(admin, a.id, { decision: 'APROBADO' });
        return a;
    };
    const appX = await approvedFor(vA, cust1);
    const appY = await approvedFor(vA2, cust3);
    const doubleSame = await Promise.all([concretizeReq(admin, appX.id), concretizeReq(gerencia, appX.id)]);
    check('La misma solicitud concretada dos veces a la vez: una venta (201) y un 409',
        doubleSame.filter((r) => r.status === 201).length === 1 && doubleSame.filter((r) => r.status === 409).length === 1,
        doubleSame.map((r) => r.status).join(','));
    const lastUnit = await concretizeReq(admin, appY.id);
    check('La última unidad ya vendida: la otra solicitud queda bloqueada por existencias (422)', lastUnit.status === 422, show(lastUnit));
    const { rows: salesX } = await pool.query('SELECT COUNT(*)::int AS n FROM sales WHERE credit_application_id = ANY($1::int[])', [[appX.id, appY.id]]);
    check('Solo existe una venta y el inventario no quedó negativo', salesX[0].n === 1 && (await invOf(pLast, branchA)) === 0);

    // ================================================== 9. DECISIONES 2026-09-17
    console.log('\n[9] Modificación después de aprobar y anulación de venta');
    await confirm(vA2, cust2);
    const app9 = (await createApp(vA2, {
        customer_id: cust2,
        items: [line({ product_id: p2, financing_type: 'ESPECIAL', installments_count: 6, proposed_price: '850.00' })],
    })).body?.data ?? {};
    await verify(cA, app9.id, { conclude: true });
    await decideApp(admin, app9.id, { decision: 'APROBADO', comment: 'aprobado sin excepciones' });
    const line9 = (await getApp(admin, app9.id)).body?.data?.items?.[0] ?? {};
    const historyLen = async (id) => (await getApp(admin, id)).body?.data?.status_history?.length ?? -1;
    const hBefore = await historyLen(app9.id);

    const m9a = await patch(admin, app9.id, { proposed_down_payment: '100.00', comment: 'cliente adelanta enganche' });
    const a9a = m9a.body?.data ?? {};
    check('Admin modifica el enganche de una solicitud APROBADA (200) y sigue APROBADA',
        m9a.status === 200 && a9a.status === 'APROBADO' && a9a.proposed_down_payment === '100.00', show(m9a));
    check('La modificación no crea otra decisión ni cambia el historial de estados',
        (await pool.query('SELECT COUNT(*)::int AS n FROM credit_decisions WHERE credit_application_id = $1', [app9.id])).rows[0].n === 1 &&
            (await historyLen(app9.id)) === hBefore);
    check('Historial del cambio posterior a la aprobación: anterior, nuevo, usuario, fecha y comentario',
        a9a.changes?.some((ch) => ch.field === 'proposed_down_payment' && ch.old_value === '0.00' && ch.new_value === '100.00' &&
            ch.changed_by_username && ch.changed_at && ch.comment === 'CLIENTE ADELANTA ENGANCHE'),
        JSON.stringify(a9a.changes));
    const { rows: auditMod } = await pool.query(`SELECT COUNT(*)::int AS n FROM audit_log WHERE action = 'credit_application.modify' AND entity_id = $1`, [app9.id]);
    await new Promise((r) => setTimeout(r, 300));
    check('La modificación posterior queda en la bitácora',
        (await pool.query(`SELECT COUNT(*)::int AS n FROM audit_log WHERE action = 'credit_application.modify' AND entity_id = $1`, [app9.id])).rows[0].n >= Math.max(1, auditMod[0].n));

    const below = await patch(gerencia, app9.id, { items: [{ item_id: line9.id, proposed_price: '700.00' }], comment: 'precio especial' });
    check('Dejar la línea bajo el mínimo sin autorizar -> 422 con la línea a autorizar',
        below.status === 422 && below.body?.error?.details?.reason === 'EXCEPTION_AUTHORIZATION_REQUIRED' &&
            below.body.error.details.items?.[0]?.item_id === Number(line9.id),
        show(below));
    check('El intento sin autorización no dejó cambios', (await getApp(admin, app9.id)).body?.data?.items?.[0]?.proposed_unit_price === '850.00');
    check('Motivo de autorización corto -> 422',
        (await patch(gerencia, app9.id, { items: [{ item_id: line9.id, proposed_price: '700.00' }], exceptions: [{ item_id: line9.id, reason: 'x' }] })).status === 422);
    check('Autorización para una línea que no queda bajo el mínimo -> 422',
        (await patch(gerencia, app9.id, { items: [{ item_id: line9.id, proposed_price: '900.00' }], exceptions: [{ item_id: line9.id, reason: 'no corresponde' }] })).status === 422);
    await confirm(vA, cust1);
    const appPre = (await createApp(vA, { customer_id: cust1, items: [line({ product_id: p2, financing_type: 'ESPECIAL', installments_count: 6, proposed_price: '850.00' })] })).body?.data ?? {};
    check('Antes de la decisión no se envían autorizaciones al modificar -> 422',
        (await patch(admin, appPre.id, { items: [{ item_id: appPre.items[0].id, proposed_price: '700.00' }], exceptions: [{ item_id: appPre.items[0].id, reason: 'autorizacion anticipada' }] })).status === 422);

    const m9b = await patch(gerencia, app9.id, {
        items: [{ item_id: line9.id, proposed_price: '700.00' }],
        exceptions: [{ item_id: line9.id, reason: 'cliente mayorista' }],
        comment: 'precio especial',
    });
    const a9b = m9b.body?.data ?? {};
    const exc9 = a9b.exceptions?.find((e) => Number(e.credit_application_item_id) === Number(line9.id));
    check('Gerencia baja el precio con autorización en la misma operación (200); sigue APROBADA',
        m9b.status === 200 && a9b.status === 'APROBADO' && a9b.items?.[0]?.proposed_unit_price === '700.00', show(m9b));
    check('Autorización de origen MODIFICACION ligada a la decisión existente, con mínimo, propuesto, diferencia, usuario y sucursal',
        exc9?.source === 'MODIFICACION' && Number(exc9.credit_decision_id) === Number(a9b.decision?.id) && exc9.minimum_unit_price === '800.00' &&
            exc9.proposed_unit_price === '700.00' && exc9.unit_price_difference === '-100.00' && exc9.authorized_by_username && Number(exc9.branch_id) === branchA,
        JSON.stringify(exc9));
    check('Sigue habiendo una única decisión', (await pool.query('SELECT COUNT(*)::int AS n FROM credit_decisions WHERE credit_application_id = $1', [app9.id])).rows[0].n === 1);

    // Manipulación directa en BD: condiciones distintas a las autorizadas bloquean la concreción.
    await pool.query('UPDATE credit_application_items SET proposed_price = 650.00 WHERE id = $1', [line9.id]);
    const tampered = await concretizeReq(admin, app9.id, { down_payment: '0.00' });
    check('Condiciones bajo el mínimo sin autorización vigente -> la concreción se bloquea (409)', tampered.status === 409, show(tampered));
    await pool.query('UPDATE credit_application_items SET proposed_price = 700.00 WHERE id = $1', [line9.id]);

    const invP2Before = await invOf(p2, branchA);
    const c9 = await concretizeReq(admin, app9.id, { down_payment: '100.00', payment_method: 'efectivo' });
    const s9 = c9.body?.data?.sale ?? {};
    check('Concreción con las condiciones modificadas: precio 700.00 y enganche 100.00',
        c9.status === 201 && s9.items?.[0]?.unit_price === '700.00' && s9.payments?.[0]?.amount === '100.00' && s9.balance === '600.00', show(c9));
    check('Ya ACTIVA no se modifica (409)', (await patch(admin, app9.id, { proposed_down_payment: '50.00' })).status === 409);
    const itemActive = await dbError('UPDATE credit_application_items SET proposed_price = 1 WHERE id = $1', [line9.id]);
    check('BD: las líneas de una solicitud ACTIVA no se pueden modificar', itemActive?.code === '23001', itemActive?.message);

    // Anulación de venta con pagos: primero se anulan los pagos.
    const cancelSaleReq = (token, id, reason = 'cliente devolvio el producto') => api('PATCH', `/sales/${id}/cancel`, { token, body: { reason } });
    const withPay = await cancelSaleReq(admin, s9.id);
    check('Venta con pagos aplicados -> 409 (anular primero los pagos)', withPay.status === 409 && /pagos/i.test(withPay.body?.error?.message ?? ''), show(withPay));
    check('El vendedor no anula la venta (403)', (await cancelSaleReq(vA2, s9.id)).status === 403);
    const payId = s9.payments?.[0]?.id;
    const voided = await api('PATCH', `/payments/${payId}/void`, { token: admin, body: { reason: 'pago revertido' } });
    const { rows: allocKept } = await pool.query('SELECT COUNT(*)::int AS n FROM payment_allocations WHERE payment_id = $1', [payId]);
    const { rows: payRow } = await pool.query('SELECT status, void_reason FROM payments WHERE id = $1', [payId]);
    check('Pago anulado: queda registrado como anulado y sus aplicaciones NO se borran',
        voided.status === 200 && payRow[0]?.status === 'anulado' && allocKept[0].n > 0, show(voided));
    const afterVoid = (await api('GET', `/sales/${s9.id}`, { token: admin })).body?.data ?? {};
    check('El pago anulado deja de contar: saldo = total (700.00)', afterVoid.balance === '700.00' && afterVoid.paid_amount === '0.00',
        JSON.stringify({ b: afterVoid.balance, p: afterVoid.paid_amount }));
    const cancelled9 = await cancelSaleReq(admin, s9.id);
    const sale9Row = (await pool.query('SELECT status, cancel_reason FROM sales WHERE id = $1', [s9.id])).rows[0];
    check('Sin pagos aplicados la venta se anula (200) y queda registrada, no borrada',
        cancelled9.status === 200 && sale9Row?.status === 'anulada' && sale9Row.cancel_reason, show(cancelled9));
    check('El stock vuelve a la sucursal de la venta', (await invOf(p2, branchA)) === invP2Before);
    const { rows: mov9 } = await pool.query(
        `SELECT branch_id, quantity FROM stock_movements WHERE sale_id = $1 AND movement = 'entrada' AND reason = 'anulacion_venta'`, [s9.id]);
    check('Movimiento de entrada por anulación en la sucursal correcta', mov9.length === 1 && Number(mov9[0].branch_id) === branchA && mov9[0].quantity === 1);
    const { rows: kept9 } = await pool.query(
        `SELECT (SELECT COUNT(*) FROM installments WHERE sale_id = $1)::int AS inst,
                (SELECT COUNT(*) FROM payments WHERE sale_id = $1)::int AS pays,
                (SELECT COUNT(*) FROM sale_items WHERE sale_id = $1)::int AS items`, [s9.id]);
    check('Cuotas, pagos y líneas de la venta se conservan', kept9[0].inst === 6 && kept9[0].pays === 1 && kept9[0].items === 1, JSON.stringify(kept9[0]));
    const { rows: ev9 } = await pool.query(`SELECT payload FROM integration_events WHERE aggregate = 'sale' AND aggregate_id = $1 AND event_type = 'sale.cancelled'`, [s9.id]);
    check('Evento sale.cancelled con la solicitud de origen', ev9.length === 1 && Number(ev9[0].payload.credit_application_id) === app9.id, JSON.stringify(ev9));
    await new Promise((r) => setTimeout(r, 300));
    const { rows: auditCancel } = await pool.query(`SELECT COUNT(*)::int AS n FROM audit_log WHERE action = 'sale.cancel' AND entity_id = $1`, [s9.id]);
    const { rows: auditVoid } = await pool.query(`SELECT COUNT(*)::int AS n FROM audit_log WHERE action = 'payment.void' AND entity_id = $1`, [payId]);
    check('Anulación de pago y de venta en la bitácora', auditCancel[0].n === 1 && auditVoid[0].n === 1, `${auditCancel[0].n} ${auditVoid[0].n}`);
    check('Anular otra vez -> 409', (await cancelSaleReq(admin, s9.id)).status === 409);
    check('No se registran pagos en la venta anulada (422)',
        (await api('POST', '/payments', { token: admin, body: { sale_id: s9.id, amount: 10, method: 'efectivo' } })).status === 422);
    const { rows: mismatch9 } = await pool.query('SELECT COUNT(*)::int AS n FROM v_inventory_mismatch');
    check('El inventario por sucursal sigue cuadrando', mismatch9[0].n === 0);

    // Venta de otra sucursal: el stock vuelve a ESA sucursal, no a la predeterminada.
    const uVB = await mkUser('wv_c', 'vendedor', branchB);
    const vB = await login(uVB.username, TEST_PASS);
    await confirm(vB, cust3);
    const appB = (await createApp(vB, { customer_id: cust3, items: [line({ product_id: p3, quantity: 2, financing_type: 'ESPECIAL', installments_count: 6, proposed_price: '200.00' })] })).body?.data ?? {};
    await verify(cB, appB.id, { conclude: true });
    await decideApp(admin, appB.id, { decision: 'APROBADO' });
    const invA = await invOf(p3, branchA);
    const invB = await invOf(p3, branchB);
    const cB9 = await concretizeReq(admin, appB.id);
    const sB = cB9.body?.data?.sale ?? {};
    check('Venta concretada en la sucursal B descuenta de B', cB9.status === 201 && (await invOf(p3, branchB)) === invB - 2, show(cB9));
    const cancelB = await cancelSaleReq(admin, sB.id);
    check('Al anularla, las 2 unidades vuelven a la sucursal B y la A no cambia',
        cancelB.status === 200 && (await invOf(p3, branchB)) === invB && (await invOf(p3, branchA)) === invA, show(cancelB));


    // ============================== 10. CORRECCIÓN FINAL 3.2/3.3 (pruebas A–T)
    console.log('\n[10] Corrección final: revisión final, líneas, permisos por usuario y anulación');

    const patch10 = (token, id, body) => api('PATCH', `/credit-applications/${id}/conditions`, { token, body });
    const reviewReq = (token, id, body) => api('POST', `/credit-applications/${id}/final-review`, { token, body });
    const cancelSale10 = (token, id, reason) =>
        api('PATCH', `/sales/${id}/cancel`, { token, body: reason === undefined ? {} : { reason } });

    /** Solicitud APROBADA lista para probar (sin excepciones pendientes). */
    const aprobadaPara = async (vendorToken, customerId, over = {}) => {
        await confirm(vendorToken, customerId);
        const a = (await createApp(vendorToken, {
            customer_id: customerId,
            items: [line({ product_id: p2, financing_type: 'ESPECIAL', installments_count: 6, proposed_price: '900.00', ...over })],
        })).body?.data ?? {};
        await verify(cA, a.id, { conclude: true });
        await decideApp(admin, a.id, { decision: 'APROBADO', comment: 'aprobado para la prueba' });
        return a;
    };

    // ---- A. Admin modifica una solicitud aprobada: sigue APROBADO
    const appA = await aprobadaPara(vA, cust1);
    const modA = await patch10(admin, appA.id, { proposed_down_payment: '50.00', comment: 'ajuste de administracion' });
    check('[A] Admin modifica una solicitud APROBADA: sigue APROBADO y sin revisión pendiente',
        modA.status === 200 && modA.body?.data?.status === 'APROBADO' &&
            modA.body?.data?.requires_final_review === false, show(modA));
    check('[A] No se creó una segunda decisión',
        (await pool.query('SELECT COUNT(*)::int AS n FROM credit_decisions WHERE credit_application_id = $1', [appA.id])).rows[0].n === 1);

    // ---- B. Gerencia modifica una solicitud aprobada: sigue APROBADO
    const modB = await patch10(gerencia, appA.id, { proposed_down_payment: '60.00', comment: 'ajuste de gerencia' });
    check('[B] Gerencia modifica una solicitud APROBADA: sigue APROBADO y sin revisión pendiente',
        modB.status === 200 && modB.body?.data?.status === 'APROBADO' &&
            modB.body?.data?.requires_final_review === false, show(modB));
    check('[B] Modificar una aprobada sin motivo -> 422',
        (await patch10(admin, appA.id, { proposed_down_payment: '70.00' })).status === 422);

    // ---- C. El vendedor modifica una aprobada: requires_final_review = true
    const modC = await patch10(vA, appA.id, { proposed_down_payment: '80.00', comment: 'el cliente cambio el enganche' });
    check('[C] El vendedor modifica una APROBADA: sigue APROBADO pero queda pendiente de revisión',
        modC.status === 200 && modC.body?.data?.status === 'APROBADO' &&
            modC.body?.data?.requires_final_review === true, show(modC));
    check('[C] La solicitud NO vuelve a verificación ni pierde su decisión',
        modC.body?.data?.status_history?.at(-1)?.to_status === 'APROBADO' &&
            modC.body?.data?.decision?.decision === 'APROBADO');
    check('[C] El cambio de la bandera queda en el historial con usuario y fecha',
        (modC.body?.data?.changes ?? []).some(
            (ch) => ch.field === 'requires_final_review' && ch.old_value === 'false' && ch.new_value === 'true' &&
                ch.changed_by_username === uVA.username && ch.changed_at
        ),
        JSON.stringify((modC.body?.data?.changes ?? []).map((c) => c.field)));
    check('[C] El cobrador no participa en esta revisión (403)',
        (await reviewReq(cA, appA.id, { result: 'CONFIRMADO' })).status === 403);
    check('[C] El vendedor tampoco se revisa a sí mismo (403)',
        (await reviewReq(vA, appA.id, { result: 'CONFIRMADO' })).status === 403);

    // ---- D. No se concreta mientras requires_final_review = true
    const concBloqueada = await api('POST', `/credit-applications/${appA.id}/concretize`, { token: vA, body: {} });
    check('[D] No se concreta con una revisión pendiente (409)',
        concBloqueada.status === 409 && concBloqueada.body?.error?.details?.reason === 'FINAL_REVIEW_REQUIRED',
        show(concBloqueada));
    check('[D] Administración tampoco puede saltarse la revisión (409)',
        (await api('POST', `/credit-applications/${appA.id}/concretize`, { token: admin, body: {} })).status === 409);
    const dbSalta = await dbError(
        `INSERT INTO sales (customer_id, sale_date, payment_mode, installments_count, subtotal, total, credit_application_id)
         VALUES ($1, app_today(), 'credito', 6, 100, 100, $2)`,
        [cust1, appA.id]
    );
    check('[D] BD: tampoco se puede insertar la venta saltándose la revisión',
        dbSalta !== null && /revis/i.test(dbSalta.message), dbSalta?.message);

    // ---- E. Administración/Gerencia hacen la revisión final
    const rechazo = await reviewReq(gerencia, appA.id, { result: 'RECHAZADO', comment: 'faltan datos del cliente' });
    check('[E] Un rechazo en la revisión final deja la venta bloqueada',
        rechazo.status === 200 && rechazo.body?.data?.requires_final_review === true, show(rechazo));
    check('[E] Rechazar sin razón -> 422', (await reviewReq(gerencia, appA.id, { result: 'RECHAZADO' })).status === 422);
    const confirma = await reviewReq(gerencia, appA.id, { result: 'CONFIRMADO', comment: 'condiciones revisadas' });
    check('[E] Gerencia confirma: requires_final_review = false y sigue APROBADO',
        confirma.status === 200 && confirma.body?.data?.requires_final_review === false &&
            confirma.body?.data?.status === 'APROBADO', show(confirma));
    const revisiones = confirma.body?.data?.final_reviews ?? [];
    check('[E] Las dos revisiones quedan auditadas con usuario, fecha/hora y resultado',
        revisiones.length === 2 && revisiones[0].result === 'RECHAZADO' && revisiones[1].result === 'CONFIRMADO' &&
            revisiones.every((r) => r.reviewed_by_username === 'gerencia' && r.reviewed_at) &&
            revisiones[1].triggered_by_username === uVA.username,
        JSON.stringify(revisiones));
    check('[E] La revisión final NO crea una segunda decisión',
        (await pool.query('SELECT COUNT(*)::int AS n FROM credit_decisions WHERE credit_application_id = $1', [appA.id])).rows[0].n === 1);
    check('[E] Revisar una solicitud sin cambios pendientes -> 409',
        (await reviewReq(admin, appA.id, { result: 'CONFIRMADO' })).status === 409);
    const revImmutable = await dbError('UPDATE credit_final_reviews SET result = $1 WHERE credit_application_id = $2', ['CONFIRMADO', appA.id]);
    check('[E] BD: una revisión final no se modifica', revImmutable?.code === '23001', revImmutable?.message);
    await new Promise((r) => setTimeout(r, 300));
    check('[E] La revisión final queda en la bitácora',
        (await pool.query(`SELECT COUNT(*)::int AS n FROM audit_log WHERE action = 'credit_application.final_review' AND entity_id = $1`, [appA.id])).rows[0].n === 2);

    const concOk = await api('POST', `/credit-applications/${appA.id}/concretize`, { token: vA, body: {} });
    check('[E] Confirmada la revisión, el vendedor concreta la venta (201)', concOk.status === 201, show(concOk));

    // ---- H. Modificación de líneas: nunca DELETE, siempre is_void
    const appH = await aprobadaPara(vA2, cust3);
    const lineaH = appH.items[0];
    const modH = await patch10(admin, appH.id, {
        add_items: [{ product_id: p1, quantity: 2, financing_type: 'ESPECIAL', installments_count: 6, proposed_price: '2600.00' }],
        items: [{ item_id: lineaH.id, quantity: 3 }],
        comment: 'se agrega un producto y sube la cantidad',
    });
    const itemsH = modH.body?.data?.items ?? [];
    check('[H] Admin agrega un producto y cambia la cantidad de otro (200)',
        modH.status === 200 && itemsH.length === 2 &&
            itemsH.find((i) => Number(i.id) === Number(lineaH.id))?.quantity === 3, show(modH));
    check('[H] El total se recalcula con la línea nueva y la cantidad nueva',
        modH.body?.data?.total === '7900.00', `total = ${modH.body?.data?.total}`);
    const nuevaH = itemsH.find((i) => Number(i.product_id) === p1);
    const modH2 = await patch10(admin, appH.id, {
        void_items: [{ item_id: nuevaH.id, reason: 'el cliente ya no quiere ese producto' }],
        comment: 'se retira el producto agregado',
    });
    const itemsH2 = modH2.body?.data?.items ?? [];
    const retirada = itemsH2.find((i) => Number(i.id) === Number(nuevaH.id));
    check('[H] La línea retirada se conserva con is_void = true (no se borra)',
        modH2.status === 200 && retirada?.is_void === true && Boolean(retirada?.voided_at), show(modH2));
    check('[H] La línea retirada deja de contar en el total',
        modH2.body?.data?.total === '2700.00', `total = ${modH2.body?.data?.total}`);
    check('[H] El retiro queda en el historial con su motivo',
        (modH2.body?.data?.changes ?? []).some(
            (ch) => ch.field === 'is_void' && ch.new_value === 'true' && ch.comment === 'EL CLIENTE YA NO QUIERE ESE PRODUCTO'
        ));
    check('[H] Retirar un producto sin motivo -> 422',
        (await patch10(admin, appH.id, { void_items: [{ item_id: lineaH.id }], comment: 'sin motivo' })).status === 422);
    check('[H] No se puede dejar la solicitud sin ninguna línea vigente',
        (await patch10(admin, appH.id, { void_items: [{ item_id: lineaH.id, reason: 'retiro la ultima linea' }], comment: 'ultima linea' })).status >= 400);
    const delItem = await dbError('DELETE FROM credit_application_items WHERE id = $1', [lineaH.id]);
    check('[H] BD: las líneas nunca se borran físicamente', delItem?.code === '23001', delItem?.message);
    const revivir = await dbError('UPDATE credit_application_items SET is_void = FALSE WHERE id = $1', [nuevaH.id]);
    check('[H] BD: una línea retirada no se reactiva', revivir?.code === '23001', revivir?.message);
    const { rows: sigueAhi } = await pool.query('SELECT COUNT(*)::int AS n FROM credit_application_items WHERE id = $1', [nuevaH.id]);
    check('[H] La fila de la línea retirada sigue en la base', sigueAhi[0].n === 1);
    const bajoMinimo = await patch10(admin, appH.id, {
        items: [{ item_id: lineaH.id, proposed_price: '700.00' }],
        comment: 'precio especial',
    });
    check('[H] Una modificación que deja la línea bajo el mínimo exige autorización (422)',
        bajoMinimo.status === 422 && bajoMinimo.body?.error?.details?.reason === 'EXCEPTION_AUTHORIZATION_REQUIRED',
        show(bajoMinimo));

    // ---- I / J. Ninguna venta de crédito nueva fuera de una solicitud aprobada
    check('[I] POST /sales con modalidad `credito` -> 422',
        (await api('POST', '/sales', { token: admin, body: { customer_id: cust1, payment_mode: 'credito', items: [{ product_id: p2, quantity: 1 }] } })).status === 422);
    check('[I] POST /sales con credito_4 -> 422',
        (await api('POST', '/sales', { token: admin, body: { customer_id: cust1, payment_mode: 'credito_4', items: [{ product_id: p2, quantity: 1 }] } })).status === 422);
    check('[I] POST /sales con credito_8 -> 422',
        (await api('POST', '/sales', { token: admin, body: { customer_id: cust1, payment_mode: 'credito_8', items: [{ product_id: p2, quantity: 1 }] } })).status === 422);
    const dbSinSolicitud = await dbError(
        `INSERT INTO sales (customer_id, sale_date, payment_mode, installments_count, subtotal, total)
         VALUES ($1, app_today(), 'credito', 6, 100, 100)`,
        [cust1]
    );
    check('[I] BD: una venta `credito` sin solicitud es imposible', dbSinSolicitud !== null, dbSinSolicitud?.message);

    await confirm(vA, cust1);
    const appJ = (await createApp(vA, {
        customer_id: cust1,
        items: [line({ product_id: p2, financing_type: 'ESPECIAL', installments_count: 6, proposed_price: '900.00' })],
    })).body?.data ?? {};
    check('[J] Solicitud SOLICITADO: no se concreta (409)',
        (await api('POST', `/credit-applications/${appJ.id}/concretize`, { token: vA, body: {} })).status === 409);
    await verify(cA, appJ.id, {});
    check('[J] Solicitud EN_VERIFICACION: no se concreta (409)',
        (await api('POST', `/credit-applications/${appJ.id}/concretize`, { token: vA, body: {} })).status === 409);
    await api('POST', `/credit-applications/${appJ.id}/verifications/conclude`, { token: cA, body: {} });
    check('[J] Solicitud EN_EVALUACION: no se concreta (409)',
        (await api('POST', `/credit-applications/${appJ.id}/concretize`, { token: vA, body: {} })).status === 409);
    const dbNoAprobada = await dbError(
        `INSERT INTO sales (customer_id, sale_date, payment_mode, installments_count, subtotal, total, credit_application_id)
         VALUES ($1, app_today(), 'credito', 6, 100, 100, $2)`,
        [cust1, appJ.id]
    );
    check('[J] BD: la venta de una solicitud no aprobada es imposible',
        dbNoAprobada !== null && /APROBADA/i.test(dbNoAprobada.message), dbNoAprobada?.message);

    // ---- K. Las ventas históricas credito_4 / credito_8 no se tocan
    const { rows: historica } = await pool.query(
        `INSERT INTO sales (customer_id, sale_date, payment_mode, installments_count, subtotal, total, created_by)
         VALUES ($1, app_today(), 'credito_4', 4, 4000, 4000, $2) RETURNING id, payment_mode, status`,
        [cust1, uVA.id]
    );
    const ventaHistorica = await api('GET', `/sales/${historica[0].id}`, { token: admin });
    check('[K] Una venta histórica credito_4 se conserva y se sigue consultando igual',
        ventaHistorica.status === 200 && ventaHistorica.body?.data?.payment_mode === 'credito_4' &&
            ventaHistorica.body?.data?.total === '4000.00' && ventaHistorica.body?.data?.status === 'activa',
        show(ventaHistorica));
    const { rows: modosHist } = await pool.query(
        `SELECT payment_mode, COUNT(*)::int AS n FROM sales GROUP BY payment_mode ORDER BY payment_mode`
    );
    check('[K] Las modalidades históricas siguen siendo válidas en la base',
        modosHist.some((m) => m.payment_mode === 'credito_4'), JSON.stringify(modosHist));

    // ---- F / G. Cobrador sin y con permisos adicionales de vendedor
    const permReq = (token, id, body) => api('PUT', `/users/${id}/permissions`, { token, body });
    const uCV = await mkUser('wc_v', 'cobrador', branchA);
    const cV = await login(uCV.username, TEST_PASS);
    const ventaContado = (token) =>
        api('POST', '/sales', { token, body: { customer_id: cust1, payment_mode: 'contado', items: [{ product_id: p2, quantity: 1 }] } });
    check('[F] Un cobrador normal no registra ventas (403)', (await ventaContado(cV)).status === 403);
    const appG = await aprobadaPara(vA2, cust2);
    check('[F] Un cobrador normal no concreta ventas (403)',
        (await api('POST', `/credit-applications/${appG.id}/concretize`, { token: cV, body: {} })).status === 403);
    check('[F] Un cobrador no puede conceder permisos (403)',
        (await permReq(cV, uCV.id, { permission_code: 'sales.create', effect: 'GRANT', reason: 'autoconcesion' })).status === 403);

    const grant = await permReq(admin, uCV.id, { permission_code: 'sales.create', effect: 'GRANT', reason: 'cobrador que tambien vende en la sucursal A' });
    check('[G] Administración concede `sales.create` a ese cobrador (200)',
        grant.status === 200 && grant.body?.data?.effective_permissions?.includes('sales.create'), show(grant));
    check('[G] Se registra quién concedió, qué permiso, a quién y cuándo',
        (grant.body?.data?.user_permissions ?? []).some(
            (up) => up.permission_code === 'sales.create' && up.effect === 'GRANT' &&
                up.granted_by_username === ADMIN_USER && up.granted_at && up.reason
        ),
        JSON.stringify(grant.body?.data?.user_permissions));
    check('[G] El permiso surte efecto de inmediato, sin volver a entrar', (await ventaContado(cV)).status === 201);
    check('[G] Sigue sin poder concretar: ese es otro permiso (403)',
        (await api('POST', `/credit-applications/${appG.id}/concretize`, { token: cV, body: {} })).status === 403);
    await permReq(admin, uCV.id, { permission_code: 'credits.concretize.own', effect: 'GRANT', reason: 'concreta sus propias solicitudes' });
    // Con `credits.concretize.own` solo podría concretar las SUYAS. La ajena
    // además queda fuera de su alcance de consulta, así que responde 404: no
    // se confirma la existencia de un expediente que no le corresponde.
    check('[G] Con `credits.concretize.own` sigue sin concretar las AJENAS (404)',
        (await api('POST', `/credit-applications/${appG.id}/concretize`, { token: cV, body: {} })).status === 404);
    check('[G] Un permiso inexistente se rechaza (422)',
        (await permReq(admin, uCV.id, { permission_code: 'ventas.inventadas', effect: 'GRANT', reason: 'permiso inventado' })).status === 422);
    check('[G] Conceder dos veces el mismo permiso -> 409',
        (await permReq(admin, uCV.id, { permission_code: 'sales.create', effect: 'GRANT', reason: 'repetido' })).status === 409);
    const revoke = await permReq(admin, uCV.id, { permission_code: 'sales.create', effect: 'REVOKE', reason: 'se retira la capacidad de vender' });
    check('[G] REVOKE retira el permiso de inmediato',
        revoke.status === 200 && !revoke.body?.data?.effective_permissions?.includes('sales.create') &&
            (await ventaContado(cV)).status === 403, show(revoke));
    const clear = await api('DELETE', `/users/${uCV.id}/permissions`, { token: admin, body: { permission_code: 'sales.create', reason: 'vuelve a los permisos de su rol' } });
    check('[G] Al quitar la excepción vuelve exactamente a los permisos de su rol',
        clear.status === 200 && !clear.body?.data?.effective_permissions?.includes('sales.create'), show(clear));
    check('[G] El historial conserva concesión, revocación y retiro',
        (clear.body?.data?.history ?? []).filter((h) => h.permission_code === 'sales.create').map((h) => h.action).sort().join(',') ===
            'CONCEDIDO,RETIRADO,REVOCADO',
        JSON.stringify((clear.body?.data?.history ?? []).map((h) => h.action)));
    await new Promise((r) => setTimeout(r, 300));
    check('[G] Cada cambio de permisos queda en la bitácora',
        (await pool.query(`SELECT COUNT(*)::int AS n FROM audit_log WHERE action IN ('user.permission.set','user.permission.clear') AND entity_id = $1`, [uCV.id])).rows[0].n >= 4);
    const permImmutable = await dbError('UPDATE user_permission_changes SET reason = $1 WHERE user_id = $2', ['x', uCV.id]);
    check('[G] BD: el historial de permisos no se modifica', permImmutable?.code === '23001', permImmutable?.message);

    // ---- Q / R. Motivo obligatorio y solo Admin/Gerencia
    const saleA = concOk.body?.data?.sale ?? {};
    check('[Q] Anular sin motivo -> 422', (await cancelSale10(admin, saleA.id)).status === 422);
    check('[Q] Un motivo demasiado corto -> 422', (await cancelSale10(admin, saleA.id, 'no')).status === 422);
    check('[R] El vendedor no anula ventas (403)', (await cancelSale10(vA, saleA.id, 'prueba de anulacion')).status === 403);
    check('[R] El cobrador no anula ventas (403)', (await cancelSale10(cA, saleA.id, 'prueba de anulacion')).status === 403);
    check('[R] Gerencia SÍ consulta la venta', (await api('GET', `/sales/${saleA.id}`, { token: gerencia })).status === 200);

    // ---- L. Anulación sin pagos: el stock vuelve a la sucursal correcta
    const invAntes = await invOf(p2, branchA);
    const anulL = await cancelSale10(gerencia, saleA.id, 'el cliente desistio de la compra');
    check('[L] Gerencia anula una venta sin pagos (200)', anulL.status === 200, show(anulL));
    check('[L] El stock vuelve a la sucursal de origen', (await invOf(p2, branchA)) === invAntes + 1);
    const { rows: mismatchL } = await pool.query('SELECT COUNT(*)::int AS n FROM v_inventory_mismatch');
    check('[L] El inventario por sucursal sigue cuadrando', mismatchL[0].n === 0);

    // ---- S. Expediente de la anulación
    const ventaAnulada = (await api('GET', `/sales/${saleA.id}`, { token: admin })).body?.data ?? {};
    check('[S] La anulación registra usuario, fecha, motivo, venta, solicitud y stock restituido',
        ventaAnulada.cancellation?.cancelled_by_username === 'gerencia' &&
            Boolean(ventaAnulada.cancellation?.cancelled_at) &&
            ventaAnulada.cancellation?.reason === 'el cliente desistio de la compra' &&
            Number(ventaAnulada.cancellation?.credit_application_id) === appA.id &&
            (ventaAnulada.cancellation?.stock_restored ?? []).length >= 1,
        JSON.stringify(ventaAnulada.cancellation));
    await new Promise((r) => setTimeout(r, 300));
    check('[S] La anulación queda en la bitácora',
        (await pool.query(`SELECT COUNT(*)::int AS n FROM audit_log WHERE action = 'sale.cancel' AND entity_id = $1`, [saleA.id])).rows[0].n === 1);
    const cancImmutable = await dbError('UPDATE sale_cancellations SET reason = $1 WHERE sale_id = $2', ['otro', saleA.id]);
    check('[S] BD: el expediente de la anulación no se modifica', cancImmutable?.code === '23001', cancImmutable?.message);

    // ---- O. Fuera de cartera activa; la solicitud pasa a VENTA_ANULADA
    const appAnulada = (await api('GET', `/credit-applications/${appA.id}`, { token: admin })).body?.data ?? {};
    check('[O] La solicitud pasa a VENTA_ANULADA y conserva su historial',
        appAnulada.status === 'VENTA_ANULADA' && Boolean(appAnulada.sale_cancelled_at) &&
            appAnulada.decision?.decision === 'APROBADO' && (appAnulada.final_reviews ?? []).length === 2 &&
            appAnulada.status_history?.at(-1)?.to_status === 'VENTA_ANULADA',
        JSON.stringify({ s: appAnulada.status, h: appAnulada.status_history?.at(-1) }));
    const cartera = await api('GET', '/payments/receivables?pageSize=100', { token: admin });
    check('[O] La venta anulada no aparece en la cartera activa',
        !(cartera.body?.data ?? []).some((v) => Number(v.id) === Number(saleA.id)), show(cartera));
    check('[O] La venta anulada sigue en el historial de ventas',
        (await api('GET', '/sales?accountStatus=anulada&pageSize=100', { token: admin })).body?.data?.some((v) => Number(v.id) === Number(saleA.id)));
    check('[O] La solicitud anulada no se reutiliza para otra venta (409)',
        (await api('POST', `/credit-applications/${appA.id}/concretize`, { token: admin, body: {} })).status === 409);
    check('[O] Tampoco se modifica ya (409)',
        (await patch10(admin, appA.id, { proposed_down_payment: '10.00', comment: 'ya no' })).status === 409);

    // ---- M. Anulación con pagos: primero los pagos, luego el stock, luego la venta
    const appM = await aprobadaPara(vA, cust1);
    const concM = await api('POST', `/credit-applications/${appM.id}/concretize`, { token: vA, body: { down_payment: '0.00' } });
    const saleM = concM.body?.data?.sale ?? {};
    check('[M] Venta concretada para la prueba de anulación con pagos', concM.status === 201, show(concM));
    const pagoM = await api('POST', '/payments', { token: vA, body: { sale_id: saleM.id, amount: 150, method: 'efectivo' } });
    const pagoMId = pagoM.body?.data?.payments?.[0]?.id;
    check('[M] La venta recibe un pago', pagoM.status === 201 && Boolean(pagoMId), show(pagoM));
    const anulConPagos = await cancelSale10(admin, saleM.id, 'devolucion del producto');
    check('[M] Con pagos aplicados la anulación se bloquea (409): primero se anulan los pagos',
        anulConPagos.status === 409 && anulConPagos.body?.error?.details?.reason === 'PAYMENTS_MUST_BE_VOIDED_FIRST',
        show(anulConPagos));
    const invAntesM = await invOf(p2, branchA);
    check('[M] El intento fallido no devolvió stock ni anuló la venta',
        invAntesM === (await invOf(p2, branchA)) &&
            (await api('GET', `/sales/${saleM.id}`, { token: admin })).body?.data?.status === 'activa');
    check('[M] Gerencia no anula pagos: eso es de Administración (403)',
        (await api('PATCH', `/payments/${pagoMId}/void`, { token: gerencia, body: { reason: 'intento de gerencia' } })).status === 403);
    const voidM = await api('PATCH', `/payments/${pagoMId}/void`, { token: admin, body: { reason: 'pago revertido para anular la venta' } });
    check('[M] Administración anula el pago por su proceso formal', voidM.status === 200, show(voidM));
    const anulM = await cancelSale10(admin, saleM.id, 'devolucion del producto');
    check('[M] Anulados los pagos, la venta se anula y el stock vuelve (200)',
        anulM.status === 200 && (await invOf(p2, branchA)) === invAntesM + 1, show(anulM));
    const { rows: conservadoM } = await pool.query(
        `SELECT (SELECT COUNT(*) FROM payments WHERE sale_id = $1)::int AS pagos,
                (SELECT COUNT(*) FROM payment_allocations pa JOIN payments p ON p.id = pa.payment_id WHERE p.sale_id = $1)::int AS aplicaciones,
                (SELECT COUNT(*) FROM installments WHERE sale_id = $1)::int AS cuotas,
                (SELECT COUNT(*) FROM sale_items WHERE sale_id = $1)::int AS lineas`,
        [saleM.id]
    );
    check('[M] No se borra nada: pagos, aplicaciones, cuotas y líneas se conservan',
        conservadoM[0].pagos === 1 && conservadoM[0].aplicaciones > 0 && conservadoM[0].cuotas === 6 && conservadoM[0].lineas === 1,
        JSON.stringify(conservadoM[0]));
    const ventaM = (await api('GET', `/sales/${saleM.id}`, { token: admin })).body?.data ?? {};
    check('[M] El expediente refleja el impacto económico revertido',
        ventaM.cancellation?.payments_voided_count === 1 && ventaM.cancellation?.payments_voided_amount === '150.00',
        JSON.stringify(ventaM.cancellation));

    // ---- N. Enganche revertido correctamente
    const appN = await aprobadaPara(vA, cust1, { proposed_price: '1200.00' });
    await patch10(admin, appN.id, { proposed_down_payment: '300.00', comment: 'enganche aprobado' });
    const concN = await api('POST', `/credit-applications/${appN.id}/concretize`, {
        token: admin, body: { down_payment: '300.00', payment_method: 'efectivo' },
    });
    const saleN = concN.body?.data?.sale ?? {};
    check('[N] Venta con enganche real de Q300.00 concretada',
        concN.status === 201 && saleN.paid_amount === '300.00' && saleN.balance === '900.00', show(concN));
    const engancheId = saleN.payments?.[0]?.id;
    check('[N] La venta con enganche no se anula sin revertir el enganche (409)',
        (await cancelSale10(admin, saleN.id, 'anulacion con enganche')).status === 409);
    const voidEnganche = await api('PATCH', `/payments/${engancheId}/void`, { token: admin, body: { reason: 'se revierte el enganche' } });
    const saleNTrasVoid = (await api('GET', `/sales/${saleN.id}`, { token: admin })).body?.data ?? {};
    check('[N] Revertido el enganche, el saldo vuelve al total y el pago queda anulado (no borrado)',
        voidEnganche.status === 200 && saleNTrasVoid.paid_amount === '0.00' && saleNTrasVoid.balance === '1200.00' &&
            saleNTrasVoid.payments?.[0]?.status === 'anulado' && Boolean(saleNTrasVoid.payments?.[0]?.void_reason),
        JSON.stringify({ p: saleNTrasVoid.paid_amount, b: saleNTrasVoid.balance }));
    const anulN = await cancelSale10(admin, saleN.id, 'anulacion con enganche revertido');
    const ventaN = (await api('GET', `/sales/${saleN.id}`, { token: admin })).body?.data ?? {};
    check('[N] La anulación deja constancia del enganche revertido',
        anulN.status === 200 && ventaN.cancellation?.down_payment_reverted === '300.00' &&
            ventaN.cancellation?.payments_voided_amount === '300.00',
        JSON.stringify(ventaN.cancellation));
    check('[N] El expediente de la solicitud conserva el enganche y pasa a VENTA_ANULADA',
        (await api('GET', `/credit-applications/${appN.id}`, { token: admin })).body?.data?.status === 'VENTA_ANULADA');

    // ---- P. El excepcional anulado sale del control de regularización
    await confirm(vA, cust2);
    const appP = (await createApp(vA, { customer_id: cust2, credit_type: 'EXCEPCIONAL_CONTADO', proposed_down_payment: '0.00', items: [{ product_id: p2, quantity: 1 }] })).body?.data ?? {};
    await decideApp(admin, appP.id, { decision: 'APROBADO', comment: 'excepcional autorizado' });
    const concP = await api('POST', `/credit-applications/${appP.id}/concretize`, { token: vA, body: {} });
    const saleP = concP.body?.data?.sale ?? {};
    const { rows: controlAntes } = await pool.query('SELECT COUNT(*)::int AS n FROM v_exceptional_credit_control WHERE credit_application_id = $1', [appP.id]);
    check('[P] El crédito excepcional activo aparece en el control de regularización',
        concP.status === 201 && controlAntes[0].n === 1, show(concP));
    await cancelSale10(admin, saleP.id, 'el cliente devolvio el producto');
    const { rows: controlDespues } = await pool.query('SELECT COUNT(*)::int AS n FROM v_exceptional_credit_control WHERE credit_application_id = $1', [appP.id]);
    check('[P] Anulada la venta, el excepcional sale del control de regularización', controlDespues[0].n === 0);
    check('[P] Y ya no figura como crédito activo',
        (await api('GET', `/credit-applications/${appP.id}`, { token: admin })).body?.data?.status === 'VENTA_ANULADA');

    // ---- T. Concurrencia: pago contra anulación
    const appT = await aprobadaPara(vA, cust1);
    const concT = await api('POST', `/credit-applications/${appT.id}/concretize`, { token: vA, body: {} });
    const saleT = concT.body?.data?.sale ?? {};
    const [resPago, resAnul] = await Promise.all([
        api('POST', '/payments', { token: vA, body: { sale_id: saleT.id, amount: 50, method: 'efectivo' } }),
        cancelSale10(admin, saleT.id, 'anulacion simultanea con un pago'),
    ]);
    const ventaT = (await api('GET', `/sales/${saleT.id}`, { token: admin })).body?.data ?? {};
    const pagosAplicadosT = (ventaT.payments ?? []).filter((p) => p.status === 'aplicado').length;
    check('[T] Pago y anulación simultáneos: nunca quedan una venta anulada Y un pago aplicado',
        !(ventaT.status === 'anulada' && pagosAplicadosT > 0),
        JSON.stringify({ venta: ventaT.status, pago: resPago.status, anulacion: resAnul.status, aplicados: pagosAplicadosT }));
    check('[T] Exactamente una de las dos operaciones prospera',
        (resPago.status === 201) !== (resAnul.status === 200),
        `pago ${resPago.status} / anulación ${resAnul.status}`);
    const { rows: mismatchT } = await pool.query('SELECT COUNT(*)::int AS n FROM v_inventory_mismatch');
    check('[T] El inventario sigue cuadrando tras la concurrencia', mismatchT[0].n === 0);

    check('Ninguna petición terminó en error 500', serverErrors.length === 0, serverErrors.join(' | '));
}

main()
    .catch((error) => {
        failed += 1;
        console.error(`\n${c.bad}Error ejecutando la prueba:${c.off}`, error.stack);
    })
    .finally(async () => {
        await closePool();
        console.log(`\n=== Resultado: ${passed} correctas, ${failed} fallidas ===\n`);
        process.exit(failed === 0 ? 0 : 1);
    });
