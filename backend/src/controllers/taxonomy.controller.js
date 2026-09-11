/**
 * Categorías y marcas comparten comportamiento, así que comparten
 * controlador: `kindFrom` decide cuál según la ruta montada. El valor nunca
 * viene del cuerpo ni de la URL del cliente.
 */
import * as service from '../services/taxonomy.service.js';
import { asyncHandler } from '../utils/asyncHandler.js';

const LABEL = { categories: 'Categoría', brands: 'Marca' };

const handlers = (kind) => ({
    list: asyncHandler(async (req, res) => {
        const data = await service.listTaxonomy(kind, req.validatedQuery);
        res.json({ ok: true, data });
    }),

    getOne: asyncHandler(async (req, res) => {
        const data = await service.getTaxonomy(kind, req.params.id);
        res.json({ ok: true, data });
    }),

    create: asyncHandler(async (req, res) => {
        const data = await service.createTaxonomy(kind, req.body, req.user?.id);
        res.status(201).json({ ok: true, data, message: `${LABEL[kind]} registrada correctamente` });
    }),

    update: asyncHandler(async (req, res) => {
        const data = await service.updateTaxonomy(kind, req.params.id, req.body);
        res.json({ ok: true, data, message: `${LABEL[kind]} actualizada` });
    }),

    setActive: asyncHandler(async (req, res) => {
        const data = await service.setTaxonomyActive(kind, req.params.id, req.body.is_active);
        res.json({
            ok: true,
            data,
            message: data.warning ?? `${LABEL[kind]} ${req.body.is_active ? 'activada' : 'desactivada'}`,
        });
    }),
});

export const categories = handlers('categories');
export const brands = handlers('brands');

/** Árbol CATEGORÍA -> MARCA -> productos. */
export const tree = asyncHandler(async (_req, res) => {
    const data = await service.catalogTree();
    res.json({ ok: true, data });
});
