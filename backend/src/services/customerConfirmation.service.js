import { query, withTransaction } from '../config/db.js';
import { AppError } from '../utils/AppError.js';
import { recordEvent, EVENT_TYPES, dispatchInBackground } from './events.service.js';

const CUSTOMER_FIELDS = [
    'dpi', 'full_name', 'phone', 'phone_alt', 'email', 'address', 'address_ref',
    'municipality', 'department', 'latitude', 'longitude', 'notes',
];

/**
 * RECONFIRMACIÓN DE DATOS DEL CLIENTE (regla 9 / decisión 8).
 *
 * Actualiza lo enviado, conserva lo omitido y guarda una copia fechada de la
 * ficha resultante con los campos que cambiaron. Un cliente con operaciones
 * previas necesita una reconfirmación posterior a la última de ellas para
 * iniciar una nueva solicitud de crédito.
 */
export async function confirmCustomerData(customerId, input, userId) {
    const { confirmation_notes: notes = null, ...data } = input;

    const result = await withTransaction(async (client) => {
        const { rows } = await client.query('SELECT * FROM customers WHERE id = $1 FOR UPDATE', [customerId]);
        const current = rows[0];
        if (!current) throw AppError.notFound('Cliente no encontrado');

        if (data.dpi && data.dpi !== current.dpi) {
            const { rows: other } = await client.query('SELECT full_name FROM customers WHERE dpi = $1 AND id <> $2', [
                data.dpi,
                customerId,
            ]);
            if (other[0]) throw AppError.conflict(`El DPI ${data.dpi} ya está registrado a nombre de ${other[0].full_name}`);
        }

        const merged = Object.fromEntries(
            CUSTOMER_FIELDS.map((f) => [f, Object.prototype.hasOwnProperty.call(data, f) ? data[f] ?? null : current[f]])
        );

        const { rows: updatedRows } = await client.query(
            `UPDATE customers SET
                 dpi = $2, full_name = $3, phone = $4, phone_alt = $5, email = $6, address = $7,
                 address_ref = $8, municipality = $9, department = $10, latitude = $11, longitude = $12, notes = $13
             WHERE id = $1
             RETURNING *`,
            [customerId, ...CUSTOMER_FIELDS.map((f) => merged[f])]
        );
        const updated = updatedRows[0];

        // Comparación DESPUÉS de normalizar (el trigger de la base normaliza).
        const changed = CUSTOMER_FIELDS.filter((f) => String(current[f] ?? '') !== String(updated[f] ?? ''));
        const snapshot = Object.fromEntries(CUSTOMER_FIELDS.map((f) => [f, updated[f]]));

        const { rows: confirmationRows } = await client.query(
            `INSERT INTO customer_confirmations (customer_id, confirmed_by, snapshot, changed_fields, notes)
             VALUES ($1, $2, $3, $4, $5)
             RETURNING id, customer_id, confirmed_by, confirmed_at, snapshot, changed_fields, notes`,
            [customerId, userId, JSON.stringify(snapshot), changed, notes]
        );

        if (changed.length) {
            await recordEvent(
                {
                    type: EVENT_TYPES.CUSTOMER_UPDATED,
                    aggregate: 'customer',
                    aggregateId: updated.id,
                    payload: { id: updated.id, dpi: updated.dpi, full_name: updated.full_name, changed_fields: changed },
                },
                client
            );
        }

        return { customer: updated, confirmation: confirmationRows[0] };
    });

    dispatchInBackground();
    return result;
}

export async function listConfirmations(customerId) {

    const { rows } = await query(
        `SELECT c.id, c.confirmed_at, c.changed_fields, c.notes, u.username AS confirmed_by_username
           FROM customer_confirmations c
           LEFT JOIN users u ON u.id = c.confirmed_by
          WHERE c.customer_id = $1
       ORDER BY c.confirmed_at DESC, c.id DESC`,
        [customerId]
    );
    return rows;
}
