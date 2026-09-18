/**
 * REESTRUCTURACIÓN Y REGULARIZACIÓN DE UN CRÉDITO (bloque 5).
 *
 * PRINCIPIO: una reestructuración NO crea una segunda deuda. Es el MISMO
 * crédito con otras condiciones.
 *
 *   * Los pagos anteriores se conservan intactos y siguen contando.
 *   * Las cuotas anteriores NO se borran: se marcan como SUSTITUIDAS, con
 *     su historial y sus asignaciones FIFO intactas, y dejan de contar como
 *     deuda viva.
 *   * Las cuotas nuevas se numeran A CONTINUACIÓN de las anteriores, así que
 *     el FIFO sigue funcionando exactamente igual: la más antigua primero.
 *   * NUEVO SALDO = NUEVO TOTAL − LO YA PAGADO. La base lo vuelve a exigir
 *     con la restricción `restructuring_balance_math`.
 *   * Todo queda auditado: quién, cuándo, por qué, y la foto de lo anterior.
 *
 * QUIÉN: solo quien tiene `credits.restructure` (Administración y Gerencia).
 * La operación ES la autorización; no hay un segundo proceso de aprobación.
 */
import { withTransaction } from '../config/db.js';
import { AppError } from '../utils/AppError.js';
import { money, toCents, fromCents } from '../utils/money.js';
import { recordEvent, EVENT_TYPES, dispatchInBackground } from './events.service.js';
import { creditDetail } from './portfolio.service.js';

/** Días desde la activación a partir de los cuales el crédito excepcional
 *  deja de poder reestructurarse de emergencia y DEBE regularizarse. */
export const EXCEPTIONAL_GRACE_DAYS = 60;

/** Plazo mínimo de una regularización, en cuotas mensuales. */
export const MIN_REGULARIZATION_INSTALLMENTS = 6;

/** Suma en centavos que el nuevo plan tiene que repartir. */
function splitInstallments(balanceCents, count) {
    const base = Math.floor(balanceCents / count);
    const cuotas = Array.from({ length: count }, () => base);
    cuotas[count - 1] += balanceCents - base * count;
    return cuotas;
}

/** Misma fecha del mes, N meses después. */
function addMonths(isoDate, months) {
    const [y, m, d] = isoDate.split('-').map(Number);
    const date = new Date(Date.UTC(y, m - 1 + months, 1));
    const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
    date.setUTCDate(Math.min(d, lastDay));
    return date.toISOString().slice(0, 10);
}

