import * as portfolio from '../services/portfolio.service.js';
import * as restructuring from '../services/restructuring.service.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { receivablesScope } from '../services/scope.service.js';
import { actorFrom } from '../services/audit.service.js';
import { AppError } from '../utils/AppError.js';

/** Alcance de cartera: global o solo la propia (regla U6). */
async function scopeOf(req) {
    const scope = await receivablesScope(req.user);
    if (!scope) throw AppError.forbidden('Tu usuario no tiene permiso para consultar la cartera');
    return scope;
}

const scopeLabel = (scope) => (scope.global ? 'global' : 'propia');

export const list = asyncHandler(async (req, res) => {
    const scope = await scopeOf(req);
    const result = await portfolio.portfolio({ ...req.validatedQuery, scope });
    res.json({ ok: true, ...result, scope: scopeLabel(scope) });
});

export const installments = asyncHandler(async (req, res) => {
    const scope = await scopeOf(req);
    const result = await portfolio.installments({ ...req.validatedQuery, scope });
    res.json({ ok: true, ...result, scope: scopeLabel(scope) });
});

/** Atajo de la pantalla de cobranza: solo lo vencido. */
export const overdue = asyncHandler(async (req, res) => {
    const scope = await scopeOf(req);
    const result = await portfolio.installments({ ...req.validatedQuery, scope, onlyOverdue: true });
    res.json({ ok: true, ...result, scope: scopeLabel(scope) });
});

export const summary = asyncHandler(async (req, res) => {
    const scope = await scopeOf(req);
    const data = await portfolio.summary({ ...req.validatedQuery, scope });
    res.json({ ok: true, data, scope: scopeLabel(scope) });
});

export const ofCustomer = asyncHandler(async (req, res) => {
    const scope = await scopeOf(req);
    res.json({ ok: true, data: await portfolio.customerPortfolio(req.params.id, scope), scope: scopeLabel(scope) });
});

/** Expediente del crédito: cuotas, pagos, recibos y reestructuraciones. */
export const creditDetail = asyncHandler(async (req, res) => {
    const scope = await scopeOf(req);
    res.json({ ok: true, data: await portfolio.creditDetail(req.params.id, scope) });
});

export const restructurings = asyncHandler(async (req, res) => {
    await scopeOf(req);
    res.json({ ok: true, data: await portfolio.restructuringsOf(req.params.id) });
});

export const restructure = asyncHandler(async (req, res) => {
    // Quien reestructura tiene `credits.restructure` (admin/gerencia), que
    // van siempre con alcance global de cartera.
    const scope = await receivablesScope(req.user);
    const data = await restructuring.restructureSale(req.params.id, req.body, actorFrom(req), scope);
    res.status(201).json({
        ok: true,
        data,
        message:
            `Crédito ${data.credit?.sale_number} reestructurado. ` +
            `Nuevo saldo Q${data.credit?.balance} en ${req.body.new_installments} cuotas.`,
    });
});
