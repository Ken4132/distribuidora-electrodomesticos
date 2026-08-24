import * as service from '../services/product.service.js';
import { asyncHandler } from '../utils/asyncHandler.js';

export const list = asyncHandler(async (req, res) => {
    const result = await service.listProducts(req.validatedQuery);
    res.json({ ok: true, ...result });
});

export const getOne = asyncHandler(async (req, res) => {
    const product = await service.getProduct(req.params.id);
    res.json({ ok: true, data: product });
});

export const create = asyncHandler(async (req, res) => {
    const product = await service.createProduct(req.body, req.user?.id);
    res.status(201).json({ ok: true, data: product, message: 'Producto registrado correctamente' });
});

export const update = asyncHandler(async (req, res) => {
    const product = await service.updateProduct(req.params.id, req.body);
    res.json({ ok: true, data: product, message: 'Producto actualizado' });
});

export const setActive = asyncHandler(async (req, res) => {
    const product = await service.setProductActive(req.params.id, req.body.is_active);
    res.json({
        ok: true,
        data: product,
        message: req.body.is_active ? 'Producto activado' : 'Producto desactivado',
    });
});

export const adjustStock = asyncHandler(async (req, res) => {
    const product = await service.adjustStock(req.params.id, req.body, req.user?.id);
    res.json({ ok: true, data: product, message: 'Inventario actualizado' });
});

export const stockMovements = asyncHandler(async (req, res) => {
    const data = await service.getStockMovements(req.params.id, 100);
    res.json({ ok: true, data });
});

export const categories = asyncHandler(async (_req, res) => {
    const data = await service.listCategories();
    res.json({ ok: true, data });
});

export const previewPrices = asyncHandler(async (req, res) => {
    const data = service.previewPrices(req.validatedQuery.cost);
    res.json({ ok: true, data });
});
