/**
 * CONSULTAS DE CARTERA (bloque 5).
 *
 * Todo sale de `v_collections_portfolio` y `v_collections_installments`, que
 * derivan el atraso y el tramo de morosidad de `due_date` y de los pagos ya
 * aplicados. Aquí NO se recalcula ni se almacena nada.
 *
 * El alcance de cartera propia (regla U6) se aplica en el SQL con el mismo
 * fragmento que ya usan pagos y cobranza: lo que no le corresponde al usuario
 * no sale de la base de datos.
 */
import { query } from '../config/db.js';
import { ownPortfolioFilter } from '../services/scope.service.js';

const BUCKETS = ['AL_DIA', '1_30', '31_60', '61_90', 'MAS_90'];

function scopeFilter(scope, params, filters) {
    if (scope && !scope.global) filters.push(ownPortfolioFilter(scope, params));
}

/** Cartera: un crédito por fila. */
export async function portfolio({
    scope = null, status = '', bucket = '', customerId = null, branchId = null,
    onlyOverdue = false, page = 1, pageSize = 20,
}) {
    const filters = [];
    const params = [];
    scopeFilter(scope, params, filters);

    if (status) {
        params.push(status);
        filters.push(`account_status = $${params.length}`);
    }
    if (bucket) {
        params.push(bucket);
        filters.push(`overdue_bucket = $${params.length}`);
    }
    if (customerId) {
        params.push(customerId);
        filters.push(`customer_id = $${params.length}`);
    }
    if (branchId) {
        params.push(branchId);
        filters.push(`branch_id = $${params.length}`);
    }
    if (onlyOverdue) filters.push('days_overdue > 0');
    filters.push('balance > 0');

    const offset = (page - 1) * pageSize;
    params.push(pageSize, offset);

    const { rows } = await query(
        `SELECT *, COUNT(*) OVER()::int AS total_count
           FROM v_collections_portfolio
          WHERE ${filters.join(' AND ')}
       ORDER BY days_overdue DESC, next_due_date NULLS LAST, sale_id
          LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params
    );
    const total = rows[0]?.total_count ?? 0;
    return {
        data: rows.map(({ total_count, ...r }) => r),
        pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) || 1 },
    };
}

/** Cuotas, con filtro por estado, tramo de mora, cliente, venta o sucursal. */
export async function installments({
    scope = null, saleId = null, customerId = null, branchId = null,
    status = '', bucket = '', onlyOverdue = false, onlyPending = false,
    from = null, to = null, page = 1, pageSize = 20,
}) {
    const filters = ["sale_status = 'activa'"];
    const params = [];
    scopeFilter(scope, params, filters);

    if (saleId) {
        params.push(saleId);
        filters.push(`sale_id = $${params.length}`);
    }
    if (customerId) {
        params.push(customerId);
        filters.push(`customer_id = $${params.length}`);
    }
    if (branchId) {
        params.push(branchId);
        filters.push(`branch_id = $${params.length}`);
    }
    if (status) {
        params.push(status);
        filters.push(`status = $${params.length}`);
    }
    if (bucket) {
        params.push(bucket);
        filters.push(`overdue_bucket = $${params.length}`);
    }
    if (from) {
        params.push(from);
        filters.push(`due_date >= $${params.length}`);
    }
    if (to) {
        params.push(to);
        filters.push(`due_date <= $${params.length}`);
    }
    if (onlyOverdue) filters.push("balance > 0 AND due_date < app_today()");
    if (onlyPending) filters.push('balance > 0');

    const offset = (page - 1) * pageSize;
    params.push(pageSize, offset);

    const { rows } = await query(
        `SELECT *, COUNT(*) OVER()::int AS total_count
           FROM v_collections_installments
          WHERE ${filters.join(' AND ')}
       ORDER BY due_date, sale_id, installment_number
          LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params
    );
    const total = rows[0]?.total_count ?? 0;
    return {
        data: rows.map(({ total_count, ...r }) => r),
        pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) || 1 },
    };
}

