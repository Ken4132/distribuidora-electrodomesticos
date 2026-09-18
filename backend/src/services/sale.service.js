import { withTransaction, query } from '../config/db.js';
import * as Sale from '../models/sale.model.js';
import * as Product from '../models/product.model.js';
import { AppError } from '../utils/AppError.js';
import { installmentsFor, priceFieldFor, isLegacyPaymentMode, PAYMENT_MODES } from '../utils/pricing.js';
import { money, sumMoney, splitInstallments, toCents } from '../utils/money.js';
import { today, buildDueDates, isIsoDate } from '../utils/dates.js';
import { recordEvent, EVENT_TYPES, dispatchInBackground } from './events.service.js';

export const listSales = (opts) => Sale.list(opts);

/**
 * `credito_4` y `credito_8` se conservan para las ventas históricas: se leen,
 * se cobran y se consultan igual que siempre. Lo que ya no se puede es
 * registrar una venta NUEVA con ellas.
 */
const LEGACY_MODE_MESSAGE =
    'Las modalidades credito_4 y credito_8 solo se conservan para las ventas históricas. ' +
    'Una venta a crédito nueva se registra concretando una solicitud de crédito aprobada.';

export async function getSale(id) {
    const sale = await Sale.findById(id);
    if (!sale) throw AppError.notFound('Venta no encontrada');

    const [items, installments, payments, cancellation] = await Promise.all([
        Sale.findItems(id),
        Sale.findInstallments(id),
        Sale.findPayments(id),
        Sale.findCancellation(id),
    ]);

    return { ...sale, items, installments, payments, cancellation };
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
    // BLOQUE 3.3: una venta a crédito NUEVA nace siempre de una solicitud
    // aprobada y se registra al concretarla. Se comprueba aquí, en el
    // servicio, y no solo en el validador ni en el formulario: es la capa que
    // no se puede saltar llamando a la API directamente. La base de datos lo
    // vuelve a impedir con `trg_sales_credit_origin` (012).
    if (isLegacyPaymentMode(payment_mode)) {
        throw AppError.unprocessable(LEGACY_MODE_MESSAGE, { payment_mode });
    }
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

/**
 * ANULACIÓN DE VENTA (decisiones del propietario, 2026-09-17).
 *
 *   VENTA ACTIVA -> motivo obligatorio -> solo Administración o Gerencia
 *                -> reversión económica -> devolución de stock -> ANULADA
 *
 *   * Sin pagos aplicados: se anula y el stock vuelve a la sucursal de la que
 *     salió cada producto en ESTA venta (nunca a otra).
 *   * Con pagos: primero se anulan los pagos por su propio proceso formal y
 *     auditado (`PATCH /payments/:id/void`, Administración); recién entonces
 *     se puede anular la venta. Incluye el enganche de un crédito, que es un
 *     pago como cualquier otro.
 *   * Nada se borra: la venta queda 'anulada', los pagos anulados conservan
 *     sus aplicaciones a cuotas, y cuotas y líneas se conservan íntegras.
 *   * La solicitud de crédito de origen pasa a VENTA_ANULADA: sale de la
 *     cartera activa y del control de regularización, conserva todo su
 *     historial y no se puede reutilizar para otra venta.
 *
 * CONCURRENCIA: la venta se bloquea con FOR UPDATE antes de comprobar nada.
 * Registrar un pago bloquea esa misma fila (payment.service), así que un pago
 * no puede colarse entre la comprobación y la anulación: o entra antes (y
 * entonces la anulación falla con 409) o espera y encuentra la venta anulada
 * (y falla con 422).
 */
export async function cancelSale(id, reason, userId) {
    await withTransaction(async (client) => {
        const { rows: locked } = await client.query(
            `SELECT id, status, total, credit_application_id
               FROM sales WHERE id = $1 FOR UPDATE`,
            [id]
        );
        const sale = locked[0];
        if (!sale) throw AppError.notFound('Venta no encontrada');
        if (sale.status === 'anulada') throw AppError.conflict('La venta ya está anulada');

        const { rows: paid } = await client.query(
            `SELECT COUNT(*)::int AS payments, COALESCE(SUM(amount), 0)::NUMERIC(12, 2) AS amount
               FROM payments WHERE sale_id = $1 AND status = 'aplicado'`,
            [id]
        );
        if (paid[0].payments > 0) {
            throw AppError.conflict(
                `No se puede anular una venta con pagos aplicados (${paid[0].payments} pago(s) por Q${paid[0].amount}). Anula primero los pagos.`,
                { reason: 'PAYMENTS_MUST_BE_VOIDED_FIRST', pagos: paid[0].payments, monto: paid[0].amount }
            );
        }

        // Impacto económico ya revertido: pagos anulados de esta venta.
        const { rows: reverted } = await client.query(
            `SELECT COUNT(*)::int AS payments, COALESCE(SUM(amount), 0)::NUMERIC(12, 2) AS amount
               FROM payments WHERE sale_id = $1 AND status = 'anulado'`,
            [id]
        );

        await Sale.cancel(client, id, reason, userId);

        // El stock vuelve a la sucursal de la que salió cada producto en ESTA venta.
        const { rows: exits } = await client.query(
            `SELECT product_id, branch_id, SUM(quantity)::int AS quantity
               FROM stock_movements
              WHERE sale_id = $1 AND movement = 'salida'
           GROUP BY product_id, branch_id
           ORDER BY product_id, branch_id`,
            [id]
        );
        const restored = [];
        const returned = new Set();
        for (const exit of exits) {
            returned.add(Number(exit.product_id));
            await Product.adjustStock(client, {
                productId: exit.product_id,
                delta: exit.quantity,
                reason: 'anulacion_venta',
                saleId: id,
                userId,
                branchId: exit.branch_id,
            });
            restored.push({
                product_id: Number(exit.product_id),
                branch_id: exit.branch_id === null ? null : Number(exit.branch_id),
                quantity: exit.quantity,
            });
        }
        // Ventas sin movimiento de salida registrado (no debería ocurrir): se
        // conserva el comportamiento anterior (sucursal predeterminada).
        const items = await Sale.findItems(id);
        for (const item of items) {
            if (returned.has(Number(item.product_id))) continue;
            await Product.adjustStock(client, {
                productId: item.product_id,
                delta: item.quantity,
                reason: 'anulacion_venta',
                saleId: id,
                userId,
            });
            restored.push({ product_id: Number(item.product_id), branch_id: null, quantity: item.quantity });
        }

        // SOLICITUD DE CRÉDITO DE ORIGEN: pasa a VENTA_ANULADA.
        let downPaymentReverted = '0.00';
        if (sale.credit_application_id) {
            const { rows: apps } = await client.query(
                'SELECT id, status, actual_down_payment FROM credit_applications WHERE id = $1 FOR UPDATE',
                [sale.credit_application_id]
            );
            const application = apps[0];
            if (application) {
                downPaymentReverted = application.actual_down_payment ?? '0.00';
                if (application.status === 'ACTIVO' || application.status === 'VENTA_CONCRETADA') {
                    await client.query(
                        `UPDATE credit_applications
                            SET status = 'VENTA_ANULADA', sale_cancelled_at = now()
                          WHERE id = $1`,
                        [application.id]
                    );
                    await client.query(
                        `INSERT INTO credit_application_status_history
                             (credit_application_id, from_status, to_status, changed_by, reason)
                         VALUES ($1, $2, 'VENTA_ANULADA', $3, $4)`,
                        [
                            application.id,
                            application.status,
                            userId,
                            `Venta V-${String(id).padStart(6, '0')} anulada: ${reason ?? 'sin motivo'}`,
                        ]
                    );
                }
            }
        }

        // Expediente de la anulación: usuario, fecha, motivo, venta, solicitud,
        // impacto económico y stock restituido.
        await client.query(
            `INSERT INTO sale_cancellations
                 (sale_id, credit_application_id, reason, cancelled_by, sale_total,
                  payments_voided_count, payments_voided_amount, down_payment_reverted, stock_restored)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
            [
                id,
                sale.credit_application_id ?? null,
                reason,
                userId,
                sale.total,
                reverted[0].payments,
                reverted[0].amount,
                downPaymentReverted,
                JSON.stringify(restored),
            ]
        );

        await recordEvent(
            {
                type: EVENT_TYPES.SALE_CANCELLED,
                aggregate: 'sale',
                aggregateId: id,
                payload: {
                    sale_id: id,
                    reason: reason ?? null,
                    credit_application_id: sale.credit_application_id ? Number(sale.credit_application_id) : null,
                    total: sale.total,
                    payments_voided_count: reverted[0].payments,
                    payments_voided_amount: reverted[0].amount,
                    down_payment_reverted: downPaymentReverted,
                    stock_restored: restored,
                },
            },
            client
        );
    });

    dispatchInBackground();
    return getSale(id);
}
