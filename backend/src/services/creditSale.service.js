import { withTransaction } from '../config/db.js';
import * as model from '../models/creditApplication.model.js';
import * as flow from '../models/creditWorkflow.model.js';
import * as Sale from '../models/sale.model.js';
import * as Product from '../models/product.model.js';
import { userCan } from './authorization.service.js';
import { resolveViewScope } from './creditApplication.service.js';
import { applyPaymentToSale } from './payment.service.js';
import { recordEvent, EVENT_TYPES, dispatchInBackground } from './events.service.js';
import { AppError } from '../utils/AppError.js';
import { centsToMoney, moneyToCents } from '../utils/creditPricing.js';
import { addMonths, today } from '../utils/dates.js';

/**
 * VENTA CONCRETADA — Bloque 3.3
 *
 * Una solicitud APROBADA se convierte en venta en UNA sola transacción:
 *
 *   1. valida permisos, estado, cliente, productos y existencias de la
 *      sucursal operativa (la de la solicitud; nunca otra);
 *   2. crea la venta `credito` con los precios congelados de la solicitud;
 *   3. descuenta inventario de esa sucursal;
 *   4. genera las cuotas CONSOLIDADAS de todas las líneas (plazos distintos
 *      suman por mes), la primera un mes después de la venta;
 *   5. registra el enganche REAL como pago inicial aplicado FIFO (Q0 = sin pago);
 *   6. APROBADO → VENTA_CONCRETADA → ACTIVO, con historial;
 *   7. deja `sale.created` y, si hay enganche, `payment.created` en el outbox.
 *
 * Un crédito aprobado que nunca se concreta no crea ninguna deuda.
 */

/**
 * Reparte el total de una línea en su número de cuotas: partes iguales y el
 * residuo de centavos en la ÚLTIMA cuota de esa línea (regla C1).
 */
export function splitLine(totalCents, term) {
    const count = BigInt(term);
    const base = BigInt(totalCents) / count;
    const parts = Array.from({ length: term }, () => base);
    parts[term - 1] += BigInt(totalCents) - base * count;
    return parts;
}

/**
 * Cuotas consolidadas: el mes k suma la parte k de cada línea que todavía
 * tiene cuotas en ese mes. Ej.: 12 x 650 + 6 x 550 → meses 1–6 = 1200, 7–12 = 650.
 */
export function consolidateInstallments(lines, saleDate) {
    const months = Math.max(...lines.map((l) => l.installments_count));
    const sums = Array.from({ length: months }, () => 0n);
    for (const line of lines) {
        splitLine(line.lineCents, line.installments_count).forEach((part, index) => {
            sums[index] += part;
        });
    }
    return sums.map((cents, index) => ({
        number: index + 1,
        dueDate: addMonths(saleDate, index + 1),
        amount: centsToMoney(cents),
    }));
}

