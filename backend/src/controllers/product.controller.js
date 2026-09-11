import * as service from '../services/product.service.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { can } from '../services/authorization.service.js';
import { inventoryScope } from '../services/scope.service.js';
import { productAvailability } from '../services/inventory.service.js';
import { hideCostUnlessAllowed } from '../utils/visibility.js';

/**
 * RN-0001 y RN-0002: el costo solo viaja si quien pregunta tiene el permiso
 * `products.cost.view`. Se filtra aquí, en la salida, y no en el SQL, porque
 * el servicio de ventas necesita el costo internamente para congelarlo en el
 * detalle de la venta.
 */
const maySeeCost = (req) => can(req.user?.role, 'products.cost.view');

export const list = asyncHandler(async (req, res) => {
    const q = req.validatedQuery;

    // Si el usuario opera con el inventario de una sola sucursal, el
    // listado añade `branch_stock`: las unidades con las que realmente
    // puede operar. `stock` sigue siendo el total de la empresa y para él
    // es informativo.
    const scope = await inventoryScope(req.user);
    const scopeBranchId = scope && !scope.global ? scope.branchId : null;

    const result = await service.listProducts({
        ...q,
        categoryId: q.category_id ?? null,
        brandId: q.brand_id ?? null,
        scopeBranchId,
    });
    const allowed = await maySeeCost(req);
    res.json({
        ok: true,
        ...result,
        data: hideCostUnlessAllowed(result.data, allowed),
        ...(scopeBranchId
            ? { scope: { global: false, branch_id: scopeBranchId } }
            : {}),
    });
});

export const getOne = asyncHandler(async (req, res) => {
    const product = await service.getProduct(req.params.id);
    res.json({ ok: true, data: hideCostUnlessAllowed(product, await maySeeCost(req)) });
});

export const create = asyncHandler(async (req, res) => {
    const product = await service.createProduct(req.body, req.user?.id);
    res.status(201).json({
        ok: true,
        data: hideCostUnlessAllowed(product, await maySeeCost(req)),
        message: 'Producto registrado correctamente',
    });
});

export const update = asyncHandler(async (req, res) => {
    const product = await service.updateProduct(req.params.id, req.body, req.user?.id);
    res.json({
        ok: true,
        data: hideCostUnlessAllowed(product, await maySeeCost(req)),
        message: 'Producto actualizado',
    });
});

export const setActive = asyncHandler(async (req, res) => {
    const product = await service.setProductActive(req.params.id, req.body.is_active);
    res.json({
        ok: true,
        data: hideCostUnlessAllowed(product, await maySeeCost(req)),
        message: req.body.is_active ? 'Producto activado' : 'Producto desactivado',
    });
});

export const adjustStock = asyncHandler(async (req, res) => {
    const product = await service.adjustStock(req.params.id, req.body, req.user?.id);
    res.json({
        ok: true,
        data: hideCostUnlessAllowed(product, await maySeeCost(req)),
        message: 'Inventario actualizado',
    });
});

export const stockMovements = asyncHandler(async (req, res) => {
    const data = await service.getStockMovements(req.params.id, 100);
    res.json({ ok: true, data });
});

export const categories = asyncHandler(async (_req, res) => {
    const data = await service.listCategories();
    res.json({ ok: true, data });
});

/**
 * Histórico de costos. Va detrás de `products.cost.view` (RN-0001): es el
 * mismo secreto que el costo actual, solo que a lo largo del tiempo.
 */
export const costHistory = asyncHandler(async (req, res) => {
    const data = await service.getCostHistory(req.params.id, 100);
    res.json({ ok: true, data });
});

/**
 * Existencias del producto por sucursal, marcando cuáles son operativas
 * para quien pregunta y cuáles son solo informativas.
 */
export const inventory = asyncHandler(async (req, res) => {
    const data = await productAvailability(req.user, req.params.id);
    res.json({ ok: true, data, message: data.notice ?? undefined });
});

export const previewPrices = asyncHandler(async (req, res) => {
    const data = service.previewPrices(req.validatedQuery.cost);
    res.json({ ok: true, data });
});
