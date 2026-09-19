/**
 * BLOQUE 6.1 — fundamento de PROVEEDORES.
 *
 *   npm run test:suppliers
 *
 * Prueba el módulo por la API y, donde la regla es crítica, la comprueba
 * ADEMÁS por SQL directo: si algo solo lo impide el servicio, cualquiera con
 * acceso a la base se lo saltaría.
 *
 * SEGURA CONTRA UNA BASE ACUMULATIVA: no borra ni modifica nada previo.
 * Todo lo que crea lleva el identificador único de la ejecución.
 */
import { pool, closePool } from '../config/db.js';

const BASE = (process.env.API_URL ?? 'http://localhost:4000').replace(/\/$/, '') + '/api';
const ADMIN_USER = process.env.SEED_ADMIN_USERNAME ?? 'admin';
const ADMIN_PASS = process.env.SEED_ADMIN_PASSWORD ?? 'Admin123!';
const TEST_PASS = 'Prueba123';

/** IP simulada propia de esta suite: el limitador de login no se relaja. */
const SUITE_IP = '198.18.40.1';

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
const reason = (r) => r.body?.error?.details?.reason ?? r.body?.details?.reason ?? null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function login(username, password) {
    const res = await api('POST', '/auth/login', { body: { username, password } });
    return res.body?.data?.token ?? null;
}

/** Ejecuta SQL dentro de una transacción que SIEMPRE se deshace. */
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

/**
 * IDENTIFICADOR ÚNICO DE ESTA EJECUCIÓN.
 *
 * `users.username` es único y `suppliers.nit` es único entre los activos.
 * Contra una base REAL, donde lo que dejó la ejecución anterior sigue ahí y
 * debe seguir, ningún dato de la prueba puede ser fijo. Son 10 dígitos y se
 * comprueba contra la base que estén libres antes de usarlos.
 */
let RUN = null;
const nit = (sufijo) => `${RUN}${sufijo}`;

async function reservarRun() {
    for (let intento = 0; intento < 25; intento += 1) {
        const candidato =
            String(Date.now()).slice(-8) + String(Math.floor(Math.random() * 100)).padStart(2, '0');

        const { rows } = await pool.query(
            `SELECT 1 FROM users     WHERE username LIKE $1
              UNION ALL
             SELECT 1 FROM suppliers WHERE nit LIKE $2
             LIMIT 1`,
            [`%\_${candidato}`, `${candidato}%`]
        );
        if (rows.length === 0) return candidato;
    }
    throw new Error('No se encontró un identificador de ejecución libre para la prueba de proveedores');
}

