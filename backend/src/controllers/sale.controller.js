import * as service from '../services/sale.service.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { PAYMENT_MODES } from '../utils/pricing.js';
import { can } from '../services/authorization.service.js';
import { hideCostUnlessAllowed } from '../utils/visibility.js';

/**
 * RN-0001: el detalle de una venta lleva `unit_cost` congelado. Es
 * trazabilidad necesaria en la base de datos, pero no debe salir hacia
 * quien no tiene permiso de ver costos.
 */
const maySeeCost = (req) => can(req.user?.role, 'products.cost.view');

export const list = asyncHandler(async (req, res) => {
    const result = await service.listSales(req.validatedQuery);
    res.json({ ok: true, ...result });
});

export const getOne = asyncHandler(async (req, res) => {
    const sale = await service.getSale(req.params.id);
    res.json({ ok: true, data: hideCostUnlessAllowed(sale, await maySeeCost(req)) });
});

/** Cálculo en vivo para el formulario: no persiste nada. */
export const quote = asyncHandler(async (req, res) => {
    const data = await service.quoteSale(req.body);
    res.json({ ok: true, data: hideCostUnlessAllowed(data, await maySeeCost(req)) });
});

export const create = asyncHandler(async (req, res) => {
    const sale = await service.createSale(req.body, req.user?.id);
    res.status(201).json({
        ok: true,
        data: hideCostUnlessAllowed(sale, await maySeeCost(req)),
        message: `Venta ${sale.sale_number} registrada`,
    });
});

export const cancel = asyncHandler(async (req, res) => {
    const sale = await service.cancelSale(req.params.id, req.body.reason, req.user?.id);
    res.json({
        ok: true,
        data: hideCostUnlessAllowed(sale, await maySeeCost(req)),
        message: 'Venta anulada y stock restituido',
    });
});

/**
 * Publica las reglas comerciales para que el frontend NO tenga que repetir
 * los porcentajes. Una sola fuente de verdad en la aplicación.
 *
 * `markup` se omite para quien no puede ver costos: publicar el porcentaje
 * junto al precio de venta equivale a publicar el costo (RN-0001).
 */
export const paymentModes = asyncHandler(async (req, res) => {
    const allowed = await maySeeCost(req);
    res.json({
        ok: true,
        data: Object.values(PAYMENT_MODES).map((m) => ({
            key: m.key,
            label: m.label,
            installments: m.installments,
            price_field: m.priceField,
            ...(allowed ? { markup: m.markup, markup_percent: Math.round(m.markup * 100) } : {}),
        })),
    });
});
