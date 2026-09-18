/**
 * Prueba de la normalización canónica.
 *
 * A diferencia de `test:flow` y `test:security`, esta NO necesita la API
 * encendida: habla directamente con la base de datos. Comprueba tres cosas:
 *
 *   1. que la implementación de JavaScript y la de SQL den EXACTAMENTE el
 *      mismo resultado (si se separan, lo que valida la aplicación y lo que
 *      guarda la base dejan de ser lo mismo);
 *   2. que los casos del bloque 2A converjan: "José López", "JOSE LOPEZ",
 *      "jose lopez" y "José   López" son el mismo texto;
 *   3. que categorías y marcas no admitan duplicados por formato.
 *
 *   npm run test:normalize
 */
import { pool, closePool } from '../config/db.js';
import {
    normalizeText,
    normalizeOptionalText,
    normalizeEmail,
    normalizeSearch,
    normalizeDpi,
    normalizePhone,
} from '../utils/normalize.js';

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

/** Corpus: casos del enunciado, trampas reales y caracteres de borde. */
const CORPUS = [
    '   José   López Álvarez  ',
    'JOSE LOPEZ ALVAREZ',
    'jose lopez alvarez',
    'José López',
    'JOSÉ LÓPEZ',
    'josé   lópez',
    'Peña',
    'PEÑA',
    'peña',
    'PENA',
    'pena',
    'Ñandú',
    'ÑANDU',
    'Márquez',
    'ÁÉÍÓÚ',
    '  José   Peña   ',
    'María Muñoz Ñandú',
    'PEÑALOZA',
    'PENALOZA',
    'Ana   María',
    'san felipe',
    'Suchitepéquez',
    'Cama',
    'CAMA',
    'cama',
    '  cama  ',
    'Facenco',
    'FACENCO',
    'facenco',
    'Refrigeradora  Whirlpool',
    'Línea Blanca',
    'Ángel Ürsula Çedilla',
    'aldea san antonio, suchitepéquez',
    '4a. Calle 5-20 Zona 1',
    'TV 32" LED',
    'a\tb\nc',
    'espacio duro',
    '   ',
    '',
    'ÑOÑO ñoño',
    'Sámsung',
];

