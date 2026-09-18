/**
 * Prueba de control de acceso y bitácora, contra la API en ejecución.
 *
 * Verifica lo que exige la tesis en REQ-0010, REQ-0011, REQ-0016 y en las
 * reglas RN-0001, RN-0002, RN-0006, RN-0007 y RN-0008:
 *
 *   * cada rol entra solo a lo suyo;
 *   * el costo de los productos no sale hacia quien no debe verlo;
 *   * las operaciones quedan registradas en la bitácora;
 *   * la bitácora no se puede modificar ni borrar;
 *   * el sistema no se puede quedar sin administrador.
 *
 * Requiere el backend encendido y `npm run seed` ejecutado (crea los usuarios
 * de prueba `vendedor` y `cobrador`).
 *
 *   npm run test:security
 *   API_URL=http://localhost:4000 npm run test:security
 */
const BASE = (process.env.API_URL ?? 'http://localhost:4000').replace(/\/$/, '') + '/api';
const ADMIN_USER = process.env.SEED_ADMIN_USERNAME ?? 'admin';
const ADMIN_PASS = process.env.SEED_ADMIN_PASSWORD ?? 'Admin123!';
const DEMO_PASS = 'Prueba123';

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

/**
 * Cada suite se presenta como un cliente distinto (su propia IP simulada), igual
 * que lo serían dos sucursales. El limitador de login NO se desactiva ni se
 * relaja: sigue contando igual que en producción, y el backend solo hace caso
 * de esta cabecera cuando quien conecta es de confianza según TRUST_PROXY.
 * Gracias a esto varias suites corren seguidas sin reiniciar el backend.
 */
const SUITE_IP = '198.18.10.2';

