import { Router } from 'express';
import * as ctrl from '../controllers/creditApplication.controller.js';
import { validate } from '../middleware/validate.js';
import { requireAuth } from '../middleware/auth.js';
import { requirePermission, requireAnyPermission, audit } from '../middleware/permissions.js';
import {
    createCreditApplicationSchema,
    creditApplicationIdSchema,
    listCreditApplicationsSchema,
} from '../validators/creditApplication.schema.js';

const router = Router();
router.use(requireAuth);

const MODULE = 'creditos';

/**
 * Consultar exige AL MENOS uno de los permisos de alcance. Cuál aplica
 * (todas, sucursal por verificar o propias) lo resuelve el servicio, que
 * además filtra en el SQL: lo que no corresponde nunca sale de la base.
 */
const VIEW_PERMISSIONS = ['credits.view', 'credits.view.branch', 'credits.view.own'];

router.get(
    '/',
    requireAnyPermission(...VIEW_PERMISSIONS, { module: MODULE }),
    validate({ query: listCreditApplicationsSchema }),
    ctrl.list
);

router.post(
    '/',
    requirePermission('credits.create', { module: MODULE }),
    validate({ body: createCreditApplicationSchema }),
    audit('credit_application.create', {
        module: MODULE,
        entity: 'credit_application',
        entityId: (req, payload) => payload?.data?.id ?? null,
        summary: (req, payload) =>
            payload?.replayed
                ? `Reenvío de la solicitud de crédito #${payload?.data?.application_number} (no se creó otra)`
                : `Registró la solicitud de crédito #${payload?.data?.application_number} de ${payload?.data?.customer_full_name_snapshot} por Q${payload?.data?.total}`,
        details: (req, payload) => ({
            solicitud_id: payload?.data?.id ?? null,
            numero: payload?.data?.application_number ?? null,
            cliente_id: payload?.data?.customer_id ?? null,
            sucursal_id: payload?.data?.branch_id ?? null,
            total: payload?.data?.total ?? null,
            enganche_propuesto: payload?.data?.proposed_down_payment ?? null,
            productos: payload?.data?.items_count ?? null,
            requiere_excepcion_de_precio: payload?.data?.requires_price_exception ?? null,
            reenvio: Boolean(payload?.replayed),
        }),
    }),
    ctrl.create
);

router.get(
    '/:id',
    requireAnyPermission(...VIEW_PERMISSIONS, { module: MODULE }),
    validate({ params: creditApplicationIdSchema }),
    audit('credit_application.view', {
        module: MODULE,
        entity: 'credit_application',
        summary: (req, payload) => `Consultó la solicitud de crédito #${payload?.data?.application_number}`,
    }),
    ctrl.getOne
);

export default router;
