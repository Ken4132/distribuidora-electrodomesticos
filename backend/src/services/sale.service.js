import { withTransaction, query } from '../config/db.js';
import * as Sale from '../models/sale.model.js';
import * as Product from '../models/product.model.js';
import { AppError } from '../utils/AppError.js';
import { installmentsFor, priceFieldFor, PAYMENT_MODES } from '../utils/pricing.js';
import { money, sumMoney, splitInstallments, toCents } from '../utils/money.js';
import { today, buildDueDates, isIsoDate } from '../utils/dates.js';
import { recordEvent, EVENT_TYPES, dispatchInBackground } from './events.service.js';

export const listSales = (opts) => Sale.list(opts);

export async function getSale(id) {
    const sale = await Sale.findById(id);
    if (!sale) throw AppError.notFound('Venta no encontrada');

    const [items, installments, payments] = await Promise.all([
        Sale.findItems(id),
        Sale.findInstallments(id),
        Sale.findPayments(id),
    ]);

    return { ...sale, items, installments, payments };
}

/**
 * Calcula el total de una venta SIN guardarla.
 * Lo usa el formulario para mostrar el cálculo en vivo antes de confirmar,
 * garantizando que lo que ve el usuario es exactamente lo que se guardará.
 */
export async function quoteSale({ payment_mode, items, sale_date }) {
    const mode = PAYMENT_MODES[payment_mode];
    if (!mode) throw AppError.badRequest('Modalidad de pago inválida');

    const priceField = priceFieldFor(payment_mode);
    const ids = items.map((i) => i.product_id);

    const { rows: products } = await query(
        `SELECT id, code, name, cost, stock, is_active, ${priceField} AS unit_price
           FROM products WHERE id = ANY($1::bigint[])`,
        [ids]
    );
    const byId = new Map(products.map((p) => [Number(p.id), p]));

    const lines = items.map((item) => {
        const product = byId.get(Number(item.product_id));
        if (!product) throw AppError.badRequest(`El producto con id ${item.product_id} no existe`);
        if (!product.is_active) throw AppError.unprocessable(`El producto "${product.name}" está inactivo`);

        const lineTotal = money(toCents(product.unit_price) * item.quantity / 100);
        return {
            product_id: Number(product.id),
            product_code: product.code,
            product_name: product.name,
            quantity: item.quantity,
            unit_cost: product.cost,
            unit_price: product.unit_price,
            line_total: lineTotal,
            stock_available: product.stock,
            stock_sufficient: product.stock >= item.quantity,
        };
    });

    const subtotal = sumMoney(lines.map((l) => l.line_total));
    const total = subtotal;
    const count = installmentsFor(payment_mode);
    const date = sale_date && isIsoDate(sale_date) ? sale_date : today();
    const amounts = splitInstallments(total, count);
    const dueDates = buildDueDates(date, count);

    return {
        payment_mode,
        payment_mode_label: mode.label,
        sale_date: date,
        items: lines,
        subtotal: money(subtotal),
        total: money(total),
        installments_count: count,
        installments: amounts.map((amount, i) => ({
            number: i + 1,
            due_date: dueDates[i],
            amount: money(amount),
        })),
    };
}

/**
 * Registra una venta completa de forma atómica:
 *   cabecera + detalle + cuotas + descuento de stock + evento para n8n.
 * Si algo falla, no queda nada a medias.
 */
