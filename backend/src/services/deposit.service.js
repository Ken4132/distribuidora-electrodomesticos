/**
 * DEPÓSITOS Y CONCILIACIÓN  (bloque 4.2)
 *
 * QUÉ ES Y QUÉ NO ES
 * ------------------
 * Un depósito agrupa pagos YA REGISTRADOS. No mueve dinero: cuando el pago se
 * registró ya bajó el saldo de la venta (bloque 4.1). El depósito es control
 * de caja: sirve para comparar lo que se cobró con lo que efectivamente llegó
 * al banco. Por eso aquí no se toca ninguna cuota, ninguna asignación FIFO ni
 * ningún saldo, y una diferencia NUNCA revierte un pago.
 *
 * ESTADOS
 * -------
 *      REVISADO  ->  VALIDADO
 *
 * Y no hay más. La observación, la explicación del empleado y el rechazo son
 * EVENTOS del historial: dejan constancia y el depósito sigue REVISADO. No
 * existe un estado RECHAZADO.
 *
 * CONCILIACIÓN
 * ------------
 *      MONTO ESPERADO  = suma de los pagos APLICABLES incluidos (aplicados)
 *      MONTO DECLARADO = lo que el empleado declara haber depositado
 *      DIFERENCIA      = declarado - esperado
 *
 * La diferencia puede ser cero, positiva o negativa. No se fuerza a cero y no
 * impide validar: quien revisa decide, y lo que decidió queda en el historial.
 *
 * QUIÉN HACE QUÉ
 * --------------
 *      deposits.create    cobrador y administración: arma el depósito.
 *      deposits.review    administración y gerencia: observa, rechaza y valida.
 *      deposits.override  solo administración: incluir un pago cuya VENTA no
 *                         tiene sucursal (histórico anterior a la migración 005).
 */
import { withTransaction } from '../config/db.js';
import * as Deposit from '../models/deposit.model.js';
import { branchOfUser } from './scope.service.js';
import { AppError } from '../utils/AppError.js';

const paymentNumber = (id) => `P-${String(id).padStart(6, '0')}`;
const depositNumber = (id) => `D-${String(id).padStart(6, '0')}`;

export const listDeposits = (opts) => Deposit.list(opts);

/**
 * Cifras de conciliación con nombres explícitos, para que la pantalla no
 * tenga que saber qué columna de la vista significa qué.
 */
function reconciliationOf(deposit) {
    return {
        monto_declarado: deposit.declared_amount,
        // "Aplicables" = los que siguen aplicados. Es el MONTO ESPERADO.
        monto_esperado: deposit.applied_amount,
        // Bruto incluido, antes de anulaciones: el depósito no oculta nada.
        monto_incluido: deposit.expected_amount,
        monto_anulado: deposit.voided_amount,
        diferencia: deposit.difference,
        cuadra: deposit.has_difference === false,
        pagos_incluidos: deposit.payments_count,
        pagos_aplicados: deposit.applied_count,
        pagos_anulados: deposit.voided_count,
    };
}

export async function getDeposit(id) {
    const deposit = await Deposit.findById(id);
    if (!deposit) throw AppError.notFound('Depósito no encontrado');

    const [payments, events] = await Promise.all([Deposit.findPayments(id), Deposit.findEvents(id)]);
    return { ...deposit, reconciliation: reconciliationOf(deposit), payments, events };
}

/**
 * SUCURSAL DEL DEPÓSITO.
 *
 * Se toma de la sucursal del usuario, que es la que la base guarda en
 * `users.branch_id` y no lo que venga en la petición: así nadie arma un
 * depósito a nombre de otra sucursal cambiando un número en el cuerpo.
 *
 * Administración normalmente no tiene sucursal asignada; en ese caso sí debe
 * indicarla, porque un depósito sin sucursal no existe (regla 13).
 */
