import { query } from '../config/db.js';

/**
 * Acceso a datos del flujo de crédito (Bloque 3.2).
 * Toda escritura recibe el `client` de la transacción del servicio.
 */

/** Bloquea la solicitud para decidir su siguiente estado sin carreras. */
export async function lockApplication(client, applicationId) {
    const { rows } = await client.query('SELECT * FROM credit_applications WHERE id = $1 FOR UPDATE', [applicationId]);
    return rows[0] ?? null;
}

export async function updateStatus(client, applicationId, status, extra = {}) {
    const sets = ['status = $2'];
    const params = [applicationId, status];
    for (const [column, value] of Object.entries(extra)) {
        // Los nombres de columna vienen del servicio (constantes), nunca del request.
        params.push(value);
        sets.push(`${column} = $${params.length}`);
    }
    await client.query(`UPDATE credit_applications SET ${sets.join(', ')} WHERE id = $1`, params);
}

export async function insertVerification(client, v) {
    const { rows } = await client.query(
        `INSERT INTO credit_verifications (
             credit_application_id, verified_by, result,
             address_matches, housing_verified, residence_time_matches,
             employment_verified, labor_reference_confirmed, personal_reference_confirmed,
             comments, recommendation, latitude, longitude
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         RETURNING *`,
        [
            v.credit_application_id,
            v.verified_by,
            v.result,
            v.address_matches,
            v.housing_verified,
            v.residence_time_matches,
            v.employment_verified ?? null,
            v.labor_reference_confirmed ?? null,
            v.personal_reference_confirmed ?? null,
            v.comments ?? null,
            v.recommendation,
            v.latitude ?? null,
            v.longitude ?? null,
        ]
    );
    return rows[0];
}

export async function latestVerification(client, applicationId) {
    const { rows } = await client.query(
        `SELECT * FROM credit_verifications
          WHERE credit_application_id = $1
       ORDER BY verification_date DESC, id DESC
          LIMIT 1`,
        [applicationId]
    );
    return rows[0] ?? null;
}

/** Líneas VIGENTES bloqueadas para modificarlas (las retiradas ya no se tocan). */
export async function lockItems(client, applicationId) {
    const { rows } = await client.query(
        `SELECT * FROM credit_application_items
          WHERE credit_application_id = $1 AND NOT is_void
       ORDER BY id FOR UPDATE`,
        [applicationId]
    );
    return rows;
}

/** Líneas con los indicadores calculados (vista), dentro de la transacción. */
export async function itemsWithFlags(client, applicationId) {
    const { rows } = await client.query(
        `SELECT * FROM v_credit_application_items
          WHERE credit_application_id = $1 AND NOT is_void
       ORDER BY id`,
        [applicationId]
    );
    return rows;
}

export async function totals(client, applicationId) {
    const { rows } = await client.query(
        `SELECT total, proposed_down_payment, financed_amount, requires_exception
           FROM v_credit_applications WHERE id = $1`,
        [applicationId]
    );
    return rows[0] ?? null;
}

export async function updateItemConditions(client, itemId, line) {
    await client.query(
        `UPDATE credit_application_items SET
             cost_snapshot = $2,
             financing_type = $3,
             installments_count = $4,
             financing_percentage_snapshot = $5,
             minimum_price_snapshot = $6,
             minimum_installment_snapshot = $7,
             proposed_price = $8,
             proposed_installment = $9,
             configured_minimum_price_snapshot = $10,
             configured_minimum_installment_snapshot = $11
         WHERE id = $1`,
        [
            itemId,
            line.cost_snapshot,
            line.financing_type,
            line.installments_count,
            line.financing_percentage_snapshot,
            line.minimum_price_snapshot,
            line.minimum_installment_snapshot,
            line.proposed_price,
            line.proposed_installment,
            line.configured_minimum_price_snapshot,
            line.configured_minimum_installment_snapshot,
        ]
    );
}

export async function setProposedDownPayment(client, applicationId, amount) {
    await client.query('UPDATE credit_applications SET proposed_down_payment = $2 WHERE id = $1', [applicationId, amount]);
}

