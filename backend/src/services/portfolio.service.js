/**
 * CARTERA Y MOROSIDAD (bloque 5).
 *
 * Solo lectura. No cambia saldos, no toca el FIFO y no almacena ningún
 * indicador de atraso: los días de mora y el tramo se calculan al consultar,
 * a partir de `due_date` y de los pagos ya aplicados.
 *
 * El alcance es el que ya existe: `receivables.view` ve toda la cartera y
 * `receivables.view.own` solo los créditos que registró el propio usuario
 * (regla U6). No se crea ningún permiso nuevo para consultar.
 */
import * as Portfolio from '../models/portfolio.model.js';
import * as Sale from '../models/sale.model.js';
import * as Receipt from '../models/receipt.model.js';
import { AppError } from '../utils/AppError.js';

export const portfolio = (opts) => Portfolio.portfolio(opts);
export const installments = (opts) => Portfolio.installments(opts);
export const summary = (opts) => Portfolio.summary(opts);

export async function customerPortfolio(customerId, scope) {
    const data = await Portfolio.customerPortfolio(customerId, scope);
    if (!data) throw AppError.notFound('Cliente no encontrado');
    return data;
}

/**
 * EXPEDIENTE COMPLETO DE UN CRÉDITO: es la pantalla de detalle.
 * Venta, cuotas vivas, cuotas sustituidas, pagos, recibos y
 * reestructuraciones, en una sola respuesta.
 */
export async function creditDetail(saleId, scope) {
    const cartera = await Portfolio.portfolioSale(saleId, scope);
    if (!cartera) {
        // Puede no existir, o existir y estar fuera del alcance del usuario.
        // Se responde igual en los dos casos para no filtrar su existencia.
        throw AppError.notFound('Ese crédito no existe o no pertenece a tu cartera');
    }

    const [cuotas, sustituidas, pagos, recibos, reestructuraciones] = await Promise.all([
        Portfolio.saleInstallments(saleId),
        Portfolio.supersededInstallments(saleId),
        Sale.findPayments(saleId),
        Receipt.list({ saleId, pageSize: 100 }),
        Portfolio.restructuringsOf(saleId),
    ]);

    return {
        credit: cartera,
        installments: cuotas,
        superseded_installments: sustituidas,
        payments: pagos,
        receipts: recibos.data,
        restructurings: reestructuraciones,
    };
}

export const restructuringsOf = (saleId) => Portfolio.restructuringsOf(saleId);
