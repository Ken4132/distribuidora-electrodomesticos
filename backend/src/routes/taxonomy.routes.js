/**
 * Categorías y marcas.
 *
 * CONSULTAR va con `products.view`: ver el catálogo por categoría o por
 * marca es navegar el catálogo, no administrarlo, y un vendedor necesita
 * hacerlo para registrar una venta. Crear un permiso de solo lectura habría
 * quitado esa navegación a quien ya la tenía.
 *
 * ADMINISTRAR exige `categories.manage` / `brands.manage`, permisos nuevos
 * que en la migración 004 se conceden únicamente al administrador.
 */
import { Router } from 'express';
import * as ctrl from '../controllers/taxonomy.controller.js';
import { validate } from '../middleware/validate.js';
import { requireAuth } from '../middleware/auth.js';
import { requirePermission, audit } from '../middleware/permissions.js';
import { idParam } from '../validators/common.schema.js';
import { setActiveSchema } from '../validators/customer.schema.js';
import {
    createTaxonomySchema,
    updateTaxonomySchema,
    listTaxonomySchema,
} from '../validators/taxonomy.schema.js';

const MODULE = 'productos';

/** Monta el mismo juego de rutas para una taxonomía. */
function taxonomyRouter(kind, handlers, managePermission, label) {
    const router = Router();
    router.use(requireAuth);

    router.get('/', requirePermission('products.view', { module: MODULE }), validate({ query: listTaxonomySchema }), handlers.list);

    router.post(
        '/',
        requirePermission(managePermission, { module: MODULE }),
        validate({ body: createTaxonomySchema }),
        audit(`${kind}.create`, {
            module: MODULE,
            entity: kind,
            summary: (req, payload) => `Registró la ${label} "${payload?.data?.name}"`,
        }),
        handlers.create
    );

    router.get(
        '/:id',
        requirePermission('products.view', { module: MODULE }),
        validate({ params: idParam }),
        handlers.getOne
    );

    router.put(
        '/:id',
        requirePermission(managePermission, { module: MODULE }),
        validate({ params: idParam, body: updateTaxonomySchema }),
        audit(`${kind}.update`, {
            module: MODULE,
            entity: kind,
            summary: (req, payload) => `Modificó la ${label} "${payload?.data?.name}"`,
        }),
        handlers.update
    );

    router.patch(
        '/:id/status',
        requirePermission(managePermission, { module: MODULE }),
        validate({ params: idParam, body: setActiveSchema }),
        audit(`${kind}.status`, {
            module: MODULE,
            entity: kind,
            summary: (req, payload) =>
                `${req.body?.is_active ? 'Activó' : 'Desactivó'} la ${label} "${payload?.data?.name}"`,
        }),
        handlers.setActive
    );

    return router;
}

export const categoryRoutes = taxonomyRouter('category', ctrl.categories, 'categories.manage', 'categoría');
export const brandRoutes = taxonomyRouter('brand', ctrl.brands, 'brands.manage', 'marca');

/** Árbol CATEGORÍA -> MARCA -> productos, para navegar el catálogo. */
export const catalogRoutes = Router();
catalogRoutes.use(requireAuth);
catalogRoutes.get('/tree', requirePermission('products.view', { module: MODULE }), ctrl.tree);
