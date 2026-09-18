import { query } from '../config/db.js';
import { workflowDetails } from './creditWorkflow.model.js';

/**
 * Acceso a datos de solicitudes de crédito.
 * Todo el SQL es parametrizado: ningún valor se concatena en la consulta.
 */

/** Estados en los que una solicitud está disponible para verificación. */
export const VERIFIABLE_STATUSES = Object.freeze(['SOLICITADO', 'EN_VERIFICACION']);

/** Cliente con los datos que se congelan en la solicitud. */
export async function getCustomerById(customerId, db = { query }) {
    const { rows } = await db.query(
        `SELECT id, dpi, full_name, phone, phone_alt, email,
                address, address_ref, municipality, department,
                latitude, longitude, is_active
           FROM customers
          WHERE id = $1`,
        [customerId]
    );
    return rows[0] ?? null;
}

/**
 * Producto vigente para construir el snapshot comercial.
 * Dentro de la transacción se bloquea en modo compartido: el costo no puede
 * cambiar entre el cálculo y el registro de la solicitud.
 */
export async function getProductForApplication(productId, db = { query }) {
    const { rows } = await db.query(
        `SELECT id, code, name, cost, is_active
           FROM products
          WHERE id = $1
          FOR SHARE`,
        [productId]
    );
    return rows[0] ?? null;
}

/** Plan PREDEFINIDO activo de un producto para un plazo. */
export async function getFinancingPlan(productId, installmentsCount, db = { query }) {
    const { rows } = await db.query(
        `SELECT id, product_id, installments_count, financing_percentage,
                minimum_price, minimum_installment, is_active
           FROM product_financing_plans
          WHERE product_id = $1
            AND installments_count = $2
            AND is_active = TRUE
          FOR SHARE`,
        [productId, installmentsCount]
    );
    return rows[0] ?? null;
}

/** Sucursal asignada al usuario. La sucursal nunca se toma del request. */
export async function getUserBranch(userId, db = { query }) {
    const { rows } = await db.query(
        `SELECT u.id AS user_id, u.branch_id, b.name AS branch_name, b.is_active AS branch_is_active
           FROM users u
           LEFT JOIN branches b ON b.id = u.branch_id
          WHERE u.id = $1`,
        [userId]
    );
    return rows[0] ?? null;
}

/** Solicitud previa del mismo usuario con la misma clave de idempotencia. */
export async function findByRequestKey(userId, clientRequestId, db = { query }) {
    const { rows } = await db.query(
        `SELECT id, request_fingerprint
           FROM credit_applications
          WHERE created_by = $1 AND client_request_id = $2`,
        [userId, clientRequestId]
    );
    return rows[0] ?? null;
}

/**
 * Crea la solicitud y sus líneas con el `client` de la transacción del
 * servicio, para que ambas se registren atómicamente.
 */
