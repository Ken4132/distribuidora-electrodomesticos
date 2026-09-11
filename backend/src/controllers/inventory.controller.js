import * as service from '../services/inventory.service.js';
import { asyncHandler } from '../utils/asyncHandler.js';

/**
 * El alcance lo resuelve el SERVICIO a partir del usuario autenticado, no
 * de lo que venga en la consulta. Aquí solo se pasa lo que pidió el
 * cliente; si su alcance es propio, el servicio le impone su sucursal.
 */
export const list = asyncHandler(async (req, res) => {
    const q = req.validatedQuery;
    const result = await service.listInventory(req.user, {
        branchId: q.branch_id ?? null,
        search: q.search,
        onlyRestock: q.restock,
        withStock: q.withStock,
        page: q.page,
        pageSize: q.pageSize,
    });
    res.json({ ok: true, ...result });
});

export const summary = asyncHandler(async (req, res) => {
    const data = await service.inventorySummary(req.user);
    res.json({ ok: true, data });
});

export const adjust = asyncHandler(async (req, res) => {
    const data = await service.adjustInventory(
        {
            productId: req.body.product_id,
            branchId: req.body.branch_id,
            delta: req.body.delta,
            reason: req.body.reason,
            notes: req.body.notes ?? null,
        },
        req.user?.id
    );
    res.json({ ok: true, data, message: data.warning ?? 'Inventario actualizado' });
});

export const setMinStock = asyncHandler(async (req, res) => {
    const data = await service.setMinStock({
        productId: req.body.product_id,
        branchId: req.body.branch_id,
        minStock: req.body.min_stock,
    });
    res.json({ ok: true, data, message: 'Mínimo de reposición actualizado' });
});

/**
 * Comprobación de integridad: `products.stock` contra la suma del desglose
 * por sucursal. En condiciones normales devuelve una lista vacía.
 */
export const mismatches = asyncHandler(async (_req, res) => {
    const data = await service.inventoryMismatches();
    res.json({
        ok: true,
        data,
        message: data.length
            ? `${data.length} producto(s) con descuadre entre la existencia total y el desglose por sucursal`
            : 'El inventario por sucursal cuadra con la existencia total de cada producto',
    });
});