async function main() {
    console.log(`\n=== Proveedores (bloque 6.1) contra ${BASE} ===\n`);

    // ============================================================ PREPARACIÓN
    console.log('[0] Preparación');
    const admin = await login(ADMIN_USER, ADMIN_PASS);
    if (!admin) throw new Error('Sin sesión de administrador. ¿Ejecutaste `npm run seed`?');

    RUN = await reservarRun();
    console.log(`  ${c.dim}identificador de esta ejecución: ${RUN}${c.off}`);

    const mkUser = async (prefix, role) => {
        const username = `${prefix}_${RUN}`;
        const res = await api('POST', '/users', {
            token: admin,
            body: { username, full_name: `PRUEBA PROVEEDORES ${prefix}`, password: TEST_PASS, role },
        });
        return { id: res.body?.data?.id, username, res };
    };
    const uVen = await mkUser('s61_v', 'vendedor');
    const uCob = await mkUser('s61_c', 'cobrador');
    const uGer = await mkUser('s61_g', 'gerencia');
    const vendedor = await login(uVen.username, TEST_PASS);
    const cobrador = await login(uCob.username, TEST_PASS);
    const gerencia = await login(uGer.username, TEST_PASS);
    check('Entran vendedor, cobrador y gerencia de prueba',
        Boolean(vendedor && cobrador && gerencia),
        JSON.stringify({ vendedor: Boolean(vendedor), cobrador: Boolean(cobrador), gerencia: Boolean(gerencia) }));

    const { rows: [adminRow] } = await pool.query(
        'SELECT id FROM users WHERE lower(username) = lower($1)', [ADMIN_USER]);
    const adminId = Number(adminRow.id);

    // ==================================================== 1. ESQUEMA
    console.log('\n[1] Esquema');

    const { rows: cols } = await pool.query(
        `SELECT column_name, is_nullable, data_type
           FROM information_schema.columns
          WHERE table_name = 'suppliers' ORDER BY ordinal_position`);
    const nombres = cols.map((r) => r.column_name);
    check('La tabla suppliers tiene todas las columnas del bloque',
        ['id', 'nit', 'business_name', 'contact_name', 'phone', 'phone_alt', 'email', 'address',
            'municipality', 'department', 'notes', 'is_active', 'created_by', 'created_at', 'updated_at']
            .every((col) => nombres.includes(col)),
        nombres.join(','));

    check('El proveedor NO tiene sucursal: no existe la columna branch_id',
        !nombres.includes('branch_id'), nombres.join(','));

    const { rows: [fk] } = await pool.query(
        `SELECT rc.delete_rule
           FROM information_schema.table_constraints tc
           JOIN information_schema.referential_constraints rc ON rc.constraint_name = tc.constraint_name
          WHERE tc.table_name = 'suppliers' AND tc.constraint_type = 'FOREIGN KEY'`);
    check('created_by referencia a users con ON DELETE SET NULL',
        fk?.delete_rule === 'SET NULL', JSON.stringify(fk));

    const { rows: [idx] } = await pool.query(
        `SELECT indexdef FROM pg_indexes WHERE indexname = 'ux_suppliers_nit_active'`);
    check('El NIT es único solo ENTRE ACTIVOS (índice parcial)',
        Boolean(idx) && /UNIQUE/i.test(idx.indexdef) && /WHERE.*is_active/i.test(idx.indexdef),
        JSON.stringify(idx));

    const { rows: trgs } = await pool.query(
        `SELECT tgname FROM pg_trigger WHERE tgrelid = 'suppliers'::regclass AND NOT tgisinternal`);
    const nombresTrg = trgs.map((t) => t.tgname);
    check('Existen los triggers de normalización, updated_at y no-borrado',
        ['trg_suppliers_normalize', 'trg_suppliers_updated', 'trg_suppliers_no_delete']
            .every((t) => nombresTrg.includes(t)),
        nombresTrg.join(','));

    const { rows: [permisosNuevos] } = await pool.query(
        `SELECT COUNT(*)::int AS n FROM permissions WHERE code LIKE 'suppliers.%'`);
    check('El bloque NO inventó permisos nuevos: reutiliza los de inventario',
        permisosNuevos.n === 0, String(permisosNuevos.n));

    // ==================================================== 2. ALTA Y NORMALIZACIÓN
    console.log('\n[2] Alta y normalización');

    const altaA = await api('POST', '/suppliers', {
        token: admin,
        body: {
            nit: `${nit('01')}`,
            business_name: '  Distribuidora   Peña  Álvarez  ',
            contact_name: 'José López',
            phone: '2222-3333',
            phone_alt: '5555 4444',
            email: '  Ventas@PROVEEDOR.COM  ',
            address: 'Zona 1, Ciudad',
            municipality: 'Guatemala',
            department: 'Guatemala',
            notes: 'Entrega los días miércoles',
        },
    });
    check('El administrador registra un proveedor', altaA.status === 201, show(altaA));
    const provA = altaA.body?.data;

    check('La razón social se guarda normalizada (MAYÚSCULAS, sin tildes, Ñ conservada)',
        provA?.business_name === 'DISTRIBUIDORA PEÑA ALVAREZ', String(provA?.business_name));
    check('El contacto también se normaliza',
        provA?.contact_name === 'JOSE LOPEZ', String(provA?.contact_name));
    check('El correo se guarda en minúsculas',
        provA?.email === 'ventas@proveedor.com', String(provA?.email));
    check('Los teléfonos se guardan sin separadores',
        provA?.phone === '22223333' && provA?.phone_alt === '55554444',
        JSON.stringify({ phone: provA?.phone, alt: provA?.phone_alt }));
    check('El proveedor nace activo', provA?.is_active === true, String(provA?.is_active));
    check('Queda registrado quién lo dio de alta',
        Number(provA?.created_by) === adminId, String(provA?.created_by));

    const altaGuiones = await api('POST', '/suppliers', {
        token: admin,
        body: { nit: `${nit('02')}`.replace(/^(\d{4})/, '$1-'), business_name: 'COMERCIAL DOS' },
    });
    check('El NIT se acepta con guiones y se guarda limpio',
        altaGuiones.status === 201 && altaGuiones.body?.data?.nit === nit('02'), show(altaGuiones));
    const provB = altaGuiones.body?.data;

    const { rows: [sinNormalizar] } = await pool.query(
        `INSERT INTO suppliers (nit, business_name, contact_name, email, phone)
         VALUES ($1, '  proveedor  josé  ñandú ', 'maría', 'RARO@Correo.Com', '(5555) 1234')
         RETURNING nit, business_name, contact_name, email, phone`,
        [nit('03')]);
    check('Una fila insertada por SQL directo también sale normalizada (trigger)',
        sinNormalizar.business_name === 'PROVEEDOR JOSE ÑANDU' &&
            sinNormalizar.contact_name === 'MARIA' &&
            sinNormalizar.email === 'raro@correo.com' &&
            sinNormalizar.phone === '55551234',
        JSON.stringify(sinNormalizar));

    // ==================================================== 3. VALIDACIONES
    console.log('\n[3] Validación de entradas');

    const malNit = await api('POST', '/suppliers', {
        token: admin, body: { nit: 'ABC-XYZ', business_name: 'PROVEEDOR INVALIDO' } });
    check('Un NIT que no es numérico se rechaza', malNit.status === 422, show(malNit));

    const malTel = await api('POST', '/suppliers', {
        token: admin, body: { nit: nit('90'), business_name: 'PROVEEDOR TEL', phone: '123' } });
    check('Un teléfono inválido se rechaza', malTel.status === 422, show(malTel));

    const malCorreo = await api('POST', '/suppliers', {
        token: admin, body: { nit: nit('91'), business_name: 'PROVEEDOR MAIL', email: 'no-es-correo' } });
    check('Un correo inválido se rechaza', malCorreo.status === 422, show(malCorreo));

    const sinRazon = await api('POST', '/suppliers', { token: admin, body: { nit: nit('92') } });
    check('Sin razón social no se registra', sinRazon.status === 422, show(sinRazon));

    const razonCorta = await api('POST', '/suppliers', {
        token: admin, body: { nit: nit('93'), business_name: 'AB' } });
    check('Una razón social demasiado corta se rechaza', razonCorta.status === 422, show(razonCorta));

    const campoRaro = await api('POST', '/suppliers', {
        token: admin,
        body: { nit: nit('94'), business_name: 'PROVEEDOR EXTRA', branch_id: 1 } });
    check('Un campo no declarado (branch_id) se rechaza: el proveedor no tiene sucursal',
        campoRaro.status === 422, show(campoRaro));

    const errCheck = await fails(
        `INSERT INTO suppliers (nit, business_name) VALUES ('NO-ES-NIT', 'PROVEEDOR SQL')`);
    check('La base rechaza por SQL directo un NIT con forma inválida',
        errCheck?.code === '23514', String(errCheck?.code));

    // ==================================================== 4. NIT DUPLICADO
    console.log('\n[4] NIT duplicado');

    const dup = await api('POST', '/suppliers', {
        token: admin, body: { nit: nit('01'), business_name: 'OTRO PROVEEDOR' } });
    check('No se puede registrar dos veces el mismo NIT activo', dup.status === 409, show(dup));
    check('El conflicto dice cuál es el proveedor que ya lo tiene',
        Number(dup.body?.error?.details?.supplier_id) === Number(provA?.id) &&
            reason(dup) === 'nit_activo_duplicado',
        JSON.stringify(dup.body?.error?.details));

    const dupConGuiones = await api('POST', '/suppliers', {
        token: admin, body: { nit: `${nit('01')}`.replace(/^(\d{3})/, '$1-'), business_name: 'OTRO MAS' } });
    check('El mismo NIT escrito con guiones también se detecta como duplicado',
        dupConGuiones.status === 409, show(dupConGuiones));

    const errUnico = await fails(
        `INSERT INTO suppliers (nit, business_name) VALUES ($1, 'DUPLICADO POR SQL')`, [nit('01')]);
    check('La base impide por SQL directo dos proveedores ACTIVOS con el mismo NIT',
        errUnico?.code === '23505', String(errUnico?.code));

    // ==================================================== 5. MODIFICACIÓN PARCIAL
    console.log('\n[5] Modificación parcial (PATCH)');

    const soloContacto = await api('PATCH', `/suppliers/${provA.id}`, {
        token: admin, body: { contact_name: 'Ana Núñez' } });
    check('Se puede cambiar solo el contacto', soloContacto.status === 200, show(soloContacto));
    check('El contacto nuevo se normaliza',
        soloContacto.body?.data?.contact_name === 'ANA NUÑEZ', String(soloContacto.body?.data?.contact_name));
    check('Omitir un campo NO lo borra: el teléfono alternativo sigue ahí',
        soloContacto.body?.data?.phone_alt === '55554444', String(soloContacto.body?.data?.phone_alt));
    check('Omitir un campo NO lo borra: el correo sigue ahí',
        soloContacto.body?.data?.email === 'ventas@proveedor.com', String(soloContacto.body?.data?.email));
    check('updated_at avanza al modificar',
        new Date(soloContacto.body?.data?.updated_at) > new Date(provA.updated_at),
        `${provA.updated_at} -> ${soloContacto.body?.data?.updated_at}`);

    const borraAlt = await api('PATCH', `/suppliers/${provA.id}`, {
        token: admin, body: { phone_alt: null } });
    check('Enviar null explícitamente SÍ borra el dato de contacto',
        borraAlt.status === 200 && borraAlt.body?.data?.phone_alt === null, show(borraAlt));
    check('Y no arrastra lo demás: el teléfono principal se conserva',
        borraAlt.body?.data?.phone === '22223333', String(borraAlt.body?.data?.phone));

    const nitOcupado = await api('PATCH', `/suppliers/${provB.id}`, {
        token: admin, body: { nit: nit('01') } });
    check('No se puede mover el NIT de un proveedor al de otro activo',
        nitOcupado.status === 409, show(nitOcupado));

    const noExiste = await api('PATCH', '/suppliers/99999999', {
        token: admin, body: { business_name: 'FANTASMA UNO' } });
    check('Modificar un proveedor inexistente responde 404', noExiste.status === 404, show(noExiste));

    // ==================================================== 6. BAJA Y REACTIVACIÓN
    console.log('\n[6] Baja lógica y reactivación');

    const errBorrar = await fails('DELETE FROM suppliers WHERE id = $1', [provB.id]);
    check('La base impide BORRAR un proveedor',
        errBorrar?.code === '2F003' || /no se elimina/i.test(errBorrar?.message ?? ''),
        `${errBorrar?.code} ${errBorrar?.message}`);

    const baja = await api('PATCH', `/suppliers/${provB.id}/active`, {
        token: admin, body: { is_active: false } });
    check('Se desactiva un proveedor', baja.status === 200 && baja.body?.data?.is_active === false, show(baja));

    const { rows: [sigue] } = await pool.query('SELECT nit, business_name FROM suppliers WHERE id = $1', [provB.id]);
    check('El proveedor desactivado conserva su NIT y su historial',
        sigue?.nit === nit('02'), JSON.stringify(sigue));

    const reAlta = await api('POST', '/suppliers', {
        token: admin, body: { nit: nit('02'), business_name: 'COMERCIAL DOS REGRESA' } });
    check('Con el NIT de un proveedor DESACTIVADO el alta se detiene y se ofrece reactivar',
        reAlta.status === 409 && reason(reAlta) === 'nit_inactivo_reactivable', show(reAlta));
    check('El conflicto señala qué proveedor reactivar',
        Number(reAlta.body?.error?.details?.supplier_id) === Number(provB.id),
        JSON.stringify(reAlta.body?.error?.details));

    const reactiva = await api('PATCH', `/suppliers/${provB.id}/active`, {
        token: admin, body: { is_active: true } });
    check('Se reactiva el proveedor',
        reactiva.status === 200 && reactiva.body?.data?.is_active === true, show(reactiva));
    check('Al reactivar conserva el mismo registro (mismo id)',
        Number(reactiva.body?.data?.id) === Number(provB.id), String(reactiva.body?.data?.id));

    // Conflicto de reactivación: se desactiva B y se ocupa su NIT por SQL
    // (la API no deja crearlo, precisamente por la regla anterior).
    await api('PATCH', `/suppliers/${provB.id}/active`, { token: admin, body: { is_active: false } });
    const { rows: [intruso] } = await pool.query(
        `INSERT INTO suppliers (nit, business_name) VALUES ($1, 'PROVEEDOR QUE OCUPA EL NIT') RETURNING id`,
        [nit('02')]);
    const choque = await api('PATCH', `/suppliers/${provB.id}/active`, {
        token: admin, body: { is_active: true } });
    check('No se reactiva si otro proveedor activo ocupó ya ese NIT',
        choque.status === 409 && Number(choque.body?.error?.details?.supplier_id) === Number(intruso.id),
        show(choque));
    await pool.query('UPDATE suppliers SET is_active = FALSE WHERE id = $1', [intruso.id]);

    const estadoRaro = await api('PATCH', `/suppliers/${provA.id}/active`, {
        token: admin, body: { is_active: 'si' } });
    check('El estado tiene que ser booleano', estadoRaro.status === 422, show(estadoRaro));

    // ==================================================== 7. CONSULTA
    console.log('\n[7] Consulta, búsqueda y filtros');

    const porNit = await api('GET', `/suppliers?search=${nit('01')}`, { token: admin });
    check('Se busca por NIT',
        porNit.status === 200 && porNit.body?.data?.some((s) => Number(s.id) === Number(provA.id)),
        show(porNit));

    const porNitConGuion = await api('GET', `/suppliers?search=${`${nit('01')}`.replace(/^(\d{3})/, '$1-')}`, { token: admin });
    check('Se busca por NIT aunque se escriba con guion',
        porNitConGuion.body?.data?.some((s) => Number(s.id) === Number(provA.id)), show(porNitConGuion));

    const busca = (texto) =>
        api('GET', `/suppliers?pageSize=100&search=${encodeURIComponent(texto)}`, { token: admin });
    const encuentraA = (r) => (r.body?.data ?? []).some((s) => Number(s.id) === Number(provA.id));

    const porRazon = await busca('alvarez');
    check('Se busca por razón social en minúsculas y sin tildes', encuentraA(porRazon), show(porRazon));

    const porRazonConTildes = await busca('Álvarez');
    check('Se busca por razón social escrita con tildes', encuentraA(porRazonConTildes), show(porRazonConTildes));

    // La búsqueda es por fragmento CONTIGUO, igual que en clientes: no se
    // parte la consulta en palabras sueltas. Se deja comprobado para que el
    // comportamiento sea una decisión y no una sorpresa.
    const salteada = await busca('distribuidora alvarez');
    check('La búsqueda es por fragmento contiguo, no por palabras sueltas',
        !encuentraA(salteada), show(salteada));

    const porContacto = await busca('ana nuñez');
    check('Se busca por nombre del contacto', encuentraA(porContacto), show(porContacto));

    // La Ñ es una LETRA, no un acento: "PEÑA" y "PENA" son apellidos
    // distintos y la búsqueda no debe colapsarlos. Es la misma regla que
    // comprueba `npm run test:normalize`, verificada aquí desde la API.
    const conEne = await busca('PENA');
    check('Buscar "PENA" NO encuentra a "PEÑA": la Ñ no colapsa',
        !encuentraA(conEne), show(conEne));
    const conEnie = await busca('peña');
    check('Buscar "peña" sí encuentra a "PEÑA"', encuentraA(conEnie), show(conEnie));

    const porTelefono = await busca('2222-3333');
    check('Se busca por teléfono', encuentraA(porTelefono), show(porTelefono));

    const soloActivos = await api('GET', '/suppliers?status=active&pageSize=100', { token: admin });
    check('El filtro de activos solo devuelve activos',
        soloActivos.status === 200 && (soloActivos.body?.data ?? []).every((s) => s.is_active === true),
        show(soloActivos));

    const soloInactivos = await api('GET', '/suppliers?status=inactive&pageSize=100', { token: admin });
    check('El filtro de inactivos solo devuelve inactivos',
        soloInactivos.status === 200 && (soloInactivos.body?.data ?? []).every((s) => s.is_active === false),
        show(soloInactivos));
    check('El proveedor dado de baja aparece en el filtro de inactivos',
        (soloInactivos.body?.data ?? []).some((s) => Number(s.id) === Number(provB.id)), show(soloInactivos));

    const paginado = await api('GET', '/suppliers?page=1&pageSize=1', { token: admin });
    check('El listado pagina',
        paginado.status === 200 && (paginado.body?.data ?? []).length === 1 &&
            paginado.body?.pagination?.pageSize === 1 && paginado.body?.pagination?.total >= 3,
        show(paginado));

    const uno = await api('GET', `/suppliers/${provA.id}`, { token: admin });
    check('Se consulta un proveedor por su identificador',
        uno.status === 200 && Number(uno.body?.data?.id) === Number(provA.id), show(uno));

    const unoQueNoEsta = await api('GET', '/suppliers/99999999', { token: admin });
    check('Un proveedor inexistente responde 404', unoQueNoEsta.status === 404, show(unoQueNoEsta));

    const idRaro = await api('GET', '/suppliers/abc', { token: admin });
    check('Un identificador no numérico se rechaza', idRaro.status === 422, show(idRaro));

    // ==================================================== 8. PERMISOS
    console.log('\n[8] Permisos y acceso');

    const sinSesion = await api('GET', '/suppliers');
    check('Sin sesión no se consultan proveedores', sinSesion.status === 401, show(sinSesion));

    for (const [nombre, token] of [['vendedor', vendedor], ['cobrador', cobrador], ['gerencia', gerencia]]) {
        const lee = await api('GET', '/suppliers', { token });
        check(`El ${nombre} no consulta proveedores`, lee.status === 403, show(lee));
        const escribe = await api('POST', '/suppliers', {
            token, body: { nit: nit('95'), business_name: `INTENTO ${nombre.toUpperCase()}` } });
        check(`El ${nombre} no registra proveedores`, escribe.status === 403, show(escribe));
    }

    const { rows: [noEntro] } = await pool.query(
        `SELECT COUNT(*)::int AS n FROM suppliers WHERE nit = $1`, [nit('95')]);
    check('Ningún intento sin permiso dejó rastro en la tabla', noEntro.n === 0, String(noEntro.n));

    // ==================================================== 9. BITÁCORA
    console.log('\n[9] Bitácora');
    await sleep(400);

    const { rows: bitacora } = await pool.query(
        `SELECT action, COUNT(*)::int AS n FROM audit_log
          WHERE action LIKE 'supplier.%' GROUP BY action ORDER BY action`);
    const acciones = Object.fromEntries(bitacora.map((r) => [r.action, r.n]));
    check('La bitácora registra alta, modificación y cambio de estado',
        ['supplier.create', 'supplier.update', 'supplier.status'].every((a) => acciones[a] > 0),
        JSON.stringify(acciones));

    const { rows: [conEntidad] } = await pool.query(
        `SELECT COUNT(*)::int AS n FROM audit_log
          WHERE action = 'supplier.create' AND entity = 'supplier' AND entity_id = $1`, [provA.id]);
    check('El alta queda ligada al proveedor concreto', conEntidad.n > 0, String(conEntidad.n));

    const { rows: [denegado] } = await pool.query(
        `SELECT COUNT(*)::int AS n FROM audit_log
          WHERE action = 'acceso.denegado' AND module = 'compras'`);
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