async function resolveBranch(actor, requested) {
    const own = await branchOfUser(actor?.id);

    if (own !== null) {
        if (requested !== undefined && requested !== null && Number(requested) !== own) {
            throw AppError.forbidden('Solo puedes registrar depósitos de tu propia sucursal');
        }
        return own;
    }

    if (requested === undefined || requested === null) {
        throw AppError.unprocessable('Indica la sucursal del depósito', [
            {
                campo: 'branch_id',
                mensaje: 'Tu usuario no tiene sucursal asignada, así que tienes que indicar la del depósito',
            },
        ]);
    }
    return Number(requested);
}

/**
 * INCLUSIÓN DE PAGOS.
 *
 * Cada comprobación se hace aquí para poder dar un mensaje que se entienda, y
 * la base la vuelve a hacer con disparadores y restricciones (migraciones 013
 * y 016) para que no se pueda saltar por SQL directo.
 *
 * El único caso que la base NO decide es el del pago cuya venta no tiene
 * sucursal: eso depende de un permiso, y los permisos se conocen aquí.
 */
async function attachPayments(client, deposit, paymentIds, actor, canOverride) {
    if (!paymentIds.length) return [];

    const rows = await Deposit.lockPaymentsForDeposit(client, paymentIds);
    const byId = new Map(rows.map((r) => [Number(r.id), r]));
    const added = [];

    for (const rawId of paymentIds) {
        const id = Number(rawId);
        const payment = byId.get(id);

        if (!payment) throw AppError.notFound(`El pago ${paymentNumber(id)} no existe`);

        if (payment.status !== 'aplicado') {
            throw AppError.conflict(
                `El pago ${paymentNumber(id)} está anulado: un pago anulado no se incluye en un depósito`,
                { reason: 'PAYMENT_VOIDED', payment_id: id }
            );
        }

        if (payment.current_deposit_id) {
            throw AppError.conflict(
                `El pago ${paymentNumber(id)} ya forma parte del depósito ${depositNumber(payment.current_deposit_id)}`,
                { reason: 'PAYMENT_ALREADY_DEPOSITED', payment_id: id, deposit_id: Number(payment.current_deposit_id) }
            );
        }

        const saleBranch = payment.sale_branch_id === null ? null : Number(payment.sale_branch_id);
        let branchOverride = false;

        if (saleBranch === null) {
            // Venta histórica sin sucursal. Decisión del propietario
            // (2026-09-18): se rechaza, salvo que lo incluya administración.
            if (!canOverride) {
                throw AppError.conflict(
                    `La venta del pago ${paymentNumber(id)} no tiene sucursal registrada, así que no se puede ` +
                        'comprobar que corresponda a este depósito. Solo administración puede incluirlo.',
                    { reason: 'PAYMENT_WITHOUT_BRANCH', payment_id: id }
                );
            }
            branchOverride = true;
        } else if (saleBranch !== Number(deposit.branch_id)) {
            throw AppError.conflict(
                `El pago ${paymentNumber(id)} pertenece a otra sucursal y no puede entrar en este depósito`,
                { reason: 'PAYMENT_OTHER_BRANCH', payment_id: id, payment_branch_id: saleBranch }
            );
        }

        await Deposit.addPayment(client, deposit.id, id, actor?.id ?? null);
        await Deposit.recordEvent(client, {
            depositId: deposit.id,
            event: 'PAGO_AGREGADO',
            fromStatus: deposit.status,
            toStatus: deposit.status,
            actorId: actor?.id ?? null,
            paymentId: id,
            comment:
                `Se incluyó el pago ${paymentNumber(id)} por Q${payment.amount} (${payment.method})` +
                (branchOverride
                    ? '. Excepción autorizada: la venta no tiene sucursal registrada.'
                    : ''),
        });

        added.push({ id, amount: payment.amount, method: payment.method, branch_override: branchOverride });
    }

    return added;
}

/**
 * Registra un depósito y, si vienen, incluye sus pagos en la MISMA
 * transacción: o entra el depósito completo o no entra nada.
 */
