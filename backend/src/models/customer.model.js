import { query } from '../config/db.js';
import { normalizeSearch, normalizeDpi } from '../utils/normalize.js';

const FIELDS = `id, dpi, full_name, phone, phone_alt, email, address, address_ref,
                municipality, department, latitude, longitude, notes,
                is_active, created_at, updated_at`;

/**
 * Listado con búsqueda y paginación.
 * La búsqueda es la operación más usada del día a día: cubre nombre, DPI y
 * teléfono en un solo campo de texto.
 */
export async function list({ search = '', status = 'all', page = 1, pageSize = 20 }) {
    const filters = [];
    const params = [];

    if (search) {
        // La consulta se lleva a la MISMA forma canónica con la que se guardó
        // el nombre. Por eso "josé lópez", "JOSE LOPEZ" y "  José   López "
        // encuentran el mismo cliente.
        //
        // El nombre se compara contra `normalize_business_text(full_name)` y
        // no contra la columna a secas: así la búsqueda sigue funcionando
        // aunque alguna fila entrara sin normalizar por un camino externo.
        params.push(`%${normalizeSearch(search)}%`);
        const name = `$${params.length}`;

        // DPI y teléfono son numéricos: se limpian de guiones y espacios para
        // que "1234-56789-0101" encuentre al cliente igual que
        // "1234567890101". Solo se añade el filtro si la consulta trae algún
        // dígito, para no mandar un parámetro que la consulta no usa.
        const digits = normalizeDpi(search);
        let digitFilter = '';
        if (digits) {
            params.push(`%${digits}%`);
            digitFilter = ` OR dpi LIKE $${params.length} OR phone LIKE $${params.length}`;
        }

        filters.push(
            `(normalize_business_text(full_name) LIKE ${name}
              OR normalize_business_text(COALESCE(municipality, '')) LIKE ${name}
              OR normalize_business_text(COALESCE(department, '')) LIKE ${name}${digitFilter})`
        );
    }
    if (status === 'active') filters.push('is_active = TRUE');
    if (status === 'inactive') filters.push('is_active = FALSE');

    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';

    const offset = (page - 1) * pageSize;
    params.push(pageSize, offset);

    const { rows } = await query(
        `SELECT ${FIELDS}, COUNT(*) OVER()::int AS total_count
           FROM customers
           ${where}
       ORDER BY full_name
          LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params
    );

    const total = rows[0]?.total_count ?? 0;
    return {
        data: rows.map(({ total_count, ...c }) => c),
        pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) || 1 },
    };
}

export async function findById(id) {
    const { rows } = await query(`SELECT ${FIELDS} FROM customers WHERE id = $1`, [id]);
    return rows[0] ?? null;
}

export async function findByDpi(dpi) {
    const { rows } = await query(`SELECT ${FIELDS} FROM customers WHERE dpi = $1`, [dpi]);
    return rows[0] ?? null;
}

export async function create(data, userId) {
    const { rows } = await query(
        `INSERT INTO customers
             (dpi, full_name, phone, phone_alt, email, address, address_ref,
              municipality, department, latitude, longitude, notes, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         RETURNING ${FIELDS}`,
        [
            data.dpi,
            data.full_name,
            data.phone,
            data.phone_alt ?? null,
            data.email ?? null,
            data.address,
            data.address_ref ?? null,
            data.municipality ?? null,
            data.department ?? null,
            data.latitude ?? null,
            data.longitude ?? null,
            data.notes ?? null,
            userId ?? null,
        ]
    );
    return rows[0];
}

export async function update(id, data) {
    const { rows } = await query(
        `UPDATE customers SET
             dpi         = COALESCE($2, dpi),
             full_name   = COALESCE($3, full_name),
             phone       = COALESCE($4, phone),
             phone_alt   = $5,
             email       = $6,
             address      = COALESCE($7, address),
             address_ref  = $8,
             municipality = $9,
             department   = $10,
             latitude     = $11,
             longitude    = $12,
             notes        = $13
         WHERE id = $1
         RETURNING ${FIELDS}`,
        [
            id,
            data.dpi ?? null,
            data.full_name ?? null,
            data.phone ?? null,
            data.phone_alt ?? null,
            data.email ?? null,
            data.address ?? null,
            data.address_ref ?? null,
            data.municipality ?? null,
            data.department ?? null,
            data.latitude ?? null,
            data.longitude ?? null,
            data.notes ?? null,
        ]
    );
    return rows[0] ?? null;
}

export async function setActive(id, isActive) {
    const { rows } = await query(
        `UPDATE customers SET is_active = $2 WHERE id = $1 RETURNING ${FIELDS}`,
        [id, isActive]
    );
    return rows[0] ?? null;
}

/** Resumen financiero del cliente (vista derivada, sin datos duplicados). */
export async function getAccount(id) {
    const { rows } = await query(`SELECT * FROM v_customer_accounts WHERE customer_id = $1`, [id]);
    return rows[0] ?? null;
}