export async function concretize(applicationId, input, user) {
    const saleId = await withTransaction(async (client) => {
        const application = await flow.lockApplication(client, applicationId);
        if (!application) throw AppError.notFound('Solicitud de crédito no encontrada');

        // PERMISO: cualquier solicitud (Admin/Gerencia) o solo las propias (vendedor creador).
        const global = await userCan(user, 'credits.concretize');
        const own = await userCan(user, 'credits.concretize.own');
        const isCreator = Number(application.created_by) === Number(user.id);
        if (!global && !(own && isCreator)) {
            const scope = await resolveViewScope(user);
            const visible = await model.findById(applicationId, scope, client);
            if (!visible) throw AppError.notFound('Solicitud de crédito no encontrada');
            throw AppError.forbidden('Solo el vendedor que creó la solicitud, Administración o Gerencia pueden concretar la venta');
        }

        if (application.status !== 'APROBADO') {
            throw AppError.conflict(
                application.status === 'ACTIVO' || application.status === 'VENTA_CONCRETADA'
                    ? 'La venta de esta solicitud ya fue concretada'
                    : application.status === 'VENTA_ANULADA'
                      ? 'La venta de esta solicitud fue anulada: registra una solicitud nueva'
                      : `Solo se concreta la venta de una solicitud APROBADA (estado actual: ${application.status})`
            );
        }

        // ÚLTIMA REVISIÓN (012): el vendedor cambió las condiciones después de
        // la aprobación, así que la aprobación anterior ya no basta. Hasta que
        // Administración o Gerencia revisen, no hay venta.
        if (application.requires_final_review) {
            throw AppError.conflict(
                'Las condiciones se modificaron después de la aprobación: Administración o Gerencia deben hacer la última revisión antes de concretar la venta',
                { reason: 'FINAL_REVIEW_REQUIRED', credit_application_id: Number(application.id) }
            );
        }

        // AUTORIZACIONES: toda línea bajo el mínimo debe estar autorizada con sus
        // condiciones actuales (en la decisión o en una modificación posterior).
        // Solicitudes anteriores al flujo 3.2 (sin historial de estados) se
        // respetan tal como fueron aprobadas.
        const { rows: tracked } = await client.query(
            'SELECT 1 FROM credit_application_status_history WHERE credit_application_id = $1 LIMIT 1',
            [application.id]
        );
        if (tracked.length) {
            const unauthorized = await flow.unauthorizedExceptionLines(client, application.id);
            if (unauthorized.length) {
                throw AppError.conflict(
                    'Hay líneas bajo el mínimo sin autorización vigente: Administración o Gerencia deben autorizarlas antes de concretar',
                    unauthorized.map((l) => ({ item_id: Number(l.id), producto: l.product_name_snapshot }))
                );
            }
        }

        // CLIENTE
        const { rows: customers } = await client.query(
            'SELECT id, dpi, full_name, phone, is_active FROM customers WHERE id = $1 FOR UPDATE',
            [application.customer_id]
        );
        const customer = customers[0];
        if (!customer.is_active) {
            throw AppError.unprocessable('El cliente está inactivo; actívalo antes de concretar la venta');
        }

        // LÍNEAS CONGELADAS Y TOTALES
        const items = await flow.itemsWithFlags(client, application.id);
        const totals = await flow.totals(client, application.id);
        const totalCents = moneyToCents(totals.total);
        const approvedDownCents = moneyToCents(totals.proposed_down_payment);
        const actualDownCents = moneyToCents(input.down_payment);

        if (application.credit_type === 'EXCEPCIONAL_CONTADO' && actualDownCents !== 0n) {
            throw AppError.unprocessable('El crédito excepcional a precio de contado se concreta con enganche Q0');
        }
        if (actualDownCents > approvedDownCents) {
            throw AppError.unprocessable(
                `El enganche real (Q${centsToMoney(actualDownCents)}) no puede superar el enganche aprobado (Q${centsToMoney(approvedDownCents)})`,
                { approved_down_payment: centsToMoney(approvedDownCents) }
            );
        }
        if (actualDownCents >= totalCents) {
            throw AppError.unprocessable('El enganche real debe ser menor que el total de la venta');
        }
        if (actualDownCents > 0n && !input.payment_method) {
            throw AppError.unprocessable('Indica el método de pago del enganche', [
                { campo: 'payment_method', mensaje: 'Obligatorio cuando el enganche es mayor a Q0' },
            ]);
        }

        // PRODUCTOS E INVENTARIO DE LA SUCURSAL OPERATIVA
        const quantities = new Map();
        for (const item of items) {
            const key = Number(item.product_id);
            quantities.set(key, (quantities.get(key) ?? 0) + item.quantity);
        }
        const productIds = [...quantities.keys()].sort((a, b) => a - b);
        const { rows: products } = await client.query(
            'SELECT id, code, name, is_active, stock FROM products WHERE id = ANY($1::bigint[]) ORDER BY id FOR UPDATE',
            [productIds]
        );
        const { rows: branchRows } = await client.query('SELECT id, name, is_active FROM branches WHERE id = $1', [
            application.branch_id,
        ]);
        const branch = branchRows[0];
        if (!branch.is_active) {
            throw AppError.unprocessable(`La sucursal "${branch.name}" está inactiva; no se puede concretar la venta en ella`);
        }

        const shortages = [];
        for (const product of products) {
            if (!product.is_active) {
                throw AppError.unprocessable(`El producto "${product.name}" está inactivo; no se puede concretar la venta`);
            }
            const { rows: inv } = await client.query(
                'SELECT quantity FROM inventory WHERE product_id = $1 AND branch_id = $2 FOR UPDATE',
                [product.id, application.branch_id]
            );
            const available = inv[0]?.quantity ?? 0;
            const required = quantities.get(Number(product.id));
            if (available < required) {
                shortages.push({ product_id: Number(product.id), producto: product.name, disponible: available, requerido: required });
            }
        }
        if (shortages.length) {
            throw AppError.unprocessable(
                `Existencia insuficiente en la sucursal "${branch.name}". Registra el ingreso o ajuste en Inventario antes de concretar la venta`,
                shortages
            );
        }

        // VENTA
        const saleDate = today();
        const installments = consolidateInstallments(
            items.map((i) => ({ installments_count: i.installments_count, lineCents: moneyToCents(i.line_total) })),
            saleDate
        );
        const { rows: saleRows } = await client.query(
            `INSERT INTO sales (customer_id, sale_date, payment_mode, installments_count, subtotal, total,
                                notes, created_by, branch_id, credit_application_id)
             VALUES ($1, $2, 'credito', $3, $4, $4, $5, $6, $7, $8)
             RETURNING id, customer_id, sale_date, total, status`,
            [
                application.customer_id,
                saleDate,
                installments.length,
                totals.total,
                input.notes ?? `Solicitud de crédito #${application.application_number}`,
                // La venta pertenece a la cartera del vendedor que la originó (U6),
                // aunque la concrete Administración o Gerencia.
                application.created_by,
                application.branch_id,
                application.id,
            ]
        );
        const sale = { ...saleRows[0], full_name: customer.full_name, dpi: customer.dpi, phone: customer.phone };

        const savedItems = [];
        for (const item of items) {
            savedItems.push(
                await Sale.createItem(client, sale.id, {
                    product_id: item.product_id,
                    product_code: item.product_code_snapshot,
                    product_name: item.product_name_snapshot,
                    quantity: item.quantity,
                    unit_cost: item.cost_snapshot,
                    unit_price: item.proposed_unit_price,
                })
            );
            await Product.adjustStock(client, {
                productId: item.product_id,
                delta: -item.quantity,
                reason: 'venta_credito',
                saleId: sale.id,
                userId: user.id,
                branchId: application.branch_id,
            });
        }

        const savedInstallments = [];
        for (const inst of installments) {
            savedInstallments.push(await Sale.createInstallment(client, sale.id, inst));
        }

        await recordEvent(
            {
                type: EVENT_TYPES.SALE_CREATED,
                aggregate: 'sale',
                aggregateId: sale.id,
                payload: {
                    sale_id: sale.id,
                    sale_number: `V-${String(sale.id).padStart(6, '0')}`,
                    sale_date: saleDate,
                    payment_mode: 'credito',
                    total: totals.total,
                    installments_count: installments.length,
                    credit_application: {
                        id: application.id,
                        application_number: application.application_number,
                        credit_type: application.credit_type,
                        down_payment: centsToMoney(actualDownCents),
                    },
                    branch_id: application.branch_id,
                    customer: { id: customer.id, dpi: customer.dpi, full_name: customer.full_name, phone: customer.phone },
                    items: savedItems.map((i) => ({
                        code: i.product_code,
                        name: i.product_name,
                        quantity: i.quantity,
                        unit_price: i.unit_price,
                        line_total: i.line_total,
                    })),
                    installments: savedInstallments.map((i) => ({ number: i.number, due_date: i.due_date, amount: i.amount })),
                },
            },
            client
        );

        // ESTADOS
        const now = new Date();
        await flow.updateStatus(client, application.id, 'VENTA_CONCRETADA', {
            sale_id: sale.id,
            concretized_at: now,
            concretized_by: user.id,
            actual_down_payment: centsToMoney(actualDownCents),
        });
        await model.insertStatusHistory(client, {
            applicationId: application.id,
            fromStatus: 'APROBADO',
            toStatus: 'VENTA_CONCRETADA',
            userId: user.id,
            reason: `Venta V-${String(sale.id).padStart(6, '0')} concretada`,
        });

        // ENGANCHE REAL = pago inicial (FIFO). Q0 no genera pago.
        if (actualDownCents > 0n) {
            await applyPaymentToSale(
                client,
                sale,
                {
                    amount: centsToMoney(actualDownCents),
                    method: input.payment_method,
                    reference: input.payment_reference ?? null,
                    notes: `Enganche de la solicitud #${application.application_number}`,
                    payment_date: saleDate,
                },
                user.id
            );
        }

        await flow.updateStatus(client, application.id, 'ACTIVO', { activated_at: now });
        await model.insertStatusHistory(client, {
            applicationId: application.id,
            fromStatus: 'VENTA_CONCRETADA',
            toStatus: 'ACTIVO',
            userId: user.id,
            reason: actualDownCents > 0n ? `Enganche real Q${centsToMoney(actualDownCents)} registrado` : 'Enganche Q0',
        });

        return sale.id;
    });

    dispatchInBackground();

    const scope = await resolveViewScope(user);
    const application = await model.findById(applicationId, scope);
    const sale = await Sale.findById(saleId);
    const [saleItems, saleInstallments, payments] = await Promise.all([
        Sale.findItems(saleId),
        Sale.findInstallments(saleId),
        Sale.findPayments(saleId),
    ]);
    return { application, sale: { ...sale, items: saleItems, installments: saleInstallments, payments } };
}