export async function createApplication(client, application, items) {
    const columns = [
        'customer_id',
        'branch_id',
        'created_by',
        'customer_dpi_snapshot',
        'customer_full_name_snapshot',
        'customer_phone_snapshot',
        'customer_phone_alt_snapshot',
        'customer_email_snapshot',
        'customer_address_snapshot',
        'customer_address_ref_snapshot',
        'customer_municipality_snapshot',
        'customer_department_snapshot',
        'housing_type_snapshot',
        'residence_time_snapshot',
        'employer_name_snapshot',
        'employer_address_snapshot',
        'employer_phone_snapshot',
        'employment_time_snapshot',
        'job_position_snapshot',
        'monthly_income_snapshot',
        'labor_reference_name_snapshot',
        'labor_reference_phone_snapshot',
        'labor_reference_relation_snapshot',
        'personal_reference_name_snapshot',
        'personal_reference_phone_snapshot',
        'personal_reference_relation_snapshot',
        'guarantor_name_snapshot',
        'guarantor_dpi_snapshot',
        'guarantor_phone_snapshot',
        'guarantor_address_snapshot',
        'guarantor_relation_snapshot',
        'proposed_down_payment',
        'client_request_id',
        'request_fingerprint',
        'credit_type',
        'customer_confirmation_id',
    ];
    // Los nombres de columna son constantes de este archivo, no entrada del
    // usuario; los valores viajan siempre como parámetros.
    const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ');

    const { rows } = await client.query(
        `INSERT INTO credit_applications (${columns.join(', ')}, status)
         VALUES (${placeholders}, 'SOLICITADO')
         RETURNING id`,
        columns.map((column) => application[column] ?? null)
    );
    const applicationId = rows[0].id;

    for (const item of items) {
        await client.query(
            `INSERT INTO credit_application_items (
                credit_application_id, product_id, quantity,
                product_code_snapshot, product_name_snapshot, cost_snapshot,
                financing_type, installments_count, financing_percentage_snapshot,
                minimum_price_snapshot, minimum_installment_snapshot,
                proposed_price, proposed_installment, proposed_down_payment,
                configured_minimum_price_snapshot, configured_minimum_installment_snapshot
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 0, $14, $15)`,
            [
                applicationId,
                item.product_id,
                item.quantity,
                item.product_code_snapshot,
                item.product_name_snapshot,
                item.cost_snapshot,
                item.financing_type,
                item.installments_count,
                item.financing_percentage_snapshot,
                item.minimum_price_snapshot,
                item.minimum_installment_snapshot,
                item.proposed_price,
                item.proposed_installment,
                item.configured_minimum_price_snapshot,
                item.configured_minimum_installment_snapshot,
            ]
        );
    }

    await insertStatusHistory(client, {
        applicationId,
        fromStatus: null,
        toStatus: 'SOLICITADO',
        userId: application.created_by,
        reason: null,
    });

    return applicationId;
}

/** Deja constancia de un cambio de estado (tabla de solo inserción). */
export async function insertStatusHistory(client, { applicationId, fromStatus, toStatus, userId, reason = null }) {
    await client.query(
        `INSERT INTO credit_application_status_history
             (credit_application_id, from_status, to_status, changed_by, reason)
         VALUES ($1, $2, $3, $4, $5)`,
        [applicationId, fromStatus, toStatus, userId, reason]
    );
}

/**
 * ¿El cliente ya tiene operaciones (solicitudes o ventas)? Devuelve la fecha
 * de la última y la última reconfirmación de datos.
 */
export async function customerConfirmationState(client, customerId) {
    const { rows } = await client.query(
        `SELECT GREATEST(
                    (SELECT MAX(created_at) FROM credit_applications WHERE customer_id = $1),
                    (SELECT MAX(created_at) FROM sales WHERE customer_id = $1)
                ) AS last_operation_at,
                c.id AS confirmation_id,
                c.confirmed_at
           FROM (SELECT 1) x
           LEFT JOIN LATERAL (
                SELECT id, confirmed_at FROM customer_confirmations
                 WHERE customer_id = $1
              ORDER BY confirmed_at DESC, id DESC
                 LIMIT 1
           ) c ON TRUE`,
        [customerId]
    );
    return rows[0];
}

/** Bloquea al cliente: serializa las solicitudes nuevas de un mismo cliente. */
export async function lockCustomer(client, customerId) {
    await client.query('SELECT id FROM customers WHERE id = $1 FOR UPDATE', [customerId]);
}

/**
 * Traduce el alcance del usuario a una condición SQL.
 *
 * @param {{global: boolean, own: boolean, branch: boolean, userId: number, branchId: number|null}} scope
 * @param {Array} params  se le agregan los parámetros necesarios
 * @returns {string} condición SQL (siempre entre paréntesis)
 */
function scopeCondition(scope, params) {
    if (scope.global) return '(TRUE)';

    const parts = [];
    if (scope.own) {
        params.push(scope.userId);
        parts.push(`v.created_by = $${params.length}`);
    }
    if (scope.branch && scope.branchId) {
        params.push(scope.branchId);
        const branchParam = `$${params.length}`;
        params.push(VERIFIABLE_STATUSES);
        parts.push(`(v.branch_id = ${branchParam} AND v.status = ANY($${params.length}::text[]))`);
    }
    return parts.length ? `(${parts.join(' OR ')})` : '(FALSE)';
}