export async function createDeposit(input, actor, { canOverride = false } = {}) {
    const branchId = await resolveBranch(actor, input.branch_id);

    const id = await withTransaction(async (client) => {
        const deposit = await Deposit.create(client, {
            ...input,
            branch_id: branchId,
            created_by: actor?.id ?? null,
        });

        await Deposit.recordEvent(client, {
            depositId: deposit.id,
            event: 'CREADO',
            toStatus: deposit.status,
            actorId: actor?.id ?? null,
            comment: `Depósito registrado por Q${deposit.declared_amount}` + (input.notes ? `. ${input.notes}` : ''),
        });

        await attachPayments(client, deposit, input.payment_ids ?? [], actor, canOverride);
        return deposit.id;
    });

    return getDeposit(id);
}

export async function addPaymentsToDeposit(id, paymentIds, actor, { canOverride = false } = {}) {
    await withTransaction(async (client) => {
        const deposit = await Deposit.lockById(client, id);
        if (!deposit) throw AppError.notFound('Depósito no encontrado');
        if (deposit.status !== 'REVISADO') {
            throw AppError.conflict('El depósito ya está validado: no admite más pagos');
        }
        await attachPayments(client, deposit, paymentIds, actor, canOverride);
    });

    return getDeposit(id);
}

/**
 * Observación, explicación y rechazo.
 *
 * Los tres escriben en el historial y NINGUNO cambia el estado: el depósito
 * sigue REVISADO. En particular RECHAZADO es un evento, no un estado, y no
 * revierte ni borra ningún pago.
 */
async function appendEvent(id, event, comment, actor) {
    await withTransaction(async (client) => {
        const deposit = await Deposit.lockById(client, id);
        if (!deposit) throw AppError.notFound('Depósito no encontrado');
        if (deposit.status === 'VALIDADO') {
            throw AppError.conflict('El depósito ya está validado: su revisión terminó');
        }

        await Deposit.recordEvent(client, {
            depositId: id,
            event,
            fromStatus: deposit.status,
            toStatus: deposit.status,
            actorId: actor?.id ?? null,
            comment,
        });
    });

    return getDeposit(id);
}

export const observeDeposit = (id, comment, actor) => appendEvent(id, 'OBSERVADO', comment, actor);
export const explainDeposit = (id, comment, actor) => appendEvent(id, 'EXPLICADO', comment, actor);
export const rejectDeposit = (id, comment, actor) => appendEvent(id, 'RECHAZADO', comment, actor);

/**
 * REVISADO -> VALIDADO. Estado terminal.
 *
 * Validar NO exige que la diferencia sea cero: si no cuadra, quien revisa lo
 * sabe, lo deja documentado con una observación y decide. Forzar el cuadre
 * sería inventar una regla que nadie definió.
 *
 * SEPARACIÓN DE FUNCIONES (decisión del propietario, 2026-09-18): quien
 * registró el depósito NO puede validarlo, tenga el permiso que tenga. Vale
 * igual para el cobrador y para administración: nadie cierra su propio
 * movimiento de caja. La base lo vuelve a impedir con la restricción
 * `deposits_validator_is_not_creator` (migración 017), así que tampoco se
 * consigue por SQL directo.
 */
export async function validateDeposit(id, comment, actor) {
    await withTransaction(async (client) => {
        const deposit = await Deposit.lockById(client, id);
        if (!deposit) throw AppError.notFound('Depósito no encontrado');
        if (deposit.status === 'VALIDADO') throw AppError.conflict('El depósito ya estaba validado');

        if (deposit.created_by !== null && Number(deposit.created_by) === Number(actor?.id)) {
            throw AppError.forbidden(
                'Quien registra un depósito no puede validarlo: tiene que revisarlo otro usuario autorizado',
                { reason: 'SELF_VALIDATION', deposit_id: Number(id), created_by: Number(deposit.created_by) }
            );
        }

        const done = await Deposit.markValidated(client, id, actor?.id ?? null);
        if (!done) throw AppError.conflict('El depósito ya estaba validado');

        await Deposit.recordEvent(client, {
            depositId: id,
            event: 'VALIDADO',
            fromStatus: 'REVISADO',
            toStatus: 'VALIDADO',
            actorId: actor?.id ?? null,
            comment: comment ?? null,
        });
    });

    return getDeposit(id);
}
