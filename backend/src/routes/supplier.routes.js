/**
 * PROVEEDORES — rutas.
 *
 * PERMISOS: este módulo NO estrena ninguno. Se apoya en los de inventario,
 * que ya protegen exactamente la misma audiencia y el mismo secreto:
 *
 *     LECTURA    `inventory.view` O `inventory.manage`
 *     ESCRITURA  `inventory.manage`
 *
 * El razonamiento completo está en la migración 021, sección 5, y sigue la
 * doctrina que el propio proyecto dejó escrita en la 004 a propósito de
 * categorías y marcas: un permiso nuevo que no protege nada distinto solo
 * añade una casilla más que mantener.
 *
 * `inventory.manage` es el permiso de quien registra la ENTRADA de
 * mercadería —el movimiento cuyo motivo ya se llama "compra a proveedor"—,
 * así que administrar el catálogo de proveedores le corresponde. Hoy lo
 * tiene únicamente el administrador.
 *
 * El alta, la modificación y el cambio de estado quedan en la bitácora:
 * son las operaciones que el bloque exige auditar.
 */
import { Router } from 'express';
import * as ctrl from '../controllers/supplier.controller.js';
import { validate } from '../middleware/validate.js';
import { requireAuth } from '../middleware/auth.js';
import { requirePermission, requireAnyPermission, audit } from '../middleware/permissions.js';
import { idParam } from '../validators/common.schema.js';
import {
    createSupplierSchema,
    updateSupplierSchema,
    listSuppliersSchema,
    setSupplierActiveSchema,
} from '../validators/supplier.schema.js';

const router = Router();
router.use(requireAuth);

const MODULE = 'compras';

const puedeConsultar = requireAnyPermission('inventory.view', 'inventory.manage', { module: MODULE });
const puedeAdministrar = requirePermission('inventory.manage', { module: MODULE });

router.get('/', puedeConsultar, validate({ query: listSuppliersSchema }), ctrl.list);

router.post(
    '/',
    puedeAdministrar,
    validate({ body: createSupplierSchema }),
    audit('supplier.create', {
        module: MODULE,
        entity: 'supplier',
        summary: (req, payload) =>
            `Registró al proveedor ${payload?.data?.business_name} (NIT ${payload?.data?.nit})`,
    }),
    ctrl.create
);

router.get('/:id', puedeConsultar, validate({ params: idParam }), ctrl.getOne);

router.patch(
    '/:id',
    puedeAdministrar,
    validate({ params: idParam, body: updateSupplierSchema }),
    audit('supplier.update', {
        module: MODULE,
        entity: 'supplier',
        summary: (req, payload) => `Modificó al proveedor ${payload?.data?.business_name}`,
        details: (req) => ({ campos: Object.keys(req.body ?? {}) }),
    }),
    ctrl.update
);

/**
 * Alta y baja LÓGICA. No existe DELETE: un proveedor borrado dejaría sin
 * origen las compras que se registren sobre él. La base lo impide además
 * con el trigger `trg_suppliers_no_delete`.
 */
router.patch(
    '/:id/active',
    puedeAdministrar,
    validate({ params: idParam, body: setSupplierActiveSchema }),
    audit('supplier.status', {
        module: MODULE,
        entity: 'supplier',
        summary: (req, payload) =>
            `${req.body?.is_active ? 'Reactivó' : 'Desactivó'} al proveedor ${payload?.data?.business_name} ` +
            `(NIT ${payload?.data?.nit})`,
    }),
    ctrl.setActive
);

export default router;