export async function createSale(input, userId) {
    const { customer_id, payment_mode, items, notes } = input;
    const saleDate = input.sale_date && isIsoDate(input.sale_date) ? input.sale_date : today();

    if (!PAYMENT_MODES[payment_mode]) throw AppError.badRequest('Modalidad de pago inválida');
    if (!items?.length) throw AppError.badRequest('La venta debe incluir al menos un producto');

    // Consolida líneas repetidas del mismo producto en una sola.
    const merged = new Map();
    for (const item of items) {
        const key = Number(item.product_id);
        merged.set(key, (merged.get(key) ?? 0) + Number(item.quantity));
    }
    const normalized = [...merged.entries()].map(([product_id, quantity]) => ({ product_id, quantity }));

    const priceField = priceFieldFor(payment_mode);
    const installmentsCount = installmentsFor(payment_mode);

    const result = await withTransaction(async (client) => {
        // 1. Cliente válido y activo
        const { rows: customers } = await client.query(
            'SELECT id, dpi, full_name, phone, is_active FROM customers WHERE id = $1',
            [customer_id]
        );
        const customer = customers[0];
        if (!customer) throw AppError.badRequest('El cliente seleccionado no existe');
        if (!customer.is_active) throw AppError.unprocessable('El cliente está inactivo; actívalo antes de venderle');

        // 2. Bloquea los productos para evitar sobreventa por concurrencia
        const productIds = normalized.map((i) => i.product_id);
        const { rows: products } = await client.query(
            `SELECT id, code, name, cost, stock, is_active, ${priceField} AS unit_price
               FROM products
              WHERE id = ANY($1::bigint[])
           ORDER BY id
             FOR UPDATE`,
            [productIds]
        );
        const byId = new Map(products.map((p) => [Number(p.id), p]));

        const lines = normalized.map(({ product_id, quantity }) => {
            const product = byId.get(product_id);
            if (!product) throw AppError.badRequest(`El producto con id ${product_id} no existe`);
            if (!product.is_active) throw AppError.unprocessable(`El producto "${product.name}" está inactivo`);
            if (product.stock < quantity) {
                throw AppError.unprocessable(
                    `Stock insuficiente de "${product.name}" (${product.code}): disponible ${product.stock}, solicitado ${quantity}`
                );
            }
            return {
                product_id,
                product_code: product.code,
                product_name: product.name,
                quantity,
                unit_cost: product.cost,
                unit_price: product.unit_price,
                line_total: money((toCents(product.unit_price) * quantity) / 100),
            };
        });

        const subtotal = sumMoney(lines.map((l) => l.line_total));
        const total = subtotal;
        if (toCents(total) <= 0) throw AppError.unprocessable('El total de la venta debe ser mayor a cero');

        // 3. Cabecera
        const sale = await Sale.createSale(client, {
            customer_id,
            sale_date: saleDate,
            payment_mode,
            installments_count: installmentsCount,
            subtotal: money(subtotal),
            total: money(total),
            notes,
            created_by: userId,
        });

        // 4. Detalle + descuento de stock con trazabilidad
        const savedItems = [];
        for (const line of lines) {
            savedItems.push(await Sale.createItem(client, sale.id, line));
            await Product.adjustStock(client, {
                productId: line.product_id,
                delta: -line.quantity,
                reason: 'venta',
                saleId: sale.id,
                userId,
            });
        }

        // 5. Cuotas (contado = 1 cuota que vence el mismo día)
        const amounts = splitInstallments(total, installmentsCount);
        const dueDates = buildDueDates(saleDate, installmentsCount);
        const savedInstallments = [];
        for (let i = 0; i < installmentsCount; i += 1) {
            savedInstallments.push(
                await Sale.createInstallment(client, sale.id, {
                    number: i + 1,
                    dueDate: dueDates[i],
                    amount: money(amounts[i]),
                })
            );
        }

        // 6. Evento para n8n — en la MISMA transacción (outbox)
        await recordEvent(
            {
                type: EVENT_TYPES.SALE_CREATED,
                aggregate: 'sale',
                aggregateId: sale.id,
                payload: {
                    sale_id: sale.id,
                    sale_number: `V-${String(sale.id).padStart(6, '0')}`,
                    sale_date: saleDate,
                    payment_mode,
                    total: money(total),
                    installments_count: installmentsCount,
                    customer: {
                        id: customer.id,
                        dpi: customer.dpi,
                        full_name: customer.full_name,
                        phone: customer.phone,
                    },
                    items: savedItems.map((i) => ({
                        code: i.product_code,
                        name: i.product_name,
                        quantity: i.quantity,
                        unit_price: i.unit_price,
                        line_total: i.line_total,
                    })),
                    installments: savedInstallments.map((i) => ({
                        number: i.number,
                        due_date: i.due_date,
                        amount: i.amount,
                    })),
                },
            },
            client
        );

        return sale.id;
    });

    dispatchInBackground();
    return getSale(result);
}

/** Anula una venta y devuelve el stock. No se permite si ya tiene pagos. */
export async function cancelSale(id, reason, userId) {
    const sale = await Sale.findById(id);
    if (!sale) throw AppError.notFound('Venta no encontrada');
    if (sale.status === 'anulada') throw AppError.conflict('La venta ya está anulada');
    if (toCents(sale.paid_amount) > 0) {
        throw AppError.conflict(
            'No se puede anular una venta con pagos aplicados. Anula primero los pagos.'
        );
    }

    await withTransaction(async (client) => {
        await Sale.cancel(client, id, reason);
        const items = await Sale.findItems(id);
        for (const item of items) {
            await Product.adjustStock(client, {
                productId: item.product_id,
                delta: item.quantity,
                reason: 'anulacion_venta',
                saleId: id,
                userId,
            });
        }
        await recordEvent(
            {
                type: EVENT_TYPES.SALE_CANCELLED,
                aggregate: 'sale',
                aggregateId: id,
                payload: { sale_id: id, reason: reason ?? null },
            },
            client
        );
    });

    dispatchInBackground();
    return getSale(id);
}
