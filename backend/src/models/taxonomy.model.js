/**
 * CATEGORÍAS Y MARCAS
 *
 * Antes eran texto suelto dentro de `products`: nada impedía que "CAMA",
 * "Cama" y "cama" convivieran como tres categorías distintas. Ahora son
 * entidades con unicidad definida sobre la forma normalizada del nombre,
 * que es lo que permite navegar el catálogo
 *
 *     CATEGORÍA -> MARCA -> PRODUCTOS
 *
 * sin que la misma categoría aparezca tres veces en el menú.
 *
 * Las dos tablas se comportan igual, así que comparten las mismas funciones
 * parametrizadas por tabla en lugar de duplicar el código. El nombre de la
 * tabla NUNCA viene del usuario: sale de la constante `TABLES`.
 */
import { query } from '../config/db.js';
import { normalizeSearch } from '../utils/normalize.js';

const TABLES = Object.freeze({ categories: 'categories', brands: 'brands' });

function tableFor(kind) {
    const table = TABLES[kind];
    if (!table) throw new Error(`Taxonomía desconocida: ${kind}`);
    return table;
}

const FIELDS = 'id, name, description, is_active, created_by, created_at, updated_at';

/**
 * Listado con el número de productos de cada entrada, para que el
 * administrador vea de un vistazo qué está en uso y qué no.
 */
async function list(kind, { search = '', status = 'all' } = {}) {
    const table = tableFor(kind);
    const fk = kind === 'categories' ? 'category_id' : 'brand_id';

    const filters = [];
    const params = [];

    if (search) {
        params.push(`%${normalizeSearch(search)}%`);
        filters.push(`normalize_business_text(t.name) LIKE $${params.length}`);
    }
    if (status === 'active') filters.push('t.is_active = TRUE');
    if (status === 'inactive') filters.push('t.is_active = FALSE');

    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';

    const { rows } = await query(
        `SELECT t.id, t.name, t.description, t.is_active, t.created_at, t.updated_at,
                COUNT(p.id)::int AS products,
                COUNT(p.id) FILTER (WHERE p.is_active)::int AS active_products
           FROM ${table} t
           LEFT JOIN products p ON p.${fk} = t.id
           ${where}
       GROUP BY t.id
       ORDER BY t.name`,
        params
    );
    return rows;
}

async function findById(kind, id) {
    const { rows } = await query(`SELECT ${FIELDS} FROM ${tableFor(kind)} WHERE id = $1`, [id]);
    return rows[0] ?? null;
}

/**
 * Busca por nombre comparando la forma normalizada: es la consulta que
 * impide dar de alta "Facenco" cuando ya existe "FACENCO".
 */
async function findByName(kind, name) {
    const { rows } = await query(
        `SELECT ${FIELDS} FROM ${tableFor(kind)}
          WHERE normalize_business_text(name) = normalize_business_text($1)`,
        [name]
    );
    return rows[0] ?? null;
}

async function create(kind, { name, description = null }, userId = null) {
    const { rows } = await query(
        `INSERT INTO ${tableFor(kind)} (name, description, created_by)
         VALUES ($1,$2,$3) RETURNING ${FIELDS}`,
        [name, description, userId]
    );
    return rows[0];
}

async function update(kind, id, { name = null, description = null }) {
    const { rows } = await query(
        `UPDATE ${tableFor(kind)}
            SET name = COALESCE($2, name), description = $3
          WHERE id = $1 RETURNING ${FIELDS}`,
        [id, name, description]
    );
    return rows[0] ?? null;
}

async function setActive(kind, id, isActive) {
    const { rows } = await query(
        `UPDATE ${tableFor(kind)} SET is_active = $2 WHERE id = $1 RETURNING ${FIELDS}`,
        [id, isActive]
    );
    return rows[0] ?? null;
}

/** Cuántos productos apuntan a esta entrada. Se usa antes de desactivarla. */
async function countProducts(kind, id) {
    const fk = kind === 'categories' ? 'category_id' : 'brand_id';
    const { rows } = await query(
        `SELECT COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE is_active)::int AS active
           FROM products WHERE ${fk} = $1`,
        [id]
    );
    return rows[0];
}

// --- Categorías -------------------------------------------------------
export const listCategories = (opts) => list('categories', opts);
export const findCategoryById = (id) => findById('categories', id);
export const findCategoryByName = (name) => findByName('categories', name);
export const createCategory = (data, userId) => create('categories', data, userId);
export const updateCategory = (id, data) => update('categories', id, data);
export const setCategoryActive = (id, active) => setActive('categories', id, active);
export const countCategoryProducts = (id) => countProducts('categories', id);

// --- Marcas -----------------------------------------------------------
export const listBrands = (opts) => list('brands', opts);
export const findBrandById = (id) => findById('brands', id);
export const findBrandByName = (name) => findByName('brands', name);
export const createBrand = (data, userId) => create('brands', data, userId);
export const updateBrand = (id, data) => update('brands', id, data);
export const setBrandActive = (id, active) => setActive('brands', id, active);
export const countBrandProducts = (id) => countProducts('brands', id);

/** Árbol CATEGORÍA -> MARCA con el conteo de productos. */
export async function catalogTree() {
    const { rows } = await query(
        `SELECT category_id, category_name, brand_id, brand_name, products, active_products
           FROM v_catalog_tree
          WHERE category_id IS NOT NULL
       ORDER BY category_name, brand_name NULLS FIRST`
    );

    const byCategory = new Map();
    for (const row of rows) {
        if (!byCategory.has(row.category_id)) {
            byCategory.set(row.category_id, {
                id: row.category_id,
                name: row.category_name,
                products: 0,
                brands: [],
            });
        }
        const category = byCategory.get(row.category_id);
        category.products += row.products;
        category.brands.push({
            id: row.brand_id,
            name: row.brand_name ?? 'SIN MARCA',
            products: row.products,
            active_products: row.active_products,
        });
    }
    return [...byCategory.values()];
}