/** Resumen de morosidad por tramo: lo que encabeza la pantalla de cobranza. */
export async function summary({ scope = null, branchId = null }) {
    const filters = ['balance > 0'];
    const params = [];
    scopeFilter(scope, params, filters);
    if (branchId) {
        params.push(branchId);
        filters.push(`branch_id = $${params.length}`);
    }

    const { rows } = await query(
        `SELECT overdue_bucket                              AS bucket,
                COUNT(*)::int                               AS creditos,
                COUNT(DISTINCT customer_id)::int            AS clientes,
                COALESCE(SUM(balance), 0)::numeric(12,2)    AS saldo,
                COALESCE(SUM(overdue_balance), 0)::numeric(12,2) AS saldo_vencido
           FROM v_collections_portfolio
          WHERE ${filters.join(' AND ')}
       GROUP BY overdue_bucket`,
        params
    );

    const porTramo = Object.fromEntries(rows.map((r) => [r.bucket, r]));
    const vacio = { creditos: 0, clientes: 0, saldo: '0.00', saldo_vencido: '0.00' };
    const buckets = BUCKETS.map((b) => ({ bucket: b, ...vacio, ...(porTramo[b] ?? {}) }));

    const totales = buckets.reduce(
        (acc, b) => ({
            creditos: acc.creditos + Number(b.creditos),
            saldo: acc.saldo + Number(b.saldo),
            saldo_vencido: acc.saldo_vencido + Number(b.saldo_vencido),
        }),
        { creditos: 0, saldo: 0, saldo_vencido: 0 }
    );

    return {
        buckets,
        totales: {
            creditos: totales.creditos,
            saldo: totales.saldo.toFixed(2),
            saldo_vencido: totales.saldo_vencido.toFixed(2),
        },
    };
}

/** Cartera de UN cliente: todos sus créditos vivos. */
export async function customerPortfolio(customerId, scope = null) {
    const filters = ['customer_id = $1'];
    const params = [customerId];
    scopeFilter(scope, params, filters);

    const [creditos, cliente] = await Promise.all([
        query(
            `SELECT * FROM v_collections_portfolio
              WHERE ${filters.join(' AND ')}
           ORDER BY days_overdue DESC, sale_date DESC`,
            params
        ),
        query(
            `SELECT id, dpi, full_name, phone, email, address, is_active FROM customers WHERE id = $1`,
            [customerId]
        ),
    ]);

    if (!cliente.rows[0]) return null;

    const total = creditos.rows.reduce(
        (acc, s) => ({
            saldo: acc.saldo + Number(s.balance),
            vencido: acc.vencido + Number(s.overdue_balance),
            cuotas_vencidas: acc.cuotas_vencidas + Number(s.installments_overdue),
        }),
        { saldo: 0, vencido: 0, cuotas_vencidas: 0 }
    );

    return {
        customer: cliente.rows[0],
        credits: creditos.rows,
        totals: {
            creditos: creditos.rows.length,
            saldo: total.saldo.toFixed(2),
            saldo_vencido: total.vencido.toFixed(2),
            cuotas_vencidas: total.cuotas_vencidas,
            dias_atraso_max: creditos.rows.reduce((m, s) => Math.max(m, Number(s.days_overdue)), 0),
        },
    };
}

/** Una fila de cartera concreta, con el alcance ya aplicado. */
export async function portfolioSale(saleId, scope = null) {
    const filters = ['sale_id = $1'];
    const params = [saleId];
    scopeFilter(scope, params, filters);
    const { rows } = await query(
        `SELECT * FROM v_collections_portfolio WHERE ${filters.join(' AND ')}`, params);
    return rows[0] ?? null;
}

export async function saleInstallments(saleId) {
    const { rows } = await query(
        `SELECT * FROM v_collections_installments WHERE sale_id = $1 ORDER BY installment_number`,
        [saleId]
    );
    return rows;
}

/** Cuotas SUSTITUIDAS por una reestructuración: historial, no deuda viva. */
export async function supersededInstallments(saleId) {
    const { rows } = await query(
        `SELECT vi.id AS installment_id, vi.number AS installment_number, vi.due_date, vi.amount,
                vi.paid_amount, vi.balance, vi.restructuring_id
           FROM v_installments vi
          WHERE vi.sale_id = $1 AND vi.is_superseded
       ORDER BY vi.number`,
        [saleId]
    );
    return rows;
}

export async function restructuringsOf(saleId) {
    const { rows } = await query(
        `SELECT r.*, u.username AS approved_by_username
           FROM sale_restructurings r
           LEFT JOIN users u ON u.id = r.approved_by
          WHERE r.sale_id = $1
       ORDER BY r.approved_at, r.id`,
        [saleId]
    );
    return rows;
}
