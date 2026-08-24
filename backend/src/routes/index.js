import { Router } from 'express';
import authRoutes from './auth.routes.js';
import customerRoutes from './customer.routes.js';
import productRoutes from './product.routes.js';
import saleRoutes from './sale.routes.js';
import paymentRoutes from './payment.routes.js';
import integrationRoutes from './integration.routes.js';
import { query } from '../config/db.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { requireAuth } from '../middleware/auth.js';
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
router.use('/integrations', integrationRoutes);

/** Resumen operativo para la pantalla de inicio. */
router.get(
    '/dashboard',
    requireAuth,
    asyncHandler(async (_req, res) => {
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
            query(
                `SELECT COALESCE(SUM(balance), 0)::numeric(12,2) AS total_balance,
                        COUNT(*) FILTER (WHERE account_status = 'vencida')::int AS overdue_sales
                   FROM v_sales WHERE status = 'activa' AND balance > 0`
            ),
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
