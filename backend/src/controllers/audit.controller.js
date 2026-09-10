import * as service from '../services/audit.service.js';
import { asyncHandler } from '../utils/asyncHandler.js';

export const list = asyncHandler(async (req, res) => {
    const result = await service.listAudit(req.validatedQuery);
    res.json({ ok: true, ...result });
});

/** Valores ya presentes en la bitácora, para armar los filtros de la pantalla. */
export const filters = asyncHandler(async (_req, res) => {
    const data = await service.auditFilters();
    res.json({ ok: true, data });
});