async function run() {
    console.log('\n=== NORMALIZACIÓN CANÓNICA ===\n');

    // ---------------------------------------------------------------- 1
    console.log('1. La regla de JavaScript y la de SQL coinciden');

    const { rows } = await pool.query(
        `SELECT t.value, normalize_business_text(t.value) AS sql_result
           FROM unnest($1::text[]) AS t(value)`,
        [CORPUS]
    );

    let divergences = 0;
    for (const row of rows) {
        const js = normalizeText(row.value);
        if (js !== row.sql_result) {
            divergences += 1;
            console.log(
                `     ${c.bad}divergen${c.off} ${JSON.stringify(row.value)}: js=${JSON.stringify(js)} sql=${JSON.stringify(row.sql_result)}`
            );
        }
    }
    check(`Las dos implementaciones coinciden en los ${CORPUS.length} casos del corpus`, divergences === 0,
        `${divergences} divergencia(s)`);

    // ---------------------------------------------------------------- 2
    console.log('\n2. Casos exigidos por el bloque 2A');

    const variantes = ['José López', 'JOSE LOPEZ', 'jose lopez', 'José   López', '  josé lópez  '];
    const normalizadas = new Set(variantes.map(normalizeText));
    check(
        'Las cinco formas de "José López" convergen en una sola',
        normalizadas.size === 1 && normalizadas.has('JOSE LOPEZ'),
        [...normalizadas].join(' | ')
    );

    check(
        "'   José   López Álvarez  ' -> 'JOSE LOPEZ ALVAREZ'",
        normalizeText('   José   López Álvarez  ') === 'JOSE LOPEZ ALVAREZ',
        normalizeText('   José   López Álvarez  ')
    );

    const camas = new Set(['Cama', 'CAMA', 'cama', ' cama '].map(normalizeText));
    check('Cama / CAMA / cama son una sola categoría', camas.size === 1 && camas.has('CAMA'));

    const marcas = new Set(['Facenco', 'FACENCO', 'facenco'].map(normalizeText));
    check('Facenco / FACENCO / facenco son una sola marca', marcas.size === 1 && marcas.has('FACENCO'));

    // ---------------------------------------------------------------- 3
    console.log('\n3. La Ñ es una letra del alfabeto, no un acento');

    // Casos exigidos palabra por palabra por el propietario.
    const CASOS_ENE = [
        ['José', 'JOSE'],
        ['Álvarez', 'ALVAREZ'],
        ['Márquez', 'MARQUEZ'],
        ['Peña', 'PEÑA'],
        ['PEÑA', 'PEÑA'],
        ['peña', 'PEÑA'],
        ['PENA', 'PENA'],
        ['pena', 'PENA'],
        ['Ñandú', 'ÑANDU'],
        ['ÁÉÍÓÚ', 'AEIOU'],
        ['José López Álvarez', 'JOSE LOPEZ ALVAREZ'],
        ['  José   Peña   ', 'JOSE PEÑA'],
    ];
    for (const [entrada, esperado] of CASOS_ENE) {
        check(`${JSON.stringify(entrada)} -> ${esperado}`, normalizeText(entrada) === esperado, normalizeText(entrada));
    }

    // La regla que no se puede romper nunca.
    check('PEÑA != PENA', normalizeText('Peña') !== normalizeText('Pena'),
        `${normalizeText('Peña')} vs ${normalizeText('Pena')}`);
    check('PEÑALOZA != PENALOZA', normalizeText('Peñaloza') !== normalizeText('Penaloza'));

    // Ninguna Ñ puede desaparecer, venga como venga.
    const CON_ENE = ['ñ', 'Ñ', 'Peña', 'PEÑA', 'muñoz', 'MUÑOZ', 'Ñandú', 'niño', 'CAÑA', 'año', 'señor'];
    const perdidas = CON_ENE.filter((v) => !normalizeText(v).includes('Ñ'));
    check(`Ninguna Ñ se convierte en N (${CON_ENE.length} casos)`, perdidas.length === 0, perdidas.join(', '));

    // Y la Ñ siempre sale en mayúscula, venga como venga.
    check('La ñ minúscula se convierte en Ñ mayúscula, no en ñ', normalizeText('ñ') === 'Ñ', normalizeText('ñ'));

    // ---------------------------------------------------------------- 4
    console.log('\n4. Cada tipo de dato lleva su propia normalización');

    check('El correo va en minúsculas, no en mayúsculas',
        normalizeEmail('  JOSE.Lopez@Mail.COM ') === 'jose.lopez@mail.com',
        normalizeEmail('  JOSE.Lopez@Mail.COM '));
    check('Un correo en blanco se guarda como null', normalizeEmail('   ') === null);
    check('El DPI conserva solo dígitos',
        normalizeDpi('1234-56789-0101') === '1234567890101', normalizeDpi('1234-56789-0101'));
    check('El teléfono conserva el formato del proyecto',
        normalizePhone(' 5555-1234 ') === '55551234', normalizePhone(' 5555-1234 '));
    check('Un texto opcional en blanco se guarda como null', normalizeOptionalText('   ') === null);
    check('Un texto obligatorio en blanco devuelve cadena vacía, no null', normalizeText('   ') === '');
    check('null sigue siendo null', normalizeText(null) === null);
    check('La consulta de búsqueda usa la misma forma canónica',
        normalizeSearch(' josé  lópez ') === 'JOSE LOPEZ', normalizeSearch(' josé  lópez '));
    check('Una búsqueda vacía devuelve cadena vacía', normalizeSearch(null) === '');

    // ---------------------------------------------------------------- 4b
    console.log('\n4b. La búsqueda usa la misma regla y no confunde PEÑA con PENA');

    const { rows: busqueda } = await pool.query(
        `SELECT
            (SELECT COUNT(*)::int FROM customers
              WHERE normalize_business_text(full_name) LIKE '%' || normalize_business_text($1) || '%'
                AND normalize_business_text(full_name) LIKE '%' || normalize_business_text($2) || '%') AS ambos`,
        ['peña', 'pena']
    );
    check('Ningún cliente aparece a la vez en la búsqueda de PEÑA y en la de PENA',
        busqueda[0].ambos === 0, `${busqueda[0].ambos} coincidencia(s) cruzada(s)`);

    // ---------------------------------------------------------------- 5
    console.log('\n5. La base de datos rechaza los duplicados por formato');

    const client = await pool.connect();
    try {
        const dupCategoria = await rejects(client, `INSERT INTO categories (name) VALUES ('Categoria De Prueba 2A')`,
            `INSERT INTO categories (name) VALUES ('  categoría   de   prueba 2a  ')`);
        check('No se puede crear la misma categoría con otro formato', dupCategoria.rejected, dupCategoria.detail);

        const dupMarca = await rejects(client, `INSERT INTO brands (name) VALUES ('Marca De Prueba 2A')`,
            `INSERT INTO brands (name) VALUES ('MARCA DE PRUEBA 2A')`);
        check('No se puede crear la misma marca con otro formato', dupMarca.rejected, dupMarca.detail);

        // Se guarda normalizado, no tal cual se escribió.
        await client.query('BEGIN');
        const { rows: cat } = await client.query(
            `INSERT INTO categories (name) VALUES ('  línea   blanca 2a ') RETURNING name`
        );
        check('La categoría se guarda en su forma canónica', cat[0].name === 'LINEA BLANCA 2A', cat[0].name);
        await client.query('ROLLBACK');

        // Histórico de costos inmutable (RN-0006).
        // La comprobación necesita una fila real: si la tabla está vacía (base
        // recién migrada), un UPDATE que no toca ninguna fila no dispara el
        // trigger y la prueba no comprobaría nada. Se garantiza una fila y se
        // usa SU identificador, no uno fijo.
        await client.query('BEGIN');
        const { rows: costRow } = await client.query(
            `INSERT INTO product_cost_history (product_id, cost, previous_cost, reason)
             SELECT id, cost, cost, 'correccion' FROM products ORDER BY id LIMIT 1
             RETURNING id`
        );
        await client.query('COMMIT');
        const costId = costRow[0]?.id;
        const immutableUpdate = await failsWith(client, `UPDATE product_cost_history SET cost = 1 WHERE id = ${costId}`);
        check('El histórico de costos no se puede modificar', immutableUpdate === '23001', `${immutableUpdate} (fila ${costId})`);
        const immutableDelete = await failsWith(client, `DELETE FROM product_cost_history WHERE id = ${costId}`);
        check('El histórico de costos no se puede borrar', immutableDelete === '23001', `${immutableDelete} (fila ${costId})`);
    } finally {
        client.release();
    }

    // ---------------------------------------------------------------- 6
    console.log('\n6. El inventario por sucursal cuadra con la existencia total');

    const { rows: mismatch } = await pool.query('SELECT COUNT(*)::int AS total FROM v_inventory_mismatch');
    check('Ningún producto tiene descuadre entre products.stock y el desglose por sucursal',
        mismatch[0].total === 0, `${mismatch[0].total} descuadre(s)`);

    const { rows: def } = await pool.query('SELECT COUNT(*)::int AS total FROM branches WHERE is_default');
    check('Hay exactamente una sucursal predeterminada', def[0].total === 1, `${def[0].total}`);

    const { rows: orphan } = await pool.query('SELECT COUNT(*)::int AS total FROM stock_movements WHERE branch_id IS NULL');
    check('Ningún movimiento de inventario quedó sin sucursal', orphan[0].total === 0, `${orphan[0].total}`);

    // ---------------------------------------------------------------- 7
    console.log('\n7. Los datos guardados están en su forma canónica');

    const { rows: sinNormalizar } = await pool.query(
        `SELECT (SELECT COUNT(*)::int FROM customers
                  WHERE full_name <> normalize_business_text(full_name)
                     OR address   <> normalize_business_text(address)
                     OR municipality IS DISTINCT FROM NULLIF(normalize_business_text(municipality), '')
                     OR department   IS DISTINCT FROM NULLIF(normalize_business_text(department), '')
                     OR notes        IS DISTINCT FROM NULLIF(normalize_business_text(notes), ''))  AS clientes,
                (SELECT COUNT(*)::int FROM products
                  WHERE name     <> normalize_business_text(name)
                     OR category <> normalize_business_text(category)
                     OR brand       IS DISTINCT FROM NULLIF(normalize_business_text(brand), '')
                     OR model       IS DISTINCT FROM NULLIF(normalize_business_text(model), '')
                     OR description IS DISTINCT FROM NULLIF(normalize_business_text(description), '')) AS productos,
                (SELECT COUNT(*)::int FROM categories
                  WHERE name <> normalize_business_text(name))                    AS categorias,
                (SELECT COUNT(*)::int FROM brands
                  WHERE name <> normalize_business_text(name))                    AS marcas`
    );
    const s = sinNormalizar[0];
    check('Todos los clientes están normalizados', s.clientes === 0, `${s.clientes} sin normalizar`);
    check('Todos los productos están normalizados', s.productos === 0, `${s.productos} sin normalizar`);
    check('Todas las categorías están normalizadas', s.categorias === 0, `${s.categorias} sin normalizar`);
    check('Todas las marcas están normalizadas', s.marcas === 0, `${s.marcas} sin normalizar`);

    console.log(`\n${failed === 0 ? c.ok : c.bad}${passed} de ${passed + failed} comprobaciones correctas${c.off}\n`);
}

/** Ejecuta `setup` y luego `duplicate`; espera que la segunda falle. */
async function rejects(client, setup, duplicate) {
    await client.query('BEGIN');
    try {
        await client.query(setup);
        await client.query(duplicate);
        await client.query('ROLLBACK');
        return { rejected: false, detail: 'la base aceptó el duplicado' };
    } catch (error) {
        await client.query('ROLLBACK');
        return { rejected: error.code === '23505', detail: `${error.code}` };
    }
}

/** Devuelve el SQLSTATE con el que falla una sentencia, o null si no falla. */
async function failsWith(client, sql) {
    await client.query('BEGIN');
    try {
        await client.query(sql);
        await client.query('ROLLBACK');
        return null;
    } catch (error) {
        await client.query('ROLLBACK');
        return error.code;
    }
}

run()
    .catch((error) => {
        console.error('\nError ejecutando la prueba:', error.message);
        failed += 1;
    })
    .finally(async () => {
        await closePool();
        process.exit(failed === 0 ? 0 : 1);
    });
