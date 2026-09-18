/**
 * RECIBOS  (bloque 4.3)
 *
 *      PAGO  ->  RECIBO INMUTABLE  ->  EVENTO DE OUTBOX
 *
 * Los tres ocurren en la MISMA transacción. Si algo falla, no queda ni el
 * pago, ni el recibo, ni el evento: no hay estados a medias.
 *
 * El recibo CONGELA lo que decía el sistema en el momento de emitirlo: el
 * cliente, el monto, el saldo anterior y el posterior, la distribución FIFO
 * real, el método, el usuario y la sucursal. Después NO se edita nunca (la
 * tabla es de solo inserción desde la migración 013). Una corrección se hace
 * anulando el pago —mecanismo del bloque 4.1, que no cambia aquí—, y el
 * recibo se conserva mostrando al lado que su pago quedó anulado.
 *
 * Aquí NO se llama a ninguna API externa. n8n consumirá el evento del outbox
 * cuando le toque; el cobro no depende de que n8n esté vivo.
 */
import * as Receipt from '../models/receipt.model.js';
import { AppError } from '../utils/AppError.js';

/**
 * Emite el recibo de un pago recién registrado.
 *
 * Se llama desde `applyPaymentToSale`, que es el único punto por el que pasa
 * todo el dinero, así que vale igual para el cobro normal y para el enganche
 * de una venta a crédito.
 *
 * @param {object} client  cliente de la transacción EN CURSO (obligatorio)
 */
export async function issueReceipt(client, { payment, sale, allocations, balanceBefore, balanceAfter, userId, voucherStatus }) {
    return Receipt.issue(client, {
        paymentId: payment.id,
        customerId: sale.customer_id,
        saleId: sale.id,
        issuedBy: userId,
        paymentDate: payment.payment_date,
        method: payment.method,
        amount: payment.amount,
        balanceBefore,
        balanceAfter,
        // El depósito todavía no existe cuando se cobra: un pago entra en un
        // depósito después (bloque 4.2). Por eso `deposit_id` nace NULL y la
        // vista muestra por separado el depósito VIVO en el que acabó.
        depositReference: null,
        allocations,
        snapshot: {
            sale_number: `V-${String(sale.id).padStart(6, '0')}`,
            payment_number: `P-${String(payment.id).padStart(6, '0')}`,
            customer: {
                id: sale.customer_id,
                dpi: sale.dpi ?? null,
                full_name: sale.full_name ?? null,
                phone: sale.phone ?? null,
            },
            payment_mode: sale.payment_mode ?? null,
            sale_total: sale.total ?? null,
            reference: payment.reference ?? null,
            notes: payment.notes ?? null,
            voucher_status: voucherStatus ?? null,
        },
    });
}

export async function getReceiptOfPayment(paymentId) {
    const receipt = await Receipt.findByPayment(paymentId);
    if (!receipt) {
        throw AppError.notFound(
            'Ese pago no tiene recibo. Los pagos anteriores al bloque 4.3 no lo llevan: no se emiten hacia atrás.'
        );
    }
    return receipt;
}

export async function getReceipt(id) {
    const receipt = await Receipt.findById(id);
    if (!receipt) throw AppError.notFound('Recibo no encontrado');
    return receipt;
}

export const listReceipts = (opts) => Receipt.list(opts);
