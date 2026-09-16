import { Router } from 'express';
import authRoutes from './auth.routes.js';
import customerRoutes from './customer.routes.js';
import productRoutes from './product.routes.js';
import saleRoutes from './sale.routes.js';
import paymentRoutes from './payment.routes.js';
import creditApplicationRoutes from './creditApplication.routes.js';
import integrationRoutes from './integration.routes.js';
import userRoutes from './user.routes.js';
import roleRoutes from './role.routes.js';
import auditRoutes from './audit.routes.js';
import branchRoutes from './branch.routes.js';
import inventoryRoutes from './inventory.routes.js';
import { categoryRoutes, brandRoutes, catalogRoutes } from './taxonomy.routes.js';
import { query } from '../config/db.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { requireAuth } from '../middleware/auth.js';
import { requirePermission } from '../middleware/permissions.js';
import { receivablesScope, ownPortfolioFilter } from '../services/scope.service.js';
import { today } from '../utils/dates.js';

const router = Router();

router.get(
    '/health',
    asyncHandler(async (_req, res) => {
        const { rows } = await query('SELECT 1 AS ok');
        res.json({ ok: true, data: { api: 'up', database: rows[0].ok === 1 ? 'up' : 'down', today: today() } });
    })
);

router.use('/auth', authRoutes);
router.use('/customers', customerRoutes);
router.use('/products', productRoutes);
router.use('/sales', saleRoutes);
router.use('/payments', paymentRoutes);
router.use('/credit-applications', creditApplicationRoutes);
router.use('/integrations', integrationRoutes);
router.use('/users', userRoutes);
router.use('/roles', roleRoutes);
router.use('/audit', auditRoutes);
router.use('/branches', branchRoutes);
router.use('/inventory', inventoryRoutes);
router.use('/categories', categoryRoutes);
router.use('/brands', brandRoutes);
router.use('/catalog', catalogRoutes);

/** Resumen operativo para la pantalla de inicio. */
router.get(
    '/dashboard',
    requireAuth,
    requirePermission('dashboard.view', { module: 'dashboard' }),
    asyncHandler(async (req, res) => {
        const [customers, products, sales, receivables] = await Promise.all([
            query('SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE is_active)::int AS active FROM customers'),
            query(
                `SELECT COUNT(*)::int AS total,
                        COUNT(*) FILTER (WHERE is_active)::int AS active,
                        COUNT(*) FILTER (WHERE stock <= min_stock)::int AS low_stock
                   FROM products`
            ),
            query(
                `SELECT COUNT(*)::int AS total,
                        COUNT(*) FILTER (WHERE sale_date = app_today())::int AS today_count,
                        COALESCE(SUM(total) FILTER (WHERE sale_date = app_today()), 0)::numeric(12,2) AS today_amount
                   FROM v_sales WHERE status = 'activa'`
            ),
            // La tarjeta "Por cobrar" respeta el alcance del usuario: si solo
            // tiene cartera propia, el total del panel no puede contradecir a
            // la pantalla de Cobranza.
            (async () => {
                const scope = await receivablesScope(req.user);
                if (!scope) return { rows: [{ total_balance: '0.00', overdue_sales: 0 }] };

                const params = [];
                const filters = ["status = 'activa'", 'balance > 0'];
                if (!scope.global) filters.push(ownPortfolioFilter(scope, params));

                return query(
                    `SELECT COALESCE(SUM(balance), 0)::numeric(12,2) AS total_balance,
                            COUNT(*) FILTER (WHERE account_status = 'vencida')::int AS overdue_sales
                       FROM v_sales WHERE ${filters.join(' AND ')}`,
                    params
                );
            })(),
        ]);

        res.json({
            ok: true,
            data: {
                today: today(),
                customers: customers.rows[0],
                products: products.rows[0],
                sales: sales.rows[0],
                receivables: receivables.rows[0],
            },
        });
    })
);

export default router;