export async function insertChange(client, c) {
    await client.query(
        `INSERT INTO credit_application_changes
             (credit_application_id, credit_application_item_id, field, old_value, new_value, changed_by, comment)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [c.applicationId, c.itemId ?? null, c.field, c.oldValue, c.newValue, c.userId, c.comment ?? null]
    );
}

export async function insertDecision(client, d) {
    const { rows } = await client.query(
        `INSERT INTO credit_decisions (credit_application_id, decided_by, decision, decision_comment)
         VALUES ($1,$2,$3,$4)
         RETURNING *`,
        [d.applicationId, d.userId, d.decision, d.comment ?? null]
    );
    return rows[0];
}

export async function insertException(client, e) {
    await client.query(
        `INSERT INTO credit_decision_exceptions (
             credit_decision_id, credit_application_item_id, exception_kind,
             minimum_unit_price, proposed_unit_price, unit_price_difference,
             minimum_line_installment, proposed_line_installment,
             reason, authorized_by, branch_id, source
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
            e.decisionId,
            e.itemId,
            e.kind,
            e.minimumUnitPrice,
            e.proposedUnitPrice,
            e.unitPriceDifference,
            e.minimumLineInstallment,
            e.proposedLineInstallment,
            e.reason,
            e.userId,
            e.branchId,
            e.source ?? 'DECISION',
        ]
    );
}

/** Decisión vigente (la única) de una solicitud. */
export async function latestDecision(client, applicationId) {
    const { rows } = await client.query(
        `SELECT * FROM credit_decisions WHERE credit_application_id = $1 ORDER BY decision_date DESC, id DESC LIMIT 1`,
        [applicationId]
    );
    return rows[0] ?? null;
}

/**
 * Líneas bajo el mínimo SIN una autorización que cubra sus condiciones
 * actuales (mismo mínimo, precio y cuota que los autorizados).
 */
export async function unauthorizedExceptionLines(client, applicationId) {
    const { rows } = await client.query(
        `SELECT l.*
           FROM v_credit_application_items l
          WHERE l.credit_application_id = $1
            AND NOT l.is_void
            AND l.requires_exception
            AND NOT EXISTS (
                SELECT 1
                  FROM credit_decision_exceptions e
                  JOIN credit_decisions d ON d.id = e.credit_decision_id AND d.decision = 'APROBADO'
                 WHERE e.credit_application_item_id = l.id
                   AND e.minimum_unit_price = l.minimum_unit_price
                   AND e.proposed_unit_price = l.proposed_unit_price
                   AND e.minimum_line_installment = l.line_minimum_installment
                   AND e.proposed_line_installment = l.line_installment
            )
       ORDER BY l.id`,
        [applicationId]
    );
    return rows;
}

// ---------------------------------------------------------------------
// EXPEDIENTE (lectura)
// ---------------------------------------------------------------------

export async function workflowDetails(applicationId, db = { query }) {
    const [verifications, decisions, exceptions, history, changes, finalReviews] = await Promise.all([
        db.query(
            `SELECT v.*, u.username AS verified_by_username, u.full_name AS verified_by_name
               FROM credit_verifications v
               LEFT JOIN users u ON u.id = v.verified_by
              WHERE v.credit_application_id = $1
           ORDER BY v.verification_date, v.id`,
            [applicationId]
        ),
        db.query(
            `SELECT d.*, u.username AS decided_by_username, u.full_name AS decided_by_name
               FROM credit_decisions d
               LEFT JOIN users u ON u.id = d.decided_by
              WHERE d.credit_application_id = $1
           ORDER BY d.decision_date, d.id`,
            [applicationId]
        ),
        db.query(
            `SELECT e.*, u.username AS authorized_by_username
               FROM credit_decision_exceptions e
               JOIN credit_decisions d ON d.id = e.credit_decision_id
               LEFT JOIN users u ON u.id = e.authorized_by
              WHERE d.credit_application_id = $1
           ORDER BY e.id`,
            [applicationId]
        ),
        db.query(
            `SELECT h.id, h.from_status, h.to_status, h.changed_at, h.reason, u.username AS changed_by_username
               FROM credit_application_status_history h
               LEFT JOIN users u ON u.id = h.changed_by
              WHERE h.credit_application_id = $1
           ORDER BY h.changed_at, h.id`,
            [applicationId]
        ),
        db.query(
            `SELECT c.id, c.credit_application_item_id, c.field, c.old_value, c.new_value, c.changed_at, c.comment,
                    u.username AS changed_by_username
               FROM credit_application_changes c
               LEFT JOIN users u ON u.id = c.changed_by
              WHERE c.credit_application_id = $1
           ORDER BY c.changed_at, c.id`,
            [applicationId]
        ),
        db.query(
            `SELECT f.id, f.result, f.reviewed_at, f.comment, f.triggered_at,
                    u.username AS reviewed_by_username, t.username AS triggered_by_username
               FROM credit_final_reviews f
               LEFT JOIN users u ON u.id = f.reviewed_by
               LEFT JOIN users t ON t.id = f.triggered_by
              WHERE f.credit_application_id = $1
           ORDER BY f.reviewed_at, f.id`,
            [applicationId]
        ),
    ]);
    return {
        verifications: verifications.rows,
        decision: decisions.rows.at(-1) ?? null,
        exceptions: exceptions.rows,
        status_history: history.rows,
        changes: changes.rows,
        final_reviews: finalReviews.rows,
    };
}

