import * as events from '../services/events.service.js';
import * as collections from '../services/collections.service.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { AppError } from '../utils/AppError.js';

export const status = asyncHandler(async (_req, res) => {
    const data = await events.outboxSummary();
    res.json({ ok: true, data });
});

export const list = asyncHandler(async (req, res) => {
    const result = await events.listEvents(req.validatedQuery);
    res.json({ ok: true, ...result });
});

export const getOne = asyncHandler(async (req, res) => {
    const event = await events.getEvent(req.params.id);
    if (!event) throw AppError.notFound('Evento no encontrado');
    res.json({ ok: true, data: event });
});

export const retry = asyncHandler(async (req, res) => {
    const event = await events.retryEvent(req.params.id);
    if (!event) throw AppError.conflict('El evento no existe o ya fue enviado');
    events.dispatchInBackground();
    res.json({ ok: true, data: event, message: 'Evento puesto en cola para reintento' });
});

/** Fuerza un despacho inmediato y espera el resultado (útil para diagnosticar). */
export const dispatchNow = asyncHandler(async (_req, res) => {
    const result = await events.dispatchPending({ limit: 50 });
    res.json({
        ok: true,
        data: result,
        message: result.enabled
            ? `Despacho ejecutado: ${result.sent} enviado(s), ${result.failed} fallido(s)`
            : 'El despacho hacia n8n está desactivado (N8N_DISPATCH_ENABLED)',
    });
});

/** Ejecuta el barrido de cobranza a mano, sin esperar al ciclo programado. */
export const scanNow = asyncHandler(async (_req, res) => {
    const result = await collections.scanInstallments();
    res.json({
        ok: true,
        data: result,
        message: `Barrido ${result.scanned_on}: ${result.created.upcoming} por vencer y ${result.created.overdue} vencida(s) generadas, ${result.skipped} ya avisada(s)`,
    });
});

export const preview = asyncHandler(async (_req, res) => {
    const data = await collections.collectionsPreview();
    res.json({ ok: true, data });
});

export const catalog = asyncHandler(async (_req, res) => {
    res.json({ ok: true, data: events.ALL_EVENT_TYPES });
});