export async function restructureSale(saleId, input, actor, scope) {
    const id = await withTransaction(async (client) => {
        // Se bloquea la venta igual que al cobrar: así una reestructuración y
        // un pago no pueden cruzarse sobre las mismas cuotas.
        const { rows: sales } = await client.query(
            `SELECT s.id, s.status, s.payment_mode, s.total, s.subtotal, s.installments_count,
                    s.sale_date, s.customer_id, s.branch_id,
                    c.full_name, c.dpi, c.phone,
                    ca.id AS credit_application_id, ca.credit_type, ca.application_number
               FROM sales s
               JOIN customers c ON c.id = s.customer_id
               LEFT JOIN credit_applications ca ON ca.sale_id = s.id
              WHERE s.id = $1
                FOR UPDATE OF s`,
            [saleId]
        );
        const sale = sales[0];
        if (!sale) throw AppError.notFound('Crédito no encontrado');
        if (sale.status !== 'activa') throw AppError.conflict('Una venta anulada no se reestructura');

        // Los modos históricos `credito_4` y `credito_8` tienen el número de
        // cuotas fijado por una restricción de la base (`sales_mode_installments`).
        // Cambiárselo sería reinterpretar una venta histórica, así que no se
        // permite: la reestructuración es para los créditos del flujo actual.
        if (sale.payment_mode !== 'credito') {
            throw AppError.conflict(
                'Solo se reestructuran los créditos del flujo actual. Este es una venta histórica ' +
                    `(${sale.payment_mode}) y su plan de cuotas es fijo.`,
                { reason: 'LEGACY_PAYMENT_MODE', payment_mode: sale.payment_mode }
            );
        }

        // Situación actual, leída dentro de la transacción.
        const { rows: [estado] } = await client.query(
            `SELECT COALESCE(SUM(p.amount), 0)::numeric(12,2) AS pagado
               FROM payments p WHERE p.sale_id = $1 AND p.status = 'aplicado'`,
            [saleId]
        );
        // Se bloquea la TABLA base y después se lee la vista: `v_installments`
        // tiene un LEFT JOIN y PostgreSQL no admite FOR UPDATE sobre él. Es el
        // mismo orden que usa el cobro.
        await client.query(
            'SELECT i.id FROM installments i WHERE i.sale_id = $1 ORDER BY i.number FOR UPDATE', [saleId]);
        const { rows: vivas } = await client.query(
            `SELECT id, number, due_date, amount, paid_amount, balance, status
               FROM v_installments
              WHERE sale_id = $1 AND NOT is_superseded
           ORDER BY number`,
            [saleId]
        );

        const previousTotalCents = toCents(sale.total);
        const paidCents = toCents(estado.pagado);
        const previousBalanceCents = previousTotalCents - paidCents;
        if (previousBalanceCents <= 0) {
            throw AppError.conflict('Este crédito no tiene saldo: no hay nada que reestructurar');
        }

        // ---- Qué figura corresponde
        const daysSinceSale = Number(
            (await client.query('SELECT (app_today() - $1::date)::int AS d', [sale.sale_date])).rows[0].d
        );
        const esExcepcional = sale.credit_type === 'EXCEPCIONAL_CONTADO';
        const kind =
            esExcepcional && daysSinceSale > EXCEPTIONAL_GRACE_DAYS ? 'REGULARIZACION' : 'REESTRUCTURACION';

        if (input.kind && input.kind !== kind) {
            throw AppError.unprocessable(
                `Este crédito requiere ${kind}, no ${input.kind}.` +
                    (kind === 'REGULARIZACION'
                        ? ` Es un crédito excepcional con ${daysSinceSale} días desde la venta (más de ${EXCEPTIONAL_GRACE_DAYS}).`
                        : ''),
                [{ campo: 'kind', mensaje: `Corresponde ${kind}` }]
            );
        }
        if (kind === 'REGULARIZACION' && input.new_installments < MIN_REGULARIZATION_INSTALLMENTS) {
            throw AppError.unprocessable(
                `Una regularización se hace a un plazo mínimo de ${MIN_REGULARIZATION_INSTALLMENTS} cuotas mensuales`,
                [{ campo: 'new_installments', mensaje: `Mínimo ${MIN_REGULARIZATION_INSTALLMENTS}` }]
            );
        }

        // ---- Números
        const newTotalCents = toCents(input.new_total);
        if (newTotalCents < paidCents) {
            throw AppError.unprocessable(
                `El nuevo total (Q${fromCents(newTotalCents).toFixed(2)}) no puede ser menor que lo ya pagado ` +
                    `(Q${fromCents(paidCents).toFixed(2)}): los pagos anteriores no se borran`,
                [{ campo: 'new_total', mensaje: 'No puede ser menor que lo ya pagado' }]
            );
        }
        const newBalanceCents = newTotalCents - paidCents;
        if (newBalanceCents <= 0) {
            throw AppError.unprocessable(
                'Con ese total el crédito quedaría saldado. Registra el pago que falte en lugar de reestructurar',
                [{ campo: 'new_total', mensaje: 'El saldo resultante sería cero' }]
            );
        }

        // ---- 1. Historial (antes que nada: las cuotas apuntan a él)
        const snapshot = {
            payment_mode: sale.payment_mode,
            credit_type: sale.credit_type ?? null,
            credit_application: sale.application_number ?? null,
            days_since_sale: daysSinceSale,
            previous_installments: vivas.map((i) => ({
                number: i.number,
                due_date: i.due_date,
                amount: i.amount,
                paid_amount: i.paid_amount,
                balance: i.balance,
                status: i.status,
            })),
        };

        const { rows: [restructuring] } = await client.query(
            `INSERT INTO sale_restructurings
                 (sale_id, kind, previous_total, previous_paid, previous_balance, previous_installments,
                  new_total, new_installments, new_balance, first_due_date, reason, approved_by, previous_snapshot)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb)
             RETURNING id, kind, approved_at`,
            [
                saleId,
                kind,
                money(fromCents(previousTotalCents)),
                money(fromCents(paidCents)),
                money(fromCents(previousBalanceCents)),
                sale.installments_count,
                money(fromCents(newTotalCents)),
                input.new_installments,
                money(fromCents(newBalanceCents)),
                input.first_due_date,
                input.reason,
                actor?.id ?? null,
                JSON.stringify(snapshot),
            ]
        );

        // ---- 2. Sustituir las cuotas con saldo. Las ya pagadas se quedan
        //         como están: son historial cerrado y su saldo es cero.
        const conSaldo = vivas.filter((i) => toCents(i.balance) > 0).map((i) => Number(i.id));
        if (conSaldo.length) {
            await client.query(
                `UPDATE installments
                    SET superseded_at = now(), restructuring_id = $2
                  WHERE id = ANY($1::bigint[])`,
                [conSaldo, restructuring.id]
            );
        }

        // ---- 3. Plan nuevo, numerado a continuación para no romper el FIFO
        const { rows: [ultima] } = await client.query(
            'SELECT COALESCE(MAX(number), 0)::int AS n FROM installments WHERE sale_id = $1', [saleId]);
        const importes = splitInstallments(newBalanceCents, input.new_installments);
        const nuevas = [];
        for (let i = 0; i < importes.length; i += 1) {
            const { rows: [cuota] } = await client.query(
                `INSERT INTO installments (sale_id, number, due_date, amount, restructuring_id)
                 VALUES ($1, $2, $3, $4, $5) RETURNING id, number, due_date, amount`,
                [saleId, ultima.n + i + 1, addMonths(input.first_due_date, i),
                 money(fromCents(importes[i])), restructuring.id]
            );
            nuevas.push(cuota);
        }

        // ---- 4. El crédito pasa a valer el total nuevo. `subtotal` NO se
        //         toca: describe la venta original, no la deuda.
        await client.query(
            'UPDATE sales SET total = $2, installments_count = $3, updated_at = now() WHERE id = $1',
            [saleId, money(fromCents(newTotalCents)), input.new_installments]
        );

        // ---- 5. Evento para n8n, en la MISMA transacción (outbox existente)
        await recordEvent(
            {
                type: EVENT_TYPES.SALE_RESTRUCTURED,
                aggregate: 'sale',
                aggregateId: Number(saleId),
                payload: {
                    sale_id: Number(saleId),
                    sale_number: `V-${String(saleId).padStart(6, '0')}`,
                    restructuring_id: Number(restructuring.id),
                    kind,
                    previous_total: money(fromCents(previousTotalCents)),
                    previous_balance: money(fromCents(previousBalanceCents)),
                    paid_amount: money(fromCents(paidCents)),
                    new_total: money(fromCents(newTotalCents)),
                    new_balance: money(fromCents(newBalanceCents)),
                    new_installments: input.new_installments,
                    first_due_date: input.first_due_date,
                    reason: input.reason,
                    customer: {
                        id: Number(sale.customer_id),
                        dpi: sale.dpi,
                        full_name: sale.full_name,
                        phone: sale.phone,
                    },
                },
            },
            client
        );

        return Number(restructuring.id);
    });

    dispatchInBackground();
    const detalle = await creditDetail(saleId, scope);
    return { ...detalle, restructuring_id: id };
}
