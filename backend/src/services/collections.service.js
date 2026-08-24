/**
 * BARRIDO DE COBRANZA
 *
 * Los eventos de venta y pago nacen de una acción de una persona. Los de
 * cobranza no: nacen del paso del tiempo. Alguien tiene que mirar el
 * calendario y decir "esta cuota vence en tres días" o "esta ya se venció".
 * Eso es lo que hace este barrido.
 *
 * Emite:
 *   installment.upcoming — cuota que vence dentro de N días (3 por defecto)
 *   installment.overdue  — cuota cuya fecha de vencimiento ya pasó
 *
 * Es IDEMPOTENTE: cada evento lleva una `unique_key` y la base de datos
 * rechaza el duplicado. El barrido puede correr cada hora, o dos veces
 * seguidas, sin que el cliente reciba dos avisos por la misma cuota.
 *
 * No envía nada por sí mismo: solo deja los eventos en la bandeja de salida.
 * Quien decide el canal (WhatsApp, correo, SMS) y el texto es n8n.
 */
import { query } from '../config/db.js';
import { config } from '../config/env.js';
import { EVENT_TYPES, recordEvent, dispatchInBackground } from './events.service.js';
import { today } from '../utils/dates.js';

/**
 * Clave de idempotencia de un aviso de cuota.
 *
 * - upcoming: una sola vez por cuota.
 * - overdue: una sola vez por cuota si `overdueRepeatDays` es 0. Si es N > 0,
 *   se agrega el número de periodo de atraso, de modo que se emite un aviso
 *   nuevo cada N días de mora y ni uno más.
 */
export function alertKey(type, installmentId, daysOverdue = 0) {
    if (type === EVENT_TYPES.INSTALLMENT_UPCOMING) {
        return `${type}:${installmentId}`;
    }
    const repeat = config.collections.overdueRepeatDays;
    if (!repeat || repeat <= 0) return `${type}:${installmentId}`;
    const period = Math.floor(daysOverdue / repeat);
    return `${type}:${installmentId}:p${period}`;
}

function buildPayload(row, kind) {
    return {
        installment_id: Number(row.installment_id),
        installment_number: row.installment_number,
        installments_count: row.installments_count,
        sale_id: Number(row.sale_id),
        sale_number: row.sale_number,
        due_date: row.due_date,
        amount: row.amount,
        paid_amount: row.paid_amount,
        balance: row.balance,
        days_to_due: kind === 'upcoming' ? row.days_to_due : undefined,
        days_overdue: kind === 'overdue' ? row.days_overdue : undefined,
        customer: {
            id: Number(row.customer_id),
            full_name: row.customer_name,
            dpi: row.customer_dpi,
            phone: row.customer_phone,
            email: row.customer_email,
        },
    };
}

/**
 * Ejecuta el barrido.
 * @returns {{ scanned_on: string, upcoming: number, overdue: number, skipped: number }}
 */
export async function scanInstallments({ upcomingDays = config.collections.upcomingDays } = {}) {
    const scannedOn = today();

    // Cuotas que vencen exactamente dentro de `upcomingDays` días.
    // Se usa igualdad y no un rango: con un rango, cada día se volvería a
    // avisar de la misma cuota mientras siga dentro de la ventana.
    const { rows: upcoming } = await query(
        `SELECT * FROM v_installment_alerts
          WHERE days_to_due = $1
       ORDER BY due_date, installment_id`,
        [upcomingDays]
    );

    const { rows: overdue } = await query(
        `SELECT * FROM v_installment_alerts
          WHERE due_date < app_today()
       ORDER BY due_date, installment_id`
    );

    let created = { upcoming: 0, overdue: 0 };
    let skipped = 0;

    for (const row of upcoming) {
        const event = await recordEvent({
            type: EVENT_TYPES.INSTALLMENT_UPCOMING,
            aggregate: 'installment',
            aggregateId: Number(row.installment_id),
            payload: buildPayload(row, 'upcoming'),
            uniqueKey: alertKey(EVENT_TYPES.INSTALLMENT_UPCOMING, row.installment_id),
        });
        if (event) created.upcoming += 1;
        else skipped += 1;
    }

    for (const row of overdue) {
        const event = await recordEvent({
            type: EVENT_TYPES.INSTALLMENT_OVERDUE,
            aggregate: 'installment',
            aggregateId: Number(row.installment_id),
            payload: buildPayload(row, 'overdue'),
            uniqueKey: alertKey(EVENT_TYPES.INSTALLMENT_OVERDUE, row.installment_id, row.days_overdue),
        });
        if (event) created.overdue += 1;
        else skipped += 1;
    }

    const total = created.upcoming + created.overdue;
    if (total > 0) {
        console.log(
            `[cobranza] barrido ${scannedOn}: ${created.upcoming} por vencer, ${created.overdue} vencida(s), ${skipped} ya avisada(s)`
        );
        dispatchInBackground();
    }

    return {
        scanned_on: scannedOn,
        upcoming_days: upcomingDays,
        candidates: { upcoming: upcoming.length, overdue: overdue.length },
        created,
        skipped,
    };
}

/** Cuotas que hoy están en la mira de cobranza, para mostrarlas en pantalla. */
export async function collectionsPreview({ upcomingDays = config.collections.upcomingDays } = {}) {
    const { rows } = await query(
        `SELECT * FROM v_installment_alerts
          WHERE due_date <= app_today() + $1::int
       ORDER BY due_date, installment_id
          LIMIT 200`,
        [upcomingDays]
    );
    return rows;
}

let timer = null;

export function startCollectionsScanner() {
    if (!config.collections.enabled || timer) return false;

    // Un primer barrido poco después de arrancar: si el servidor estuvo
    // apagado un par de días, las cuotas vencidas entretanto se detectan al
    // encender, no en el siguiente ciclo.
    setTimeout(() => {
        scanInstallments().catch((err) => console.error('[cobranza] error en el barrido inicial:', err.message));
    }, 15_000).unref();

    timer = setInterval(() => {
        scanInstallments().catch((err) => console.error('[cobranza] error en el barrido:', err.message));
    }, config.collections.scanIntervalMs);
    timer.unref();
    return true;
}

export function stopCollectionsScanner() {
    if (timer) clearInterval(timer);
    timer = null;
}