/** Listado paginado con filtros, SIEMPRE limitado por el alcance. */
export async function list(filters, scope, timezone) {
    const params = [];
    const where = [scopeCondition(scope, params)];

    const add = (sql, value) => {
        params.push(value);
        where.push(sql.replaceAll('?', `$${params.length}`));
    };

    if (filters.status?.length) add('v.status = ANY(?::text[])', filters.status);
    if (filters.branch_id) add('v.branch_id = ?', filters.branch_id);
    if (filters.customer_id) add('v.customer_id = ?', filters.customer_id);
    if (filters.created_by) add('v.created_by = ?', filters.created_by);
    if (filters.financing_type) add('? = ANY(v.financing_types)', filters.financing_type);
    if (filters.credit_type) add('v.credit_type = ?', filters.credit_type);
    if (typeof filters.requires_price_exception === 'boolean') {
        add('v.requires_price_exception = ?', filters.requires_price_exception);
    }
    if (filters.from || filters.to) {
        params.push(timezone);
        const tz = `$${params.length}`;
        if (filters.from) add(`(v.created_at AT TIME ZONE ${tz})::date >= ?::date`, filters.from);
        if (filters.to) add(`(v.created_at AT TIME ZONE ${tz})::date <= ?::date`, filters.to);
    }
    if (filters.search) {
        const { normalized, digits } = filters.search;
        const alternatives = [];
        if (normalized) {
            params.push(`%${normalized}%`);
            alternatives.push(`v.customer_full_name_snapshot LIKE $${params.length}`);
        }
        if (digits) {
            params.push(`${digits}%`);
            alternatives.push(`v.customer_dpi_snapshot LIKE $${params.length}`);
            params.push(digits);
            alternatives.push(`v.application_number::text = $${params.length}`);
        }
        if (alternatives.length) where.push(`(${alternatives.join(' OR ')})`);
    }

    const page = filters.page;
    const pageSize = filters.pageSize;
    params.push(pageSize, (page - 1) * pageSize);

    const { rows } = await query(
        `SELECT v.*, COUNT(*) OVER()::int AS total_count
           FROM v_credit_applications v
          WHERE ${where.join(' AND ')}
       ORDER BY v.created_at DESC, v.id DESC
          LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params
    );

    const total = rows[0]?.total_count ?? 0;
    return {
        data: rows.map(({ total_count, ...row }) => row),
        pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) || 1 },
    };
}

/**
 * Solicitud completa (datos congelados + totales derivados + líneas),
 * limitada por el alcance. Fuera de alcance devuelve null, igual que si no
 * existiera: no se confirma la existencia de expedientes ajenos.
 */
export async function findById(applicationId, scope, db = { query }) {
    const params = [applicationId];
    const scopeSql = scopeCondition(scope, params);

    const { rows } = await db.query(
        `SELECT ca.*,
                v.branch_code, v.branch_name, v.created_by_username,
                v.items_count, v.quantity_total, v.total,
                v.proposed_down_payment AS proposed_down_payment_effective,
                v.financed_amount, v.installments_count, v.proposed_installment,
                v.requires_price_exception, v.financing_types,
                v.requires_installment_exception, v.requires_exception,
                (SELECT s.status FROM sales s WHERE s.id = ca.sale_id) AS sale_status
           FROM v_credit_applications v
           JOIN credit_applications ca ON ca.id = v.id
          WHERE v.id = $1 AND ${scopeSql}`,
        params
    );
    const application = rows[0];
    if (!application) return null;

    const { rows: items } = await db.query(
        `SELECT * FROM v_credit_application_items
          WHERE credit_application_id = $1
          ORDER BY id`,
        [applicationId]
    );

    // Los campos técnicos de idempotencia no forman parte del expediente.
    const { client_request_id, request_fingerprint, proposed_down_payment_effective, ...rest } = application;
    const workflow = await workflowDetails(applicationId, db);
    return { ...rest, proposed_down_payment: proposed_down_payment_effective, items, ...workflow };
}
