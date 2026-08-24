/**
 * Prueba de humo del flujo operativo completo, contra la API en ejecución:
 *
 *   login -> cliente -> producto -> venta -> stock -> pago -> saldo -> evento
 *
 * Incluye casos negativos (duplicados, datos inválidos, stock insuficiente,
 * sobrepago, acceso sin token) y verificación aritmética de precios y cuotas.
 *
 *   npm run test:flow            (usa http://localhost:4000)
 *   API_URL=... npm run test:flow
 */
const BASE = (process.env.API_URL ?? 'http://localhost:4000').replace(/\/$/, '') + '/api';
const USER = process.env.SEED_ADMIN_USERNAME ?? 'admin';
const PASS = process.env.SEED_ADMIN_PASSWORD ?? 'Admin123!';

let token = '';
let passed = 0;
let failed = 0;

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

async function api(method, path, body, useToken = true) {
    const res = await fetch(BASE + path, {
        method,
        headers: {
            'Content-Type': 'application/json',
            ...(useToken && token ? { Authorization: `Bearer ${token}` } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
    });
    let json = null;
    try {
        json = await res.json();
    } catch {
        /* respuesta sin cuerpo */
    }
    return { status: res.status, body: json };
}

const q = (n) => Number(n).toFixed(2);
const stamp = Date.now().toString().slice(-7);

async function main() {
    console.log(`\n=== Prueba de flujo completo contra ${BASE} ===\n`);

    // ---------------------------------------------------------------- AUTH
    console.log('[1] Autenticación y protección de endpoints');
    const noAuth = await api('GET', '/customers', null, false);
    check('GET /customers sin token responde 401', noAuth.status === 401, `recibido ${noAuth.status}`);

    const badLogin = await api('POST', '/auth/login', { username: USER, password: 'contraseña-incorrecta' }, false);
    check('Login con contraseña incorrecta responde 401', badLogin.status === 401, `recibido ${badLogin.status}`);

    const login = await api('POST', '/auth/login', { username: USER, password: PASS }, false);
    check('Login correcto devuelve token', login.status === 200 && Boolean(login.body?.data?.token),
        JSON.stringify(login.body));
    token = login.body?.data?.token ?? '';
    if (!token) {
        console.log('\nSin token no se puede continuar. ¿Ejecutaste `npm run seed`?\n');
        process.exit(1);
    }

    // ------------------------------------------------------------ CLIENTES
    console.log('\n[2] Clientes');
    const dpi = `29${stamp}0101`.slice(0, 13).padEnd(13, '0');

    const badDpi = await api('POST', '/customers', {
        dpi: '123', full_name: 'Prueba Corta', phone: '55551234', address: 'Zona 1, Guatemala',
    });
    check('DPI de 3 dígitos es rechazado (422)', badDpi.status === 422, `recibido ${badDpi.status}`);

    const badPhone = await api('POST', '/customers', {
        dpi, full_name: 'Prueba Teléfono', phone: '123', address: 'Zona 1, Guatemala',
    });
    check('Teléfono inválido es rechazado (422)', badPhone.status === 422, `recibido ${badPhone.status}`);

    const incomplete = await api('POST', '/customers', { dpi, full_name: 'Sin Dirección' });
    check('Cliente sin teléfono ni dirección es rechazado (422)', incomplete.status === 422);

    const created = await api('POST', '/customers', {
        dpi,
        full_name: 'Cliente De Prueba Automatizada',
        phone: '5555-1234',
        address: '6a avenida 10-15 zona 9, Guatemala',
        email: 'prueba@ejemplo.com',
    });
    check('Cliente creado (201)', created.status === 201, JSON.stringify(created.body));
    const customerId = created.body?.data?.id;
    check('El teléfono se normaliza sin guiones', created.body?.data?.phone === '55551234',
        created.body?.data?.phone);

    const dup = await api('POST', '/customers', {
        dpi, full_name: 'Otro Nombre Distinto', phone: '44445555', address: 'Otra dirección cualquiera',
    });
    check('DPI duplicado es rechazado (409)', dup.status === 409, `recibido ${dup.status}`);

    const search = await api('GET', `/customers?search=${dpi}`);
    check('Búsqueda por DPI encuentra el cliente', search.body?.data?.length === 1);

    const edited = await api('PUT', `/customers/${customerId}`, { phone: '44441111' });
    check('Edición de cliente aplicada', edited.body?.data?.phone === '44441111');

    // ------------------------------------------------------------ PRODUCTOS
    console.log('\n[3] Productos y reglas de precio');
    const code = `TEST-${stamp}`;
    const COST = 1000;

    const prod = await api('POST', '/products', {
        code, name: 'Producto de Prueba', category: 'Pruebas', cost: COST, stock: 10, min_stock: 2,
    });
    check('Producto creado (201)', prod.status === 201, JSON.stringify(prod.body));
    const productId = prod.body?.data?.id;
    const p = prod.body?.data ?? {};

    check(`Precio contado = costo + 30% (Q${q(COST * 1.3)})`, q(p.price_cash) === q(COST * 1.3), `= ${p.price_cash}`);
    check(`Precio 4 pagos = costo + 50% (Q${q(COST * 1.5)})`, q(p.price_credit_4) === q(COST * 1.5), `= ${p.price_credit_4}`);
    check(`Precio 8 pagos = costo + 70% (Q${q(COST * 1.7)})`, q(p.price_credit_8) === q(COST * 1.7), `= ${p.price_credit_8}`);

    const dupCode = await api('POST', '/products', { code, name: 'Duplicado', cost: 100 });
    check('Código de producto duplicado es rechazado (409)', dupCode.status === 409, `recibido ${dupCode.status}`);

    const negCost = await api('POST', '/products', { code: `${code}-N`, name: 'Costo negativo', cost: -5 });
    check('Costo negativo es rechazado (422)', negCost.status === 422, `recibido ${negCost.status}`);

    const reprice = await api('PUT', `/products/${productId}`, { cost: 2000 });
    check('Al cambiar el costo, el precio contado se recalcula solo',
        q(reprice.body?.data?.price_cash) === q(2000 * 1.3), `= ${reprice.body?.data?.price_cash}`);
    await api('PUT', `/products/${productId}`, { cost: COST });

    // --------------------------------------------------------------- VENTAS
    console.log('\n[4] Venta a crédito de 4 pagos');
    const QTY = 3;
    const expectedUnit = COST * 1.5;
    const expectedTotal = expectedUnit * QTY; // 4500

    const quote = await api('POST', '/sales/quote', {
        payment_mode: 'credito_4',
        items: [{ product_id: productId, quantity: QTY }],
    });
    check(`Cotización: total esperado Q${q(expectedTotal)}`, q(quote.body?.data?.total) === q(expectedTotal),
        `= ${quote.body?.data?.total}`);
    check('Cotización genera 4 cuotas', quote.body?.data?.installments?.length === 4);

    const noStock = await api('POST', '/sales', {
        customer_id: customerId, payment_mode: 'contado',
        items: [{ product_id: productId, quantity: 999 }],
    });
    check('Venta con stock insuficiente es rechazada (422)', noStock.status === 422, `recibido ${noStock.status}`);

    const noItems = await api('POST', '/sales', { customer_id: customerId, payment_mode: 'contado', items: [] });
    check('Venta sin productos es rechazada (422)', noItems.status === 422, `recibido ${noItems.status}`);

    const badMode = await api('POST', '/sales', {
        customer_id: customerId, payment_mode: 'credito_6',
        items: [{ product_id: productId, quantity: 1 }],
    });
    check('Modalidad de pago inexistente es rechazada (422)', badMode.status === 422, `recibido ${badMode.status}`);

    const sale = await api('POST', '/sales', {
        customer_id: customerId,
        payment_mode: 'credito_4',
        items: [{ product_id: productId, quantity: QTY }],
        notes: 'Venta generada por la prueba automatizada',
    });
    check('Venta registrada (201)', sale.status === 201, JSON.stringify(sale.body?.error ?? ''));
    const saleId = sale.body?.data?.id;
    const s = sale.body?.data ?? {};

    check(`Total de la venta = Q${q(expectedTotal)}`, q(s.total) === q(expectedTotal), `= ${s.total}`);
    check('Se generaron 4 cuotas', s.installments?.length === 4, `= ${s.installments?.length}`);
    check('La suma de las cuotas es exactamente el total',
        q(s.installments?.reduce((a, i) => a + Number(i.amount), 0)) === q(expectedTotal));
    check(`Cada cuota vale Q${q(expectedTotal / 4)}`, q(s.installments?.[0]?.amount) === q(expectedTotal / 4),
        `= ${s.installments?.[0]?.amount}`);
    check('Saldo inicial = total', q(s.balance) === q(expectedTotal), `= ${s.balance}`);
    check("Estado de cuenta inicial = 'pendiente'", s.account_status === 'pendiente', `= ${s.account_status}`);
    check('El precio unitario guardado es el de crédito 4 pagos',
        q(s.items?.[0]?.unit_price) === q(expectedUnit), `= ${s.items?.[0]?.unit_price}`);

    const dueDates = s.installments?.map((i) => i.due_date) ?? [];
    check('Los vencimientos son mensuales y ascendentes',
        dueDates.length === 4 && dueDates.every((d, i) => i === 0 || d > dueDates[i - 1]), dueDates.join(' '));

    const afterSale = await api('GET', `/products/${productId}`);
    check(`El stock bajó de 10 a ${10 - QTY}`, afterSale.body?.data?.stock === 10 - QTY,
        `= ${afterSale.body?.data?.stock}`);

    // ---------------------------------------------------------------- PAGOS
    console.log('\n[5] Pagos, asignación a cuotas y saldo');
    const cuota = expectedTotal / 4; // 1125

    const overpay = await api('POST', '/payments', { sale_id: saleId, amount: expectedTotal + 1 });
    check('Pago mayor al saldo es rechazado (422)', overpay.status === 422, `recibido ${overpay.status}`);

    const zeroPay = await api('POST', '/payments', { sale_id: saleId, amount: 0 });
    check('Pago de cero es rechazado (422)', zeroPay.status === 422, `recibido ${zeroPay.status}`);

    const pay1 = await api('POST', '/payments', { sale_id: saleId, amount: cuota, method: 'efectivo' });
    check('Primer pago registrado (201)', pay1.status === 201, JSON.stringify(pay1.body?.error ?? ''));
    check(`Saldo tras pagar una cuota = Q${q(expectedTotal - cuota)}`,
        q(pay1.body?.data?.sale?.balance) === q(expectedTotal - cuota), `= ${pay1.body?.data?.sale?.balance}`);
    check("La cuota 1 queda 'pagada'", pay1.body?.data?.installments?.[0]?.status === 'pagada',
        `= ${pay1.body?.data?.installments?.[0]?.status}`);
    check('La cuota 2 sigue pendiente', pay1.body?.data?.installments?.[1]?.status === 'pendiente');

    // Pago parcial: debe repartirse dentro de la cuota 2
    const pay2 = await api('POST', '/payments', { sale_id: saleId, amount: 500, method: 'transferencia' });
    check('Pago parcial registrado', pay2.status === 201);
    check("La cuota 2 queda 'parcial'", pay2.body?.data?.installments?.[1]?.status === 'parcial',
        `= ${pay2.body?.data?.installments?.[1]?.status}`);
    check('El saldo de la cuota 2 es el resto',
        q(pay2.body?.data?.installments?.[1]?.balance) === q(cuota - 500),
        `= ${pay2.body?.data?.installments?.[1]?.balance}`);

    // Pago que cruza varias cuotas
    const rest = expectedTotal - cuota - 500;
    const pay3 = await api('POST', '/payments', { sale_id: saleId, amount: rest, method: 'deposito' });
    check('Pago final registrado', pay3.status === 201, JSON.stringify(pay3.body?.error ?? ''));
    check('Saldo final = 0.00', q(pay3.body?.data?.sale?.balance) === '0.00', `= ${pay3.body?.data?.sale?.balance}`);
    check("Estado de cuenta final = 'pagada'", pay3.body?.data?.sale?.account_status === 'pagada',
        `= ${pay3.body?.data?.sale?.account_status}`);
    check('Las 4 cuotas quedan pagadas',
        pay3.body?.data?.installments?.every((i) => i.status === 'pagada'));

    const extra = await api('POST', '/payments', { sale_id: saleId, amount: 1 });
    check('Pago sobre venta ya saldada es rechazado (409)', extra.status === 409, `recibido ${extra.status}`);

    const history = await api('GET', `/payments?saleId=${saleId}`);
    check('El historial muestra los 3 pagos', history.body?.data?.length === 3, `= ${history.body?.data?.length}`);
    check('La suma de los pagos es igual al total',
        q(history.body?.data?.reduce((a, x) => a + Number(x.amount), 0)) === q(expectedTotal));

    // ---------------------------------------------------- PERSISTENCIA Y CUENTA
    console.log('\n[6] Persistencia y estado de cuenta');
    const reread = await api('GET', `/sales/${saleId}`);
    check('Al releer la venta el saldo sigue en 0.00', q(reread.body?.data?.balance) === '0.00');
    check('Al releer la venta conserva sus 4 cuotas', reread.body?.data?.installments?.length === 4);

    const account = await api('GET', `/customers/${customerId}/account`);
    check('Estado de cuenta del cliente: total vendido correcto',
        q(account.body?.data?.total_sold) === q(expectedTotal), `= ${account.body?.data?.total_sold}`);
    check('Estado de cuenta del cliente: saldo 0.00', q(account.body?.data?.total_balance) === '0.00');

    const deactivate = await api('PATCH', `/customers/${customerId}/status`, { is_active: false });
    check('Se puede desactivar un cliente sin deuda', deactivate.status === 200, `recibido ${deactivate.status}`);
    await api('PATCH', `/customers/${customerId}/status`, { is_active: true });

    // ------------------------------------------------------ VENTA DE CONTADO
    console.log('\n[7] Venta de contado y bloqueo de desactivación con deuda');
    const cashSale = await api('POST', '/sales', {
        customer_id: customerId, payment_mode: 'contado',
        items: [{ product_id: productId, quantity: 1 }],
    });
    check('Venta de contado registrada', cashSale.status === 201, JSON.stringify(cashSale.body?.error ?? ''));
    check(`Total contado = Q${q(COST * 1.3)}`, q(cashSale.body?.data?.total) === q(COST * 1.3),
        `= ${cashSale.body?.data?.total}`);
    check('La venta de contado genera 1 cuota que vence el mismo día',
        cashSale.body?.data?.installments?.length === 1 &&
        cashSale.body?.data?.installments?.[0]?.due_date === cashSale.body?.data?.sale_date);

    const blocked = await api('PATCH', `/customers/${customerId}/status`, { is_active: false });
    check('No se puede desactivar un cliente con saldo pendiente (409)', blocked.status === 409,
        `recibido ${blocked.status}`);

    // ------------------------------------------------------- EVENTOS PARA n8n
    console.log('\n[8] Puente de eventos para n8n (outbox)');
    const { pool } = await import('../config/db.js');
    const { rows } = await pool.query(
        `SELECT event_type, COUNT(*)::int AS n FROM integration_events GROUP BY event_type ORDER BY event_type`
    );
    const types = Object.fromEntries(rows.map((r) => [r.event_type, r.n]));
    check('Se registró customer.created', (types['customer.created'] ?? 0) >= 1, JSON.stringify(types));
    check('Se registró sale.created', (types['sale.created'] ?? 0) >= 2);
    check('Se registró payment.created', (types['payment.created'] ?? 0) >= 3);
    check('Se registró sale.paid al saldar la venta', (types['sale.paid'] ?? 0) >= 1);

    const { rows: pend } = await pool.query(
        `SELECT COUNT(*)::int AS n FROM integration_events WHERE status = 'pendiente'`
    );
    check('Los eventos quedan pendientes sin bloquear la operación (n8n apagado)', pend[0].n > 0);
    await pool.end();

    // ------------------------------------------------------------- RESULTADO
    console.log(`\n=== Resultado: ${c.ok}${passed} correctas${c.off}, ${failed ? c.bad : ''}${failed} fallidas${c.off} ===\n`);
    process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
    console.error('\nError inesperado durante la prueba:', error);
    process.exit(1);
});
