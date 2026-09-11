/**
 * Prueba del BLOQUE 2A: fundación empresarial.
 *
 * Contra la API en ejecución, con los usuarios de prueba que crea
 * `npm run seed`. Cubre lo que exige el bloque:
 *
 *   * normalización al guardar y al buscar;
 *   * categorías y marcas sin duplicados por formato;
 *   * sucursales y la sucursal predeterminada;
 *   * asignación usuario -> sucursal;
 *   * inventario por sucursal y su cuadre con la existencia total;
 *   * histórico de costos;
 *   * permisos: quién puede y quién no.
 *
 *   npm run test:foundation
 *   API_URL=http://localhost:4000 npm run test:foundation
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

async function api(method, path, body, token) {
    const res = await fetch(BASE + path, {
        method,
        headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
    });
    let parsed = null;
    try {
        parsed = await res.json();
    } catch {
        /* respuesta sin cuerpo */
    }
    return { status: res.status, body: parsed };
}

async function login(username, password) {
    const res = await api('POST', '/auth/login', { username, password });
    return res.body?.data?.token ?? null;
}

const stamp = Date.now().toString().slice(-6);

async function run() {
    console.log('\n=== BLOQUE 2A — FUNDACIÓN EMPRESARIAL ===\n');

    // ------------------------------------------------------------ sesiones
    const admin = await login(ADMIN_USER, ADMIN_PASS);
    check('El administrador inicia sesión', Boolean(admin));
    if (!admin) throw new Error('Sin sesión de administrador no se puede continuar');

    const vendedor = await login('vendedor', DEMO_PASS);
    const cobrador = await login('cobrador', DEMO_PASS);
    const gerencia = await login('gerencia', DEMO_PASS);
    const verificador = await login('verificador', DEMO_PASS);
    check('Los usuarios de prueba de los cinco perfiles inician sesión',
        Boolean(vendedor && cobrador && gerencia && verificador));

    // ============================================================ 1. NORMALIZACIÓN
    console.log('\n[1] Normalización de clientes');

    const dpi = `28${stamp}0101`.slice(0, 13).padEnd(13, '0');
    const creado = await api('POST', '/customers', {
        dpi,
        full_name: '   José   López Álvarez  ',
        phone: '5555-1234',
        address: '  4a   calle 5-20, zona 1  ',
        email: '  JOSE.Lopez@Mail.COM ',
    }, admin);

    check('Cliente creado (201)', creado.status === 201, JSON.stringify(creado.body));
    const cliente = creado.body?.data ?? {};
    check("El nombre se guarda como 'JOSE LOPEZ ALVAREZ'",
        cliente.full_name === 'JOSE LOPEZ ALVAREZ', cliente.full_name);
    check('La dirección se guarda normalizada',
        cliente.address === '4A CALLE 5-20, ZONA 1', cliente.address);
    check('El correo se guarda en minúsculas, no en mayúsculas',
        cliente.email === 'jose.lopez@mail.com', cliente.email);

    // Municipio, departamento y notas también son datos de negocio.
    const conZona = await api('POST', '/customers', {
        dpi: `27${stamp}0101`.slice(0, 13).padEnd(13, '0'),
        full_name: '  ana   maría peña  ',
        phone: '55554321',
        address: 'Cantón El Rosario',
        municipality: '  san   felipe ',
        department: ' Suchitepéquez ',
        notes: '  cliente   puntual ',
    }, admin);
    const conZonaData = conZona.body?.data ?? {};
    check('Cliente con municipio y departamento creado (201)', conZona.status === 201, JSON.stringify(conZona.body));
    check('El apellido PEÑA conserva la Ñ', conZonaData.full_name === 'ANA MARIA PEÑA', conZonaData.full_name);
    check('El municipio se normaliza', conZonaData.municipality === 'SAN FELIPE', conZonaData.municipality);
    check('El departamento pierde la tilde', conZonaData.department === 'SUCHITEPEQUEZ', conZonaData.department);
    check('Las notas también se normalizan', conZonaData.notes === 'CLIENTE PUNTUAL', conZonaData.notes);

    // PEÑA y PENA son personas distintas.
    const conN = await api('POST', '/customers', {
        dpi: `26${stamp}0101`.slice(0, 13).padEnd(13, '0'),
        full_name: 'ana maria pena',
        phone: '55554322',
        address: 'Cantón El Rosario',
    }, admin);
    check('Cliente PENA creado (201)', conN.status === 201);
    check('PEÑA y PENA son dos clientes distintos',
        conN.body?.data?.full_name === 'ANA MARIA PENA' && conZonaData.full_name === 'ANA MARIA PEÑA',
        `${conZonaData.full_name} vs ${conN.body?.data?.full_name}`);

    const buscaEne = await api('GET', `/customers?search=${encodeURIComponent('peña')}`, null, admin);
    const buscaN = await api('GET', `/customers?search=pena`, null, admin);
    const idsEne = (buscaEne.body?.data ?? []).map((x) => x.id);
    const idsN = (buscaN.body?.data ?? []).map((x) => x.id);
    check('La búsqueda de "peña" encuentra al cliente con Ñ', idsEne.includes(conZonaData.id));
    check('La búsqueda de "peña" NO devuelve al cliente PENA', !idsEne.includes(conN.body?.data?.id));
    check('La búsqueda de "pena" NO devuelve al cliente PEÑA', !idsN.includes(conZonaData.id));
    check('La búsqueda por municipio funciona normalizada',
        ((await api('GET', `/customers?search=${encodeURIComponent('SAN felipe')}`, null, admin)).body?.data ?? [])
            .some((x) => x.id === conZonaData.id));

    console.log('\n[2] Búsqueda normalizada: las cuatro formas encuentran al mismo cliente');
    for (const q of ['José López Álvarez', 'JOSE LOPEZ ALVAREZ', 'jose lopez alvarez', 'José   López']) {
        const res = await api('GET', `/customers?search=${encodeURIComponent(q)}`, null, admin);
        const encontrado = (res.body?.data ?? []).some((x) => x.id === cliente.id);
        check(`"${q}" encuentra al cliente`, encontrado, `${res.body?.data?.length ?? 0} resultado(s)`);
    }

    const porDpi = await api('GET', `/customers?search=${dpi.slice(0, 4)}-${dpi.slice(4)}`, null, admin);
    check('El DPI con guiones también encuentra al cliente',
        (porDpi.body?.data ?? []).some((x) => x.id === cliente.id));

    // ============================================================ 3. TAXONOMÍA
    console.log('\n[3] Categorías y marcas: sin duplicados por formato');

    const cat1 = await api('POST', '/categories', { name: `Cama ${stamp}` }, admin);
    check('Categoría creada (201)', cat1.status === 201, JSON.stringify(cat1.body));
    check('El nombre se guarda en mayúsculas',
        cat1.body?.data?.name === `CAMA ${stamp}`, cat1.body?.data?.name);

    for (const variante of [`CAMA ${stamp}`, `cama ${stamp}`, `  Cama   ${stamp} `]) {
        const dup = await api('POST', '/categories', { name: variante }, admin);
        check(`"${variante}" se rechaza como duplicado (409)`, dup.status === 409, `recibido ${dup.status}`);
    }

    const marca1 = await api('POST', '/brands', { name: `Facenco ${stamp}` }, admin);
    check('Marca creada (201)', marca1.status === 201);
    for (const variante of [`FACENCO ${stamp}`, `facenco ${stamp}`]) {
        const dup = await api('POST', '/brands', { name: variante }, admin);
        check(`Marca "${variante}" se rechaza como duplicada (409)`, dup.status === 409, `recibido ${dup.status}`);
    }

    // ============================================================ 4. SUCURSALES
    console.log('\n[4] Sucursales');

    const sucursales = await api('GET', '/branches', null, admin);
    check('El administrador ve el listado de sucursales', sucursales.status === 200);
    const lista = sucursales.body?.data ?? [];
    const predeterminada = lista.filter((b) => b.is_default);
    check('Existe exactamente una sucursal predeterminada', predeterminada.length === 1,
        `${predeterminada.length}`);

    const nueva = await api('POST', '/branches', {
        code: `SUC${stamp}`.slice(0, 20),
        name: `  sucursal   de prueba ${stamp} `,
    }, admin);
    check('Sucursal creada (201)', nueva.status === 201, JSON.stringify(nueva.body));
    check('El nombre de la sucursal se normaliza',
        nueva.body?.data?.name === `SUCURSAL DE PRUEBA ${stamp}`, nueva.body?.data?.name);
    const sucursalId = nueva.body?.data?.id;

    const dupCodigo = await api('POST', '/branches', {
        code: `SUC${stamp}`.slice(0, 20),
        name: `Otro nombre ${stamp}`,
    }, admin);
    check('Código de sucursal duplicado se rechaza (409)', dupCodigo.status === 409, `recibido ${dupCodigo.status}`);

    const dupNombre = await api('POST', '/branches', {
        code: `OTRA${stamp}`.slice(0, 20),
        name: `SUCURSAL DE PRUEBA ${stamp}`,
    }, admin);
    check('Nombre de sucursal duplicado por formato se rechaza (409)', dupNombre.status === 409,
        `recibido ${dupNombre.status}`);

    // ============================================================ 5. USUARIO -> SUCURSAL
    console.log('\n[5] Usuario asignado a sucursal');

    const usuarios = await api('GET', '/users?search=vendedor', null, admin);
    const vendedorId = (usuarios.body?.data ?? []).find((u) => u.username === 'vendedor')?.id;
    check('Se localiza el usuario "vendedor"', Boolean(vendedorId));

    const asignado = await api('PATCH', `/users/${vendedorId}/branch`, { branch_id: sucursalId }, admin);
    check('El administrador asigna sucursal al usuario', asignado.status === 200, JSON.stringify(asignado.body));
    check('El usuario queda con la sucursal asignada',
        asignado.body?.data?.branch_id === sucursalId, `${asignado.body?.data?.branch_id}`);

    const filtrados = await api('GET', `/users?branch_id=${sucursalId}`, null, admin);
    check('El listado de usuarios se puede filtrar por sucursal',
        (filtrados.body?.data ?? []).some((u) => u.id === vendedorId));

    const sucursalInexistente = await api('PATCH', `/users/${vendedorId}/branch`, { branch_id: 999999 }, admin);
    check('Asignar una sucursal inexistente se rechaza (400)', sucursalInexistente.status === 400,
        `recibido ${sucursalInexistente.status}`);

    const quitada = await api('PATCH', `/users/${vendedorId}/branch`, { branch_id: null }, admin);
    check('La sucursal se puede quitar', quitada.body?.data?.branch_id === null, `${quitada.body?.data?.branch_id}`);

    // ============================================================ 6. INVENTARIO
    console.log('\n[6] Inventario por sucursal');

    const codigo = `F2A-${stamp}`;
    const producto = await api('POST', '/products', {
        code: codigo,
        name: `  producto   de prueba ${stamp} `,
        category: `Cama ${stamp}`,
        model: '  wrt-311   fzdñ ',
        description: '  con  dispensador ',
        category_id: cat1.body?.data?.id,
        brand_id: marca1.body?.data?.id,
        cost: 1000,
        stock: 10,
        min_stock: 2,
    }, admin);
    check('Producto creado (201)', producto.status === 201, JSON.stringify(producto.body));
    const productoId = producto.body?.data?.id;
    check('El nombre del producto se normaliza',
        producto.body?.data?.name === `PRODUCTO DE PRUEBA ${stamp}`, producto.body?.data?.name);
    check('La categoría del producto refleja la entidad enlazada',
        producto.body?.data?.category === `CAMA ${stamp}`, producto.body?.data?.category);
    check('El modelo se normaliza y conserva la Ñ',
        producto.body?.data?.model === 'WRT-311 FZDÑ', producto.body?.data?.model);
    check('La descripción se normaliza',
        producto.body?.data?.description === 'CON DISPENSADOR', producto.body?.data?.description);

    const porModelo = await api('GET', `/products?search=${encodeURIComponent('wrt-311 fzdñ')}`, null, admin);
    check('Se puede buscar el producto por su modelo, en minúsculas',
        (porModelo.body?.data ?? []).some((p) => p.id === producto.body?.data?.id));

    const desglose = await api('GET', `/products/${productoId}/inventory`, null, admin);
    const total = (desglose.body?.data ?? []).reduce((s, r) => s + Number(r.quantity), 0);
    check('El stock inicial aparece en el inventario por sucursal', total === 10, `total=${total}`);
    check('El stock inicial se imputa a la sucursal predeterminada',
        (desglose.body?.data ?? []).find((r) => Number(r.quantity) === 10)?.branch_id === predeterminada[0]?.id);

    const ajuste = await api('POST', '/inventory/adjust', {
        product_id: productoId,
        branch_id: sucursalId,
        delta: 4,
        reason: 'traslado_entrada',
    }, admin);
    check('Ajuste de inventario en otra sucursal (200)', ajuste.status === 200, JSON.stringify(ajuste.body));
    check('La existencia de esa sucursal queda en 4', Number(ajuste.body?.data?.quantity) === 4,
        `${ajuste.body?.data?.quantity}`);
    check('El total del producto sube a 14', Number(ajuste.body?.data?.product?.stock) === 14,
        `${ajuste.body?.data?.product?.stock}`);
    check('Se avisa de que las ventas aún no descuentan de esa sucursal',
        typeof ajuste.body?.data?.warning === 'string' && ajuste.body.data.warning.length > 0);

    const exceso = await api('POST', '/inventory/adjust', {
        product_id: productoId, branch_id: sucursalId, delta: -99, reason: 'prueba',
    }, admin);
    check('Sacar más de lo que hay en la sucursal se rechaza (422)', exceso.status === 422,
        `recibido ${exceso.status}`);

    const cero = await api('POST', '/inventory/adjust', {
        product_id: productoId, branch_id: sucursalId, delta: 0, reason: 'prueba',
    }, admin);
    check('Un ajuste de cero se rechaza (422)', cero.status === 422, `recibido ${cero.status}`);

    const descuadres = await api('GET', '/inventory/mismatches', null, admin);
    check('No hay descuadre entre la existencia total y el desglose por sucursal',
        (descuadres.body?.data ?? []).length === 0,
        `${(descuadres.body?.data ?? []).length} descuadre(s)`);

    // ============================================================ 7. COSTOS
    console.log('\n[7] Histórico de costos');

    const hist1 = await api('GET', `/products/${productoId}/cost-history`, null, admin);
    check('El producto nace con un punto de histórico', (hist1.body?.data ?? []).length === 1,
        `${(hist1.body?.data ?? []).length}`);
    check('El primer punto se marca como inicial', hist1.body?.data?.[0]?.reason === 'inicial');

    await api('PUT', `/products/${productoId}`, { cost: 1200 }, admin);
    await api('PUT', `/products/${productoId}`, { cost: 1350 }, admin);

    const hist2 = await api('GET', `/products/${productoId}/cost-history`, null, admin);
    const puntos = hist2.body?.data ?? [];
    check('Cada cambio de costo deja un punto en el histórico', puntos.length === 3, `${puntos.length}`);
    check('El último punto registra 1350 viniendo de 1200',
        Number(puntos[0]?.cost) === 1350 && Number(puntos[0]?.previous_cost) === 1200,
        `${puntos[0]?.cost} <- ${puntos[0]?.previous_cost}`);
    check('El histórico guarda quién hizo el cambio', Boolean(puntos[0]?.changed_by_username));

    const sinCambio = await api('PUT', `/products/${productoId}`, { min_stock: 3 }, admin);
    const hist3 = await api('GET', `/products/${productoId}/cost-history`, null, admin);
    check('Modificar sin tocar el costo NO añade punto al histórico',
        sinCambio.status === 200 && (hist3.body?.data ?? []).length === 3,
        `${(hist3.body?.data ?? []).length}`);

    // ============================================================ 8. ALCANCE DEL VENDEDOR
    console.log('\n[8] El vendedor opera solo con el inventario de SU sucursal');

    // Se le asigna la sucursal de prueba y se le pone existencia propia.
    await api('PATCH', `/users/${vendedorId}/branch`, { branch_id: sucursalId }, admin);

    const predeterminadaId = predeterminada[0]?.id;
    const inventarioVendedor = await api('GET', '/inventory', null, vendedor);
    check('El vendedor SÍ puede consultar inventario (200)', inventarioVendedor.status === 200,
        `recibido ${inventarioVendedor.status}`);
    check('Su alcance no es global', inventarioVendedor.body?.scope?.global === false,
        JSON.stringify(inventarioVendedor.body?.scope));
    check('Su alcance es exactamente su sucursal',
        inventarioVendedor.body?.scope?.branch_id === sucursalId,
        `${inventarioVendedor.body?.scope?.branch_id} vs ${sucursalId}`);
    check('Solo ve filas de su sucursal',
        (inventarioVendedor.body?.data ?? []).every((r) => r.branch_id === sucursalId),
        [...new Set((inventarioVendedor.body?.data ?? []).map((r) => r.branch_id))].join(', '));

    // LA PRUEBA QUE IMPORTA: manipular el identificador en la petición.
    const manipulado = await api('GET', `/inventory?branch_id=${predeterminadaId}`, null, vendedor);
    check('Pedir otra sucursal por el identificador NO cambia su alcance',
        manipulado.body?.scope?.branch_id === sucursalId,
        `devolvió ${manipulado.body?.scope?.branch_id}`);
    check('Ninguna fila devuelta pertenece a otra sucursal',
        (manipulado.body?.data ?? []).every((r) => r.branch_id === sucursalId),
        [...new Set((manipulado.body?.data ?? []).map((r) => r.branch_id))].join(', '));
    check('Se le avisa de que solo opera con su sucursal',
        typeof manipulado.body?.notice === 'string' && manipulado.body.notice.length > 0);

    const resumenVendedor = await api('GET', '/inventory/summary', null, vendedor);
    check('El resumen por sucursal se limita a la suya',
        (resumenVendedor.body?.data ?? []).length === 1 &&
            resumenVendedor.body.data[0].branch_id === sucursalId,
        `${(resumenVendedor.body?.data ?? []).length} sucursal(es)`);

    const cuadreVendedor = await api('GET', '/inventory/mismatches', null, vendedor);
    check('El vendedor NO puede pedir el cuadre global (403)', cuadreVendedor.status === 403,
        `recibido ${cuadreVendedor.status}`);

    // El catálogo le muestra SU existencia, separada del total de la empresa.
    const catalogoVendedor = await api('GET', `/products?search=${codigo}`, null, vendedor);
    const filaVendedor = (catalogoVendedor.body?.data ?? []).find((p) => p.id === productoId);
    check('El catálogo declara su alcance', catalogoVendedor.body?.scope?.branch_id === sucursalId);
    check('El catálogo le muestra la existencia de SU sucursal (4)',
        Number(filaVendedor?.branch_stock) === 4, `${filaVendedor?.branch_stock}`);
    check('El total de la empresa sigue visible y es mayor (14)',
        Number(filaVendedor?.stock) === 14, `${filaVendedor?.stock}`);

    // ---------------------------------------------------- consulta informativa
    console.log('\n[8b] Puede consultar otras sucursales, pero no operar con ellas');

    const disponibilidad = await api('GET', `/products/${productoId}/inventory`, null, vendedor);
    check('El vendedor SÍ puede consultar la disponibilidad (200)', disponibilidad.status === 200,
        `recibido ${disponibilidad.status}`);
    const disp = disponibilidad.body?.data ?? {};
    check('Ve las existencias de todas las sucursales', (disp.branches ?? []).length >= 2,
        `${(disp.branches ?? []).length} sucursal(es)`);
    check('Su stock operativo son solo las 4 de su sucursal',
        Number(disp.operational_stock) === 4, `${disp.operational_stock}`);
    check('Las 10 de la sucursal predeterminada quedan como informativas',
        Number(disp.informational_stock) === 10, `${disp.informational_stock}`);
    check('Cada sucursal viene marcada como operativa o informativa',
        (disp.branches ?? []).every((b) => typeof b.operational === 'boolean') &&
            (disp.branches ?? []).filter((b) => b.operational).every((b) => b.branch_id === sucursalId));
    check('Se le dice explícitamente que las otras unidades no son suyas',
        typeof disp.notice === 'string' && disp.notice.length > 0, String(disp.notice));

    // ---------------------------------------------------- no puede administrar
    console.log('\n[8c] Consultar no es administrar');

    const ajustePropio = await api('POST', '/inventory/adjust', {
        product_id: productoId, branch_id: sucursalId, delta: 1, reason: 'prueba',
    }, vendedor);
    check('El vendedor NO puede ajustar ni siquiera SU inventario (403)', ajustePropio.status === 403,
        `recibido ${ajustePropio.status}`);

    const ajusteAjeno = await api('POST', '/inventory/adjust', {
        product_id: productoId, branch_id: predeterminadaId, delta: 1, reason: 'prueba',
    }, vendedor);
    check('El vendedor NO puede ajustar el inventario de otra sucursal (403)', ajusteAjeno.status === 403,
        `recibido ${ajusteAjeno.status}`);

    const minimoVendedor = await api('PUT', '/inventory/min-stock', {
        product_id: productoId, branch_id: sucursalId, min_stock: 1,
    }, vendedor);
    check('El vendedor NO puede fijar mínimos de reposición (403)', minimoVendedor.status === 403,
        `recibido ${minimoVendedor.status}`);

    // Y el inventario no cambió por ninguno de los tres intentos.
    const trasIntentos = await api('GET', `/products/${productoId}/inventory`, null, admin);
    const totalTrasIntentos = (trasIntentos.body?.data?.branches ?? []).reduce(
        (sum, b) => sum + Number(b.quantity), 0
    );
    check('Después de los intentos, el inventario sigue en 14', totalTrasIntentos === 14,
        `${totalTrasIntentos}`);

    // ============================================================ 9. PERMISOS
    console.log('\n[9] Permisos: quién puede y quién no');

    const perfiles = [
        ['vendedor', vendedor],
        ['cobrador', cobrador],
        ['verificador', verificador],
        ['gerencia', gerencia],
    ];

    for (const [nombre, token] of perfiles) {
        const r = await api('GET', '/branches', null, token);
        check(`${nombre} NO puede consultar sucursales (403)`, r.status === 403, `recibido ${r.status}`);
    }

    for (const [nombre, token] of perfiles) {
        const r = await api('POST', '/branches', { code: `X${stamp}`, name: `Intento ${nombre}` }, token);
        check(`${nombre} NO puede crear sucursales (403)`, r.status === 403, `recibido ${r.status}`);
    }

    for (const [nombre, token] of perfiles) {
        const r = await api('POST', '/categories', { name: `Intento ${nombre} ${stamp}` }, token);
        check(`${nombre} NO puede crear categorías (403)`, r.status === 403, `recibido ${r.status}`);
    }

    // DECISIÓN CERRADA (2026-09-11): Cobros y Verificación no tienen acceso
    // al módulo de Inventario ni al de Sucursales. Gerencia tampoco entra al
    // módulo de Inventario: consulta Productos y costos, pero no administra
    // existencias.
    //
    // Se comprueba TODO el módulo, no una sola ruta: si mañana se añade un
    // endpoint bajo /inventory sin el permiso correcto, esta prueba lo caza.
    const RUTAS_INVENTARIO = [
        ['GET', '/inventory', null],
        ['GET', '/inventory/summary', null],
        ['GET', '/inventory/mismatches', null],
        ['POST', '/inventory/adjust', { product_id: productoId, branch_id: sucursalId, delta: 1, reason: 'prueba' }],
        ['PUT', '/inventory/min-stock', { product_id: productoId, branch_id: sucursalId, min_stock: 1 }],
    ];
    for (const [nombre, token] of [['cobrador', cobrador], ['verificador', verificador], ['gerencia', gerencia]]) {
        for (const [metodo, ruta, cuerpo] of RUTAS_INVENTARIO) {
            const r = await api(metodo, ruta, cuerpo, token);
            check(`${nombre} NO puede ${metodo} ${ruta} (403)`, r.status === 403, `recibido ${r.status}`);
        }
    }

    // Y el vendedor, que sí consulta, tampoco toca las rutas de administración.
    for (const [metodo, ruta, cuerpo] of RUTAS_INVENTARIO.slice(2)) {
        const r = await api(metodo, ruta, cuerpo, vendedor);
        check(`vendedor NO puede ${metodo} ${ruta} (403)`, r.status === 403, `recibido ${r.status}`);
    }

    // Costos: Administración y Gerencia sí; el resto no (RN-0001).
    for (const [nombre, token] of [['vendedor', vendedor], ['cobrador', cobrador], ['verificador', verificador]]) {
        const r = await api('GET', `/products/${productoId}/cost-history`, null, token);
        check(`${nombre} NO puede ver el histórico de costos (403)`, r.status === 403, `recibido ${r.status}`);
    }

    const costosGerencia = await api('GET', `/products/${productoId}/cost-history`, null, gerencia);
    check('Gerencia SÍ puede ver el histórico de costos (200)', costosGerencia.status === 200,
        `recibido ${costosGerencia.status}`);

    const catalogoGerencia = await api('GET', `/products/${productoId}`, null, gerencia);
    check('Gerencia SÍ ve el costo actual del producto',
        catalogoGerencia.status === 200 && catalogoGerencia.body?.data?.cost !== undefined,
        `cost=${catalogoGerencia.body?.data?.cost}`);

    // Consultar la taxonomía SÍ es parte de navegar el catálogo.
    const catVendedor = await api('GET', '/categories', null, vendedor);
    check('vendedor SÍ puede consultar categorías (navegar el catálogo)', catVendedor.status === 200,
        `recibido ${catVendedor.status}`);
    const arbolVendedor = await api('GET', '/catalog/tree', null, vendedor);
    check('vendedor SÍ puede ver el árbol categoría → marca', arbolVendedor.status === 200,
        `recibido ${arbolVendedor.status}`);

    const filtro = await api(
        'GET',
        `/products?category_id=${cat1.body?.data?.id}&brand_id=${marca1.body?.data?.id}`,
        null,
        admin
    );
    check('El filtro CATEGORÍA + MARCA devuelve solo esos productos',
        filtro.status === 200 && (filtro.body?.data ?? []).every(
            (p) => p.category_id === cat1.body?.data?.id && p.brand_id === marca1.body?.data?.id
        ),
        `${(filtro.body?.data ?? []).length} producto(s)`);

    // ============================================================ 9. BITÁCORA
    console.log('\n[9] Bitácora');

    const bitacora = await api('GET', '/audit?pageSize=100', null, admin);
    const acciones = (bitacora.body?.data ?? []).map((e) => e.action);
    for (const accion of ['branch.create', 'inventory.adjust', 'category.create', 'user.branch']) {
        check(`La bitácora registró "${accion}"`, acciones.includes(accion));
    }
    check('La bitácora registró los intentos denegados', acciones.includes('acceso.denegado'));

    // ============================================================ 10. SIN REGRESIÓN
    console.log('\n[10] El bloque 1 sigue en pie');

    const sinCosto = await api('GET', `/products/${productoId}`, null, vendedor);
    check('El vendedor sigue sin ver el costo del producto',
        sinCosto.status === 200 && sinCosto.body?.data?.cost === undefined,
        `cost=${sinCosto.body?.data?.cost}`);

    const sinUsuarios = await api('GET', '/users', null, vendedor);
    check('El vendedor sigue sin poder listar usuarios (403)', sinUsuarios.status === 403,
        `recibido ${sinUsuarios.status}`);

    const soloDashboard = await api('GET', '/sales', null, gerencia);
    check('Gerencia sigue limitada al panel (403 en ventas)', soloDashboard.status === 403,
        `recibido ${soloDashboard.status}`);

    const dashboard = await api('GET', '/dashboard', null, gerencia);
    check('Gerencia conserva el acceso al panel', dashboard.status === 200, `recibido ${dashboard.status}`);

    console.log(`\n${failed === 0 ? c.ok : c.bad}${passed} de ${passed + failed} comprobaciones correctas${c.off}\n`);
}

run()
    .catch((error) => {
        console.error(`\n${c.bad}Error ejecutando la prueba:${c.off}`, error.message);
        failed += 1;
    })
    .finally(() => process.exit(failed === 0 ? 0 : 1));
