import * as service from '../services/sale.service.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { PAYMENT_MODES } from '../utils/pricing.js';

export const list = asyncHandler(async (req, res) => {
    const result = await service.listSales(req.validatedQuery);
    res.json({ ok: true, ...result });
});

export const getOne = asyncHandler(async (req, res) => {
    const sale = await service.getSale(req.params.id);
    res.json({ ok: true, data: sale });
});

/** Cálculo en vivo para el formulario: no persiste nada. */
export const quote = asyncHandler(async (req, res) => {
    const data = await service.quoteSale(req.body);
    res.json({ ok: true, data });
});

export const create = asyncHandler(async (req, res) => {
    const sale = await service.createSale(req.body, req.user?.id);
    res.status(201).json({ ok: true, data: sale, message: `Venta ${sale.sale_number} registrada` });
});

export const cancel = asyncHandler(async (req, res) => {
    const sale = await service.cancelSale(req.params.id, req.body.reason, req.user?.id);
    res.json({ ok: true, data: sale, message: 'Venta anulada y stock restituido' });
});

export const paymentModes = asyncHandler(async (_req, res) => {
    res.json({
        ok: true,
        data: Object.values(PAYMENT_MODES).map((m) => ({
            key: m.key,
            label: m.label,
            markup_percent: Math.round(m.markup * 100),
            installments: m.installments,
        })),
    });
});