/** Historial crediticio del cliente para la evaluación (regla 11). */
export async function customerCreditHistory(customerId, excludeApplicationId) {
    const [account, applications, sales] = await Promise.all([
        query('SELECT * FROM v_customer_accounts WHERE customer_id = $1', [customerId]),
        query(
            `SELECT id, application_number, status, credit_type, total, created_at
               FROM v_credit_applications v
              WHERE customer_id = $1 AND id <> $2
           ORDER BY created_at DESC`,
            [customerId, excludeApplicationId]
        ),
        query(
            `SELECT id, sale_number, sale_date, payment_mode, total, paid_amount, balance,
                    installments_overdue, account_status
               FROM v_sales WHERE customer_id = $1
           ORDER BY sale_date DESC, id DESC`,
            [customerId]
        ),
    ]);
    return { account: account.rows[0] ?? null, applications: applications.rows, sales: sales.rows };
}

// ---------------------------------------------------------------------
// LÍNEAS: ALTA Y RETIRO LÓGICO (012)
// ---------------------------------------------------------------------

/** Agrega una línea nueva a una solicitud que todavía admite cambios. */
export async function insertItem(client, applicationId, line) {
    const { rows } = await client.query(
        `INSERT INTO credit_application_items (
             credit_application_id, product_id, quantity,
             product_code_snapshot, product_name_snapshot, cost_snapshot,
             financing_type, installments_count, financing_percentage_snapshot,
             minimum_price_snapshot, minimum_installment_snapshot,
             proposed_price, proposed_installment, proposed_down_payment,
             configured_minimum_price_snapshot, configured_minimum_installment_snapshot
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 0, $14, $15)
         RETURNING *`,
        [
            applicationId,
            line.product_id,
            line.quantity,
            line.product_code_snapshot,
            line.product_name_snapshot,
            line.cost_snapshot,
            line.financing_type,
            line.installments_count,
            line.financing_percentage_snapshot,
            line.minimum_price_snapshot,
            line.minimum_installment_snapshot,
            line.proposed_price,
            line.proposed_installment,
            line.configured_minimum_price_snapshot,
            line.configured_minimum_installment_snapshot,
        ]
    );
    return rows[0];
}

/**
 * Retira una línea. NUNCA se borra: la fila se conserva íntegra con
 * `is_void = true` y deja de contar en totales, cuotas y excepciones.
 */
export async function voidItem(client, itemId, userId) {
    const { rows } = await client.query(
        `UPDATE credit_application_items
            SET is_void = TRUE, voided_at = now(), voided_by = $2
          WHERE id = $1 AND NOT is_void
         RETURNING id`,
        [itemId, userId]
    );
    return rows[0] ?? null;
}

/** Cantidad de la línea (el resto de condiciones las recalcula buildLine). */
export async function updateItemQuantity(client, itemId, quantity) {
    await client.query('UPDATE credit_application_items SET quantity = $2 WHERE id = $1', [itemId, quantity]);
}

// ---------------------------------------------------------------------
// ÚLTIMA REVISIÓN DE ADMINISTRACIÓN / GERENCIA (012)
// ---------------------------------------------------------------------

/** Enciende o apaga la bandera que impide concretar. */
export async function setFinalReviewFlag(client, applicationId, required, userId) {
    await client.query(
        `UPDATE credit_applications
            SET requires_final_review = $2,
                final_review_requested_at = CASE WHEN $2 THEN now() ELSE final_review_requested_at END,
                final_review_requested_by = CASE WHEN $2 THEN $3::bigint ELSE final_review_requested_by END
          WHERE id = $1`,
        [applicationId, required, userId]
    );
}

export async function insertFinalReview(client, review) {
    const { rows } = await client.query(
        `INSERT INTO credit_final_reviews
             (credit_application_id, result, reviewed_by, triggered_by, triggered_at, comment)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING *`,
        [
            review.applicationId,
            review.result,
            review.userId,
            review.triggeredBy ?? null,
            review.triggeredAt ?? null,
            review.comment ?? null,
        ]
    );
    return rows[0];
}
