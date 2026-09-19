/**
 * PROVEEDORES — acceso a datos.
 *
 * Catálogo maestro del módulo de compras. Sin sucursal: al proveedor se le
 * compra desde la empresa, y la sucursal es un dato de la COMPRA.
 *
 * Aquí no hay reglas de negocio: las decisiones (NIT repetido, reactivar en
 * lugar de duplicar) están en el servicio, y su garantía última en la base.
 */
import { query } from '../config/db.js';
import { normalizeSearch } from '../utils/normalize.js';

const FIELDS = `id, nit, business_name, contact_name, phone, phone_alt, email,
                address, municipality, department, notes, is_active,
                created_by, created_at, updated_at`;

/** Forma canónica del NIT: la MISMA que aplica el validador y el trigger. */
export const canonicalNit = (value) =>
    String(value ?? '')
        .replace(/[^0-9A-Za-z]/g, '')
        .toUpperCase();

/**
 * Listado con búsqueda y paginación.
 *
 * Un solo campo de texto cubre NIT, razón social, contacto y teléfono:
 * quien está registrando una compra tiene el papel delante y escribe lo
 * primero que ve, no lo que el sistema prefiera.
 */
export async function list({ search = '', status = 'all', page = 1, pageSize = 20 } = {}) {
    const filters = [];
    const params = [];

    if (search) {
        // La consulta se lleva a la misma forma canónica con la que se
        // guardó el texto, y se compara contra `normalize_business_text(...)`
        // y no contra la columna a secas: así sigue encontrando aunque una
        // fila hubiera entrado sin normalizar por un camino externo.
        params.push(`%${normalizeSearch(search)}%`);
        const texto = `$${params.length}`;

        // NIT y teléfono son alfanuméricos sin separadores: se limpia la
        // consulta igual que el dato, para que "1234567-K" encuentre al
        // proveedor guardado como "1234567K".
        const limpio = canonicalNit(search);
        let sinSeparadores = '';
        if (limpio) {
            params.push(`%${limpio}%`);
            const p = `$${params.length}`;
            sinSeparadores = ` OR nit LIKE ${p}
                               OR COALESCE(phone, '') LIKE ${p}
                               OR COALESCE(phone_alt, '') LIKE ${p}`;
        }

        filters.push(
            `(normalize_business_text(business_name) LIKE ${texto}
              OR normalize_business_text(COALESCE(contact_name, '')) LIKE ${texto}
              OR normalize_business_text(COALESCE(municipality, '')) LIKE ${texto}
              OR normalize_business_text(COALESCE(department, '')) LIKE ${texto}${sinSeparadores})`
        );
    }
    if (status === 'active') filters.push('is_active = TRUE');
    if (status === 'inactive') filters.push('is_active = FALSE');

    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';

    const offset = (page - 1) * pageSize;
    params.push(pageSize, offset);

    const { rows } = await query(
        `SELECT ${FIELDS}, COUNT(*) OVER()::int AS total_count
           FROM suppliers
           ${where}
       ORDER BY is_active DESC, business_name
          LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params
    );

    const total = rows[0]?.total_count ?? 0;
    return {
        data: rows.map(({ total_count, ...s }) => s),
        pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) || 1 },
    };
}

export async function findById(id) {
    const { rows } = await query(`SELECT ${FIELDS} FROM suppliers WHERE id = $1`, [id]);
    return rows[0] ?? null;
}

/**
 * Proveedor ACTIVO con ese NIT. Es el que hace conflicto: el índice único
 * `ux_suppliers_nit_active` solo alcanza a los activos.
 */
export async function findActiveByNit(nit) {
    const { rows } = await query(
        `SELECT ${FIELDS} FROM suppliers WHERE nit = $1 AND is_active`,
        [canonicalNit(nit)]
    );
    return rows[0] ?? null;
}

/**
 * Proveedores INACTIVOS con ese NIT, del más reciente al más antiguo.
 * No bloquean el alta; sirven para decirle al operador que ese NIT ya
 * estuvo registrado y que puede reactivarlo en vez de duplicarlo.
 */
export async function findInactiveByNit(nit) {
    const { rows } = await query(
        `SELECT ${FIELDS} FROM suppliers
          WHERE nit = $1 AND NOT is_active
       ORDER BY updated_at DESC`,
        [canonicalNit(nit)]
    );
    return rows;
}

export async function create(data, userId = null) {
    const { rows } = await query(
        `INSERT INTO suppliers
             (nit, business_name, contact_name, phone, phone_alt, email,
              address, municipality, department, notes, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         RETURNING ${FIELDS}`,
        [
            data.nit,
            data.business_name,
            data.contact_name ?? null,
            data.phone ?? null,
            data.phone_alt ?? null,
            data.email ?? null,
            data.address ?? null,
            data.municipality ?? null,
            data.department ?? null,
            data.notes ?? null,
            userId ?? null,
        ]
    );
    return rows[0];
}

/**
 * Modificación PARCIAL de verdad.
 *
 * La sentencia se arma solo con los campos que vinieron en la petición. Es
 * lo que exige un PATCH: omitir `phone_alt` significa "no lo toques", no
 * "bórralo". Enviarlo explícitamente como null sí lo borra, y esa es la
 * única forma de quitar un dato de contacto.
 *
 * Los nombres de columna NO salen del cuerpo de la petición: se toman de
 * esta lista blanca, y los valores viajan siempre como parámetros. El
 * cuerpo ya venía validado con `.strict()`, pero construir SQL a partir de
 * claves enviadas por el cliente sería una puerta que no hay que abrir.
 */
const UPDATABLE = [
    'nit',
    'business_name',
    'contact_name',
    'phone',
    'phone_alt',
    'email',
    'address',
    'municipality',
    'department',
    'notes',
];

export async function update(id, data) {
    const sets = [];
    const params = [id];

    for (const field of UPDATABLE) {
        if (!Object.prototype.hasOwnProperty.call(data, field)) continue;
        // NIT y razón social son la identidad del proveedor: no se vacían.
        if ((field === 'nit' || field === 'business_name') && data[field] == null) continue;
        params.push(data[field]);
        sets.push(`${field} = $${params.length}`);
    }

    // Nada que cambiar: se devuelve el estado actual sin tocar `updated_at`.
    if (sets.length === 0) return findById(id);

    const { rows } = await query(
        `UPDATE suppliers SET ${sets.join(', ')}
          WHERE id = $1
      RETURNING ${FIELDS}`,
        params
    );
    return rows[0] ?? null;
}

export async function setActive(id, isActive) {
    const { rows } = await query(
        `UPDATE suppliers SET is_active = $2 WHERE id = $1 RETURNING ${FIELDS}`,
        [id, isActive]
    );
    return rows[0] ?? null;
}