async function api(method, path, { body, token } = {}) {
    const res = await fetch(BASE + path, {
        method,
        headers: {
            'Content-Type': 'application/json',
            'X-Forwarded-For': SUITE_IP,
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
    });
    let json = null;
    try {
        json = await res.json();
    } catch {
        /* sin cuerpo */
    }
    return { status: res.status, body: json };
}

async function login(username, password) {
    const res = await api('POST', '/auth/login', { body: { username, password } });
    return {
        token: res.body?.data?.token ?? '',
        permissions: res.body?.data?.permissions ?? [],
        id: res.body?.data?.user?.id ?? res.body?.data?.id ?? null,
        status: res.status,
    };
}

/**
 * VENTA HISTÓRICA A CRÉDITO de un vendedor concreto.
 *
 * Desde el bloque 3.3 `POST /sales` ya no registra ventas nuevas con
 * credito_4 / credito_8: un crédito nuevo nace de una solicitud APROBADA.
 * Las ventas a crédito que YA existen conservan su dueño y su cartera, y eso
 * es lo que comprueba esta sección (regla U6). La prueba las inserta como
 * fixture con los mismos modelos y utilidades del servicio histórico.
 */
async function ventaHistoricaACredito({ customerId, productId, createdBy, quantity = 1, mode = 'credito_4' }) {
    const { pool } = await import('../config/db.js');
    const Sale = await import('../models/sale.model.js');
    const Product = await import('../models/product.model.js');
    const { money, splitInstallments, toCents } = await import('../utils/money.js');
    const { buildDueDates, today } = await import('../utils/dates.js');
    const { installmentsFor, priceFieldFor } = await import('../utils/pricing.js');

    const priceField = priceFieldFor(mode);
    const count = installmentsFor(mode);
    const date = today();
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const { rows: products } = await client.query(
            `SELECT id, code, name, cost, ${priceField} AS unit_price FROM products WHERE id = $1 FOR UPDATE`,
            [productId]
        );
        const product = products[0];
        const total = money((toCents(product.unit_price) * quantity) / 100);
        const sale = await Sale.createSale(client, {
            customer_id: customerId,
            sale_date: date,
            payment_mode: mode,
            installments_count: count,
            subtotal: total,
            total,
            notes: 'Venta histórica (fixture de la prueba de seguridad)',
            created_by: createdBy,
        });
        await Sale.createItem(client, sale.id, {
            product_id: Number(product.id),
            product_code: product.code,
            product_name: product.name,
            quantity,
            unit_cost: product.cost,
            unit_price: product.unit_price,
            line_total: total,
        });
        await Product.adjustStock(client, {
            productId: Number(product.id),
            delta: -quantity,
            reason: 'venta',
            saleId: sale.id,
            userId: createdBy,
        });
        const amounts = splitInstallments(total, count);
        const dueDates = buildDueDates(date, count);
        for (let i = 0; i < count; i += 1) {
            await Sale.createInstallment(client, sale.id, {
                number: i + 1,
                dueDate: dueDates[i],
                amount: money(amounts[i]),
            });
        }
        await client.query('COMMIT');
        return Number(sale.id);
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}

const stamp = Date.now().toString().slice(-6);

async function main() {
    console.log(`\n=== Control de acceso y bitácora contra ${BASE} ===\n`);

    // ------------------------------------------------------------- SESIÓN
    console.log('[1] Inicio de sesión y permisos');

    const admin = await login(ADMIN_USER, ADMIN_PASS);
    check('El administrador inicia sesión', admin.status === 200 && Boolean(admin.token), `estado ${admin.status}`);
    if (!admin.token) {
        console.log('\nSin sesión de administrador no se puede continuar. ¿Ejecutaste `npm run seed`?\n');
        process.exit(1);
    }
    check(
        'El login devuelve la lista de permisos del rol',
        Array.isArray(admin.permissions) && admin.permissions.includes('users.manage'),
        `recibidos ${admin.permissions.length}`
    );

    const vendedor = await login('vendedor', DEMO_PASS);
    const vendedor2 = await login('vendedor2', DEMO_PASS);
    const cobrador = await login('cobrador', DEMO_PASS);
    // El rol `verificador` ya no existe (006): la verificación de créditos es
    // una función del Cobrador. `cobrador2` es el segundo cobrador de prueba.
    const cobrador2 = await login('cobrador2', DEMO_PASS);
    const gerencia = await login('gerencia', DEMO_PASS);

    check('El vendedor de prueba inicia sesión', Boolean(vendedor.token), `estado ${vendedor.status}`);
    check('El segundo vendedor inicia sesión', Boolean(vendedor2.token), `estado ${vendedor2.status}`);
    check('El cobrador de prueba inicia sesión', Boolean(cobrador.token), `estado ${cobrador.status}`);
    check('El segundo cobrador de prueba inicia sesión', Boolean(cobrador2.token), `estado ${cobrador2.status}`);
    check('Gerencia de prueba inicia sesión', Boolean(gerencia.token), `estado ${gerencia.status}`);

    if (!vendedor.token || !vendedor2.token || !cobrador.token || !cobrador2.token || !gerencia.token) {
        console.log('\nFaltan los usuarios de prueba. Ejecuta `npm run seed` en desarrollo.\n');
        process.exit(1);
    }

    check(
        'El vendedor recibe los permisos de alcance propio',
        vendedor.permissions.includes('payments.create.own') &&
            vendedor.permissions.includes('receivables.view.own') &&
            !vendedor.permissions.includes('payments.create') &&
            !vendedor.permissions.includes('receivables.view'),
        vendedor.permissions.join(', ')
    );
    check(
        'El vendedor crea solicitudes y solo consulta las propias (no todas)',
        vendedor.permissions.includes('credits.create') &&
            vendedor.permissions.includes('credits.view.own') &&
            !vendedor.permissions.includes('credits.view') &&
            !vendedor.permissions.includes('credits.verify') &&
            !vendedor.permissions.includes('credits.decide'),
        vendedor.permissions.join(', ')
    );
    check(
        'El cobrador verifica, consulta solo su sucursal y no decide ni crea créditos',
        cobrador.permissions.includes('credits.verify') &&
            cobrador.permissions.includes('credits.view.branch') &&
            !cobrador.permissions.includes('credits.view') &&
            !cobrador.permissions.includes('credits.decide') &&
            !cobrador.permissions.includes('credits.create'),
        cobrador.permissions.join(', ')
    );
    check(
        'Un segundo cobrador recibe exactamente los mismos permisos que el primero',
        cobrador2.permissions.join(',') === cobrador.permissions.join(','),
        cobrador2.permissions.join(', ')
    );
    check(
        'El cobrador recibe los permisos globales de cobranza',
        cobrador.permissions.includes('payments.create') && cobrador.permissions.includes('receivables.view'),
        cobrador.permissions.join(', ')
    );
    // ACTUALIZADO EN EL BLOQUE 2A. El bloque 1 dejó a Gerencia solo con
    // `dashboard.view`; el propietario decidió después (2026-09-11) que
    // Gerencia consulta y decide créditos y consulta costos e histórico de
    // costos. `products.view` entra porque sin poder listar el catálogo no
    // hay dónde consultar un costo. Sigue SIN clientes, ventas, pagos ni
    // cobranza, que es lo que comprueban las líneas de más abajo.
    check(
        'Gerencia tiene panel, catálogo con costos y decisión de créditos',
        ['dashboard.view', 'products.view', 'products.cost.view', 'credits.view', 'credits.decide'].every((p) =>
            gerencia.permissions.includes(p)
        ),
        gerencia.permissions.join(', ')
    );
    check(
        'Gerencia NO recibe permisos administrativos por ser Gerencia',
        !['users.manage', 'roles.manage', 'inventory.manage', 'branches.manage', 'products.update'].some((p) =>
            gerencia.permissions.includes(p)
        ),
        gerencia.permissions.join(', ')
    );
    check(
        'El cobrador verifica pero NO decide créditos; Gerencia sí decide',
        gerencia.permissions.includes('credits.decide') &&
            cobrador.permissions.includes('credits.verify') &&
            !cobrador.permissions.includes('credits.decide'),
        cobrador.permissions.join(', ')
    );

    // ------------------------------------------------- RN-0001 y RN-0002
    console.log('\n[2] RN-0001 y RN-0002: el costo solo lo ve el administrador');

    const prodAdmin = await api('GET', '/products?pageSize=5', { token: admin.token });
    const prodVend = await api('GET', '/products?pageSize=5', { token: vendedor.token });

    check(
        'El administrador SÍ recibe el costo',
        prodAdmin.status === 200 && prodAdmin.body?.data?.every((p) => p.cost !== undefined),
        `estado ${prodAdmin.status}`
    );
    check(
        'El vendedor NO recibe el costo en ningún producto',
        prodVend.status === 200 && prodVend.body?.data?.every((p) => p.cost === undefined),
        JSON.stringify(prodVend.body?.data?.[0] ?? {})
    );
    check(
        'El vendedor SÍ recibe los precios de venta autorizados',
        prodVend.body?.data?.every((p) => p.price_cash !== undefined && p.price_credit_4 !== undefined),
        'faltan precios de venta'
    );

    const preview = await api('GET', '/products/price-preview?cost=1000', { token: vendedor.token });
    check('El vendedor no puede usar la vista previa de precios (403)', preview.status === 403, `estado ${preview.status}`);

    const modesVend = await api('GET', '/sales/payment-modes', { token: vendedor.token });
    check(
        'Las modalidades no revelan el porcentaje sobre el costo al vendedor',
        modesVend.body?.data?.every((m) => m.markup === undefined && m.markup_percent === undefined),
        JSON.stringify(modesVend.body?.data?.[0] ?? {})
    );

    const modesAdmin = await api('GET', '/sales/payment-modes', { token: admin.token });
    check(
        'El administrador sí ve los porcentajes 30/50/70',
        modesAdmin.body?.data?.map((m) => m.markup_percent).join(',') === '30,50,70',
        modesAdmin.body?.data?.map((m) => m.markup_percent).join(',')
    );

    const catalogoRoles = await api('GET', '/roles', { token: admin.token });
    const codigosRoles = (catalogoRoles.body?.data ?? []).map((r) => r.role_code ?? r.code);
    check(
        'El catálogo de roles ya no contiene el rol verificador (006)',
        catalogoRoles.status === 200 && codigosRoles.includes('cobrador') && !codigosRoles.includes('verificador'),
        codigosRoles.join(', ')
    );

    // ------------------------------------------------------------ RN-0008
    console.log('\n[3] RN-0008: cada rol accede solo a sus módulos');

    const casos = [
        ['El vendedor NO puede ver la bitácora', 'GET', '/audit', vendedor.token, 403],
        ['El vendedor NO puede administrar usuarios', 'GET', '/users', vendedor.token, 403],
        ['El vendedor NO puede ver las integraciones', 'GET', '/integrations/status', vendedor.token, 403],
        ['El vendedor NO puede crear productos', 'POST', '/products', vendedor.token, 403],
        ['El vendedor NO puede ajustar inventario', 'POST', '/products/1/stock', vendedor.token, 403],
        ['El vendedor NO puede anular pagos', 'PATCH', '/payments/1/void', vendedor.token, 403],
        ['El vendedor NO puede anular ventas', 'PATCH', '/sales/1/cancel', vendedor.token, 403],
        ['El cobrador NO puede registrar ventas', 'POST', '/sales', cobrador.token, 403],
        ['El cobrador NO puede ver la bitácora', 'GET', '/audit', cobrador.token, 403],
        ['El cobrador SÍ puede consultar la cartera', 'GET', '/payments/receivables', cobrador.token, 200],
        ['El vendedor SÍ puede consultar clientes', 'GET', '/customers', vendedor.token, 200],
        ['El vendedor SÍ puede consultar SU cartera', 'GET', '/payments/receivables', vendedor.token, 200],
        ['El segundo cobrador SÍ puede consultar clientes', 'GET', '/customers', cobrador2.token, 200],
        ['El segundo cobrador SÍ puede consultar la cartera', 'GET', '/payments/receivables', cobrador2.token, 200],
        ['El segundo cobrador SÍ puede consultar pagos', 'GET', '/payments', cobrador2.token, 200],
        ['El vendedor SÍ puede listar solicitudes de crédito (las propias)', 'GET', '/credit-applications', vendedor.token, 200],
        ['El cobrador SÍ puede listar solicitudes de crédito (su sucursal)', 'GET', '/credit-applications', cobrador.token, 200],
        ['Gerencia SÍ puede listar solicitudes de crédito', 'GET', '/credit-applications', gerencia.token, 200],
        ['El cobrador NO puede crear solicitudes de crédito', 'POST', '/credit-applications', cobrador.token, 403],
        ['Gerencia NO puede crear solicitudes de crédito', 'POST', '/credit-applications', gerencia.token, 403],
        ['Gerencia SÍ puede ver el panel de inicio', 'GET', '/dashboard', gerencia.token, 200],
        ['Gerencia NO puede consultar clientes', 'GET', '/customers', gerencia.token, 403],
        // Cambiado en el bloque 2A: Gerencia consulta el catálogo porque
        // tiene que poder consultar costos e histórico de costos.
        ['Gerencia SÍ puede consultar productos', 'GET', '/products', gerencia.token, 200],
        // Corrección final 3.2/3.3 §6: Gerencia consulta ventas (supervisión,
        // revisión, concreción, anulación y auditoría). Sigue SIN pagos ni cartera.
        ['Gerencia SÍ puede consultar ventas', 'GET', '/sales', gerencia.token, 200],
        ['Gerencia NO puede consultar pagos', 'GET', '/payments', gerencia.token, 403],
        ['Gerencia NO puede consultar la cartera', 'GET', '/payments/receivables', gerencia.token, 403],
        ['El administrador SÍ puede ver la bitácora', 'GET', '/audit', admin.token, 200],
        ['El administrador SÍ puede administrar usuarios', 'GET', '/users', admin.token, 200],
        ['El administrador SÍ puede consultar la cartera completa', 'GET', '/payments/receivables', admin.token, 200],
    ];

    for (const [nombre, metodo, ruta, token, esperado] of casos) {
        const res = await api(metodo, ruta, { token, body: metodo === 'POST' ? {} : undefined });
        check(nombre, res.status === esperado, `esperado ${esperado}, recibido ${res.status}`);
    }

    const sinToken = await api('GET', '/audit');
    check('La bitácora sin token responde 401', sinToken.status === 401, `estado ${sinToken.status}`);

    // ----------------------------------------------------- ALCANCE (U6)
    console.log('\n[3b] Regla U6: el vendedor solo cobra su propia cartera');

    // Un producto activo con existencia, tomado del catálogo por el administrador.
    const catalogo = await api('GET', '/products?status=active&pageSize=50', { token: admin.token });
    const producto = (catalogo.body?.data ?? []).find((p) => p.stock >= 4);
    check('Hay un producto con existencia para la prueba', Boolean(producto), 'ejecuta `npm run seed`');

    if (producto) {
        // El vendedor 1 registra su propio cliente y su propia venta a crédito.
        const dpi = `30${stamp}0101`.slice(0, 13).padEnd(13, '0');
        const cliente = await api('POST', '/customers', {
            token: vendedor.token,
            body: {
                dpi,
                full_name: 'Cliente de Prueba de Alcance',
                phone: '55559876',
                address: 'San Francisco Zapotitlán, Suchitepéquez',
            },
        });
        check('El vendedor registra un cliente', cliente.status === 201, JSON.stringify(cliente.body?.error ?? {}));
        const clienteId = cliente.body?.data?.id;

        // Una venta a crédito NUEVA ya no se registra por aquí: nace de una
        // solicitud aprobada. Se comprueba, y las de la cartera se insertan
        // como ventas históricas del vendedor que las registró en su día.
        const intentoCredito = await api('POST', '/sales', {
            token: vendedor.token,
            body: {
                customer_id: clienteId,
                payment_mode: 'credito_4',
                items: [{ product_id: producto.id, quantity: 1 }],
            },
        });
        check('Una venta a crédito nueva no se registra en POST /sales (422)', intentoCredito.status === 422,
            `estado ${intentoCredito.status}`);

        const ventaPropiaId = await ventaHistoricaACredito({
            customerId: clienteId, productId: producto.id, createdBy: vendedor.id,
        });
        check('Existe una venta histórica a crédito del primer vendedor', Number.isFinite(ventaPropiaId));

        const ventaAjenaId = await ventaHistoricaACredito({
            customerId: clienteId, productId: producto.id, createdBy: vendedor2.id,
        });
        check('Existe una venta histórica a crédito del segundo vendedor', Number.isFinite(ventaAjenaId));

        const ventaContado = await api('POST', '/sales', {
            token: vendedor.token,
            body: {
                customer_id: clienteId,
                payment_mode: 'contado',
                items: [{ product_id: producto.id, quantity: 1 }],
            },
        });
        const ventaContadoId = ventaContado.body?.data?.id;

        // --- lo que SÍ puede
        const cobroPropio = await api('POST', '/payments', {
            token: vendedor.token,
            body: { sale_id: ventaPropiaId, amount: 1, method: 'efectivo' },
        });
        check(
            'El vendedor SÍ puede cobrar su propia venta a crédito',
            cobroPropio.status === 201,
            JSON.stringify(cobroPropio.body?.error ?? {})
        );

        // --- lo que NO puede
        const cobroAjeno = await api('POST', '/payments', {
            token: vendedor.token,
            body: { sale_id: ventaAjenaId, amount: 1, method: 'efectivo' },
        });
        check('El vendedor NO puede cobrar la venta de otro vendedor', cobroAjeno.status === 403, `estado ${cobroAjeno.status}`);
        check(
            'El rechazo explica que la venta no es de su cartera',
            /no pertenece a tu cartera/i.test(cobroAjeno.body?.error?.message ?? ''),
            cobroAjeno.body?.error?.message
        );

        const cobroContado = await api('POST', '/payments', {
            token: vendedor.token,
            body: { sale_id: ventaContadoId, amount: 1, method: 'efectivo' },
        });
        check(
            'El vendedor NO puede cobrar una venta de contado, ni siendo suya',
            cobroContado.status === 403,
            `estado ${cobroContado.status}`
        );
        check(
            'El rechazo del contado lo explica de forma distinta',
            /contado/i.test(cobroContado.body?.error?.message ?? ''),
            cobroContado.body?.error?.message
        );

        // --- el cobrador sí opera globalmente
        const cobroGlobal = await api('POST', '/payments', {
            token: cobrador.token,
            body: { sale_id: ventaAjenaId, amount: 1, method: 'efectivo' },
        });
        check('El cobrador SÍ puede cobrar la venta de cualquier vendedor', cobroGlobal.status === 201, `estado ${cobroGlobal.status}`);

        const cobroContadoCobrador = await api('POST', '/payments', {
            token: cobrador.token,
            body: { sale_id: ventaContadoId, amount: 1, method: 'efectivo' },
        });
        check('El cobrador SÍ puede cobrar una venta de contado', cobroContadoCobrador.status === 201, `estado ${cobroContadoCobrador.status}`);

        // --- el administrador conserva el alcance global
        const cobroAdmin = await api('POST', '/payments', {
            token: admin.token,
            body: { sale_id: ventaPropiaId, amount: 1, method: 'efectivo' },
        });
        check('El administrador SÍ puede cobrar cualquier venta', cobroAdmin.status === 201, `estado ${cobroAdmin.status}`);

        // --- la cartera consultada respeta el alcance
        const carteraVendedor = await api('GET', '/payments/receivables?pageSize=100', { token: vendedor.token });
        const idsVendedor = (carteraVendedor.body?.data ?? []).map((s) => s.id);
        check('La cartera del vendedor viene marcada como propia', carteraVendedor.body?.scope === 'propia', carteraVendedor.body?.scope);
        check('Su cartera incluye su propia venta a crédito', idsVendedor.includes(ventaPropiaId));
        check('Su cartera NO incluye la venta del otro vendedor', !idsVendedor.includes(ventaAjenaId));
        check('Su cartera NO incluye su venta de contado', !idsVendedor.includes(ventaContadoId));

        const carteraCobrador = await api('GET', '/payments/receivables?pageSize=100', { token: cobrador.token });
        const idsCobrador = (carteraCobrador.body?.data ?? []).map((s) => s.id);
        check('La cartera del cobrador viene marcada como global', carteraCobrador.body?.scope === 'global', carteraCobrador.body?.scope);
        check(
            'El cobrador ve las ventas de ambos vendedores',
            idsCobrador.includes(ventaPropiaId) && idsCobrador.includes(ventaAjenaId)
        );

        // --- el panel de inicio no contradice a la pantalla de cobranza
        const panelVendedor = await api('GET', '/dashboard', { token: vendedor.token });
        const panelCobrador = await api('GET', '/dashboard', { token: cobrador.token });
        const saldoVendedor = Number(panelVendedor.body?.data?.receivables?.total_balance ?? 0);
        const saldoCobrador = Number(panelCobrador.body?.data?.receivables?.total_balance ?? 0);
        check(
            'El saldo del panel del vendedor es menor que el global',
            saldoVendedor > 0 && saldoVendedor < saldoCobrador,
            `vendedor Q${saldoVendedor} vs global Q${saldoCobrador}`
        );

        // --- el intento denegado quedó registrado
        const denegados = await api('GET', '/audit?action=payment.create.denegado&pageSize=10', { token: admin.token });
        check(
            'El intento de cobrar una venta ajena quedó en la bitácora',
            (denegados.body?.data ?? []).some((e) => e.entity_id === ventaAjenaId && e.result === 'denegado'),
            `${(denegados.body?.data ?? []).length} entradas`
        );
    }

    // ------------------------------------------------------------ REQ-0016
    console.log('\n[4] REQ-0016: la bitácora registra lo que ocurre');

    const bitacora = await api('GET', '/audit?pageSize=50', { token: admin.token });
    const entradas = bitacora.body?.data ?? [];

    check(
        'Quedó registrado el inicio de sesión del administrador',
        entradas.some((e) => e.action === 'login.exitoso' && e.username === ADMIN_USER),
        `${entradas.length} entradas revisadas`
    );
    check(
        'Quedaron registrados los accesos denegados',
        entradas.some((e) => e.action === 'acceso.denegado' && e.result === 'denegado'),
        'no se encontró ninguna entrada denegada'
    );
    check(
        'Cada entrada indica el usuario responsable',
        entradas.length > 0 && entradas.every((e) => e.summary && (e.username || e.user_full_name)),
        'hay entradas sin usuario o sin descripción'
    );

    const malLogin = await login(ADMIN_USER, 'contraseña-que-no-es');
    check('Un login incorrecto es rechazado', malLogin.status === 401, `estado ${malLogin.status}`);

    const trasFallo = await api('GET', '/audit?action=login.fallido&pageSize=5', { token: admin.token });
    check(
        'El intento fallido quedó registrado en la bitácora',
        (trasFallo.body?.data ?? []).length > 0,
        'no aparece ninguna entrada login.fallido'
    );

    check(
        'La bitácora no expone contraseñas ni hashes',
        !JSON.stringify(bitacora.body ?? {}).match(/password|\$2[aby]\$/i),
        'se encontró algo que parece una credencial'
    );

    // ------------------------------------------------------------ RN-0006
    console.log('\n[5] RN-0006: la bitácora es de solo lectura');

    for (const metodo of ['POST', 'PUT', 'PATCH']) {
        const res = await api(metodo, '/audit', { token: admin.token, body: { summary: 'alterado' } });
        check(`${metodo} /audit no existe (404 o 405)`, res.status === 404 || res.status === 405, `estado ${res.status}`);
    }

    // ------------------------------------------------------------ REQ-0010
    console.log('\n[6] REQ-0010: administración de usuarios');

    const nuevo = `prueba${stamp}`;
    const creado = await api('POST', '/users', {
        token: admin.token,
        body: {
            username: nuevo,
            full_name: 'Usuario de Prueba Automática',
            password: 'Prueba123',
            role: 'cobrador',
        },
    });
    check('Se crea un usuario con rol cobrador', creado.status === 201, JSON.stringify(creado.body?.error ?? {}));
    const nuevoId = creado.body?.data?.id;

    check(
        'La respuesta no incluye el hash de la contraseña',
        creado.status === 201 && creado.body?.data?.password_hash === undefined,
        'el hash viajó en la respuesta'
    );

    const debil = await api('POST', '/users', {
        token: admin.token,
        body: { username: `x${stamp}`, full_name: 'Contraseña Débil', password: 'corta', role: 'vendedor' },
    });
    check('Una contraseña débil es rechazada (422)', debil.status === 422, `estado ${debil.status}`);

    const rolFalso = await api('POST', '/users', {
        token: admin.token,
        body: { username: `y${stamp}`, full_name: 'Rol Inventado', password: 'Prueba123', role: 'superusuario' },
    });
    check('Un rol inexistente es rechazado', rolFalso.status === 422, `estado ${rolFalso.status}`);

    const duplicado = await api('POST', '/users', {
        token: admin.token,
        body: { username: nuevo, full_name: 'Duplicado', password: 'Prueba123', role: 'vendedor' },
    });
    check('Un nombre de usuario repetido es rechazado (409)', duplicado.status === 409, `estado ${duplicado.status}`);

    if (nuevoId) {
        const baja = await api('PATCH', `/users/${nuevoId}/status`, {
            token: admin.token,
            body: { is_active: false },
        });
        check('Se puede desactivar un usuario', baja.status === 200 && baja.body?.data?.is_active === false);
        check(
            'Al desactivar se conserva el registro, no se borra',
            baja.body?.data?.id === nuevoId && Boolean(baja.body?.data?.deactivated_at),
            'no se selló la fecha de baja'
        );

        const entra = await login(nuevo, 'Prueba123');
        check('Un usuario desactivado no puede iniciar sesión', entra.status === 403, `estado ${entra.status}`);
    }

    const meId = (await api('GET', '/auth/me', { token: admin.token })).body?.data?.id;
    if (meId) {
        const autoBaja = await api('PATCH', `/users/${meId}/status`, {
            token: admin.token,
            body: { is_active: false },
        });
        check('Nadie puede desactivar su propia cuenta (409)', autoBaja.status === 409, `estado ${autoBaja.status}`);

        const autoRol = await api('PUT', `/users/${meId}`, { token: admin.token, body: { role: 'vendedor' } });
        check('Nadie puede cambiarse su propio rol (409)', autoRol.status === 409, `estado ${autoRol.status}`);
    }

    // ------------------------------------------------------------ REQ-0011
    console.log('\n[7] REQ-0011: roles y permisos administrables');

    const roles = await api('GET', '/roles', { token: admin.token });
    const codigos = (roles.body?.data ?? []).map((r) => r.role_code);
    check(
        'Existen los tres perfiles del alcance de la tesis',
        ['admin', 'vendedor', 'cobrador'].every((r) => codigos.includes(r)),
        codigos.join(', ')
    );

    const permisos = await api('GET', '/roles/permissions', { token: admin.token });
    check('El catálogo de permisos está disponible', (permisos.body?.data ?? []).length > 0);

    const sinEsenciales = await api('PUT', '/roles/admin/permissions', {
        token: admin.token,
        body: { permissions: ['customers.view'] },
    });
    check(
        'El rol admin no puede quedarse sin permisos de administración (409)',
        sinEsenciales.status === 409,
        `estado ${sinEsenciales.status}`
    );

    const permisoInventado = await api('PUT', '/roles/cobrador/permissions', {
        token: admin.token,
        body: { permissions: ['permiso.inventado'] },
    });
    check(
        'Un permiso que no existe en el catálogo es rechazado (422)',
        permisoInventado.status === 422,
        `estado ${permisoInventado.status}`
    );

    // El cambio de permisos debe surtir efecto de inmediato, sin reiniciar.
    const antes = (await api('GET', '/roles/cobrador', { token: admin.token })).body?.data?.permissions ?? [];
    const ampliado = [...new Set([...antes, 'products.view'])];
    const aplicado = await api('PUT', '/roles/cobrador/permissions', {
        token: admin.token,
        body: { permissions: ampliado },
    });
    check('Se pueden ampliar los permisos de un rol', aplicado.status === 200, `estado ${aplicado.status}`);

    const cobradorVeProductos = await api('GET', '/products?pageSize=1', { token: cobrador.token });
    check(
        'El permiso nuevo surte efecto sin reiniciar ni volver a entrar',
        cobradorVeProductos.status === 200,
        `estado ${cobradorVeProductos.status}`
    );
    check(
        'Pero el cobrador sigue sin ver el costo',
        cobradorVeProductos.body?.data?.every((p) => p.cost === undefined),
        JSON.stringify(cobradorVeProductos.body?.data?.[0] ?? {})
    );

    // Se dejan los permisos como estaban para no alterar el sistema.
    await api('PUT', '/roles/cobrador/permissions', { token: admin.token, body: { permissions: antes } });
    const restaurado = await api('GET', '/products?pageSize=1', { token: cobrador.token });
    check('Al quitar el permiso, el acceso se cierra de inmediato', restaurado.status === 403, `estado ${restaurado.status}`);

    // ------------------------------------------------------------- RESUMEN
    console.log(`\n=== ${passed} pasaron, ${failed} fallaron ===\n`);
    process.exit(failed > 0 ? 1 : 0);
}

main().catch((error) => {
    console.error('\nError inesperado durante la prueba:', error.message);
    console.error('¿Está encendido el backend en', BASE, '?');
    process.exit(1);
});
