import { Router } from 'express';
import * as ctrl from '../controllers/collections.controller.js';
import { validate } from '../middleware/validate.js';
import { requireAuth } from '../middleware/auth.js';
import { requireAnyPermission, requirePermission, audit } from '../middleware/permissions.js';
import { idParam } from '../validators/common.schema.js';
import {
    portfolioQuerySchema,
    installmentsQuerySchema,
    summaryQuerySchema,
    restructureSchema,
} from '../validators/collections.schema.js';

const router = Router();
router.use(requireAuth);

const MODULE = 'cobranza';

/**
 * CONSULTA DE CARTERA. Usa el par de permisos que ya existe desde el bloque 1:
 * `receivables.view` (toda la empresa) y `receivables.view.own` (solo los
 * créditos que registró el propio usuario). CUÁL de los dos aplica lo decide
 * el servicio; aquí solo se deja fuera a quien no tiene ninguno.
 */
const canView = requireAnyPermission('receivables.view', 'receivables.view.own', { module: MODULE });

router.get('/', canView, validate({ query: portfolioQuerySchema }), ctrl.list);
router.get('/summary', canView, validate({ query: summaryQuerySchema }), ctrl.summary);
router.get('/installments', canView, validate({ query: installmentsQuerySchema }), ctrl.installments);
router.get('/overdue', canView, validate({ query: installmentsQuerySchema }), ctrl.overdue);
router.get('/customers/:id', canView, validate({ params: idParam }), ctrl.ofCustomer);
router.get('/credits/:id', canView, validate({ params: idParam }), ctrl.creditDetail);
router.get('/credits/:id/restructurings', canView, validate({ params: idParam }), ctrl.restructurings);

/**
 * REESTRUCTURACIÓN / REGULARIZACIÓN. La autorización de Administración o
 * Gerencia ES la operación: no hay un segundo proceso de aprobación.
 */
router.post(
    '/credits/:id/restructure',
    requirePermission('credits.restructure', { module: MODULE }),
    validate({ params: idParam, body: restructureSchema }),
    audit('credit.restructure', {
        module: MODULE,
        entity: 'sale',
        entityId: (req) => Number(req.params.id),
        summary: (req, payload) => {
            const r = (payload?.data?.restructurings ?? []).at(-1) ?? {};
            return (
                `${r.kind ?? 'Reestructuró'} el crédito ${payload?.data?.credit?.sale_number}: ` +
                `total Q${r.previous_total} → Q${r.new_total}, pagado Q${r.previous_paid}, ` +
                `nuevo saldo Q${r.new_balance} en ${req.body?.new_installments} cuotas. Motivo: ${req.body?.reason}`
            );
        },
        details: (req, payload) => {
            const r = (payload?.data?.restructurings ?? []).at(-1) ?? {};
            return {
                tipo: r.kind ?? null,
                total_anterior: r.previous_total ?? null,
                pagado: r.previous_paid ?? null,
                saldo_anterior: r.previous_balance ?? null,
                total_nuevo: r.new_total ?? null,
                saldo_nuevo: r.new_balance ?? null,
                cuotas: req.body?.new_installments,
                primera_cuota: req.body?.first_due_date,
                motivo: req.body?.reason,
            };
        },
    }),
    ctrl.restructure
);

export default router;
