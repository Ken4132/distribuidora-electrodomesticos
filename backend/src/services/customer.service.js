import * as Customer from '../models/customer.model.js';
import { AppError } from '../utils/AppError.js';
import { recordEvent, EVENT_TYPES, dispatchInBackground } from './events.service.js';

export const listCustomers = (opts) => Customer.list(opts);

export async function getCustomer(id) {
    const customer = await Customer.findById(id);
    if (!customer) throw AppError.notFound('Cliente no encontrado');
    const account = await Customer.getAccount(id);
    return { ...customer, account };
}

export async function createCustomer(data, userId) {
    // Verificación explícita para dar un mensaje claro; el índice único de la
    // base de datos sigue siendo la garantía real contra la condición de carrera.
    const existing = await Customer.findByDpi(data.dpi);
    if (existing) {
        throw AppError.conflict(`El DPI ${data.dpi} ya está registrado a nombre de ${existing.full_name}`, {
            customer_id: existing.id,
        });
    }

    const customer = await Customer.create(data, userId);

    await recordEvent({
        type: EVENT_TYPES.CUSTOMER_CREATED,
        aggregate: 'customer',
        aggregateId: customer.id,
        payload: {
            id: customer.id,
            dpi: customer.dpi,
            full_name: customer.full_name,
            phone: customer.phone,
            created_at: customer.created_at,
        },
    });
    dispatchInBackground();

    return customer;
}

export async function updateCustomer(id, data, _userId) {
    const current = await Customer.findById(id);
    if (!current) throw AppError.notFound('Cliente no encontrado');

    if (data.dpi && data.dpi !== current.dpi) {
        const other = await Customer.findByDpi(data.dpi);
        if (other && other.id !== current.id) {
            throw AppError.conflict(`El DPI ${data.dpi} ya está registrado a nombre de ${other.full_name}`);
        }
    }

    const updated = await Customer.update(id, data);

    await recordEvent({
        type: EVENT_TYPES.CUSTOMER_UPDATED,
        aggregate: 'customer',
        aggregateId: updated.id,
        payload: { id: updated.id, dpi: updated.dpi, full_name: updated.full_name },
    });
    dispatchInBackground();

    return updated;
}

export async function setCustomerActive(id, isActive) {
    const current = await Customer.findById(id);
    if (!current) throw AppError.notFound('Cliente no encontrado');

    // No se desactiva un cliente que aún debe dinero: se perdería de vista
    // una cuenta por cobrar activa.
    if (!isActive) {
        const account = await Customer.getAccount(id);
        if (account && Number(account.total_balance) > 0) {
            throw AppError.conflict(
                `No se puede desactivar: el cliente tiene un saldo pendiente de Q${Number(
                    account.total_balance
                ).toFixed(2)}`
            );
        }
    }
    return Customer.setActive(id, isActive);
}

export async function getCustomerAccount(id) {
    const customer = await Customer.findById(id);
    if (!customer) throw AppError.notFound('Cliente no encontrado');
    return Customer.getAccount(id);
}
