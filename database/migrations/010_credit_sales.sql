-- =====================================================================
-- 010_credit_sales.sql
-- BLOQUE 3.3: venta concretada desde una solicitud de crédito aprobada.
--
-- Decisiones del propietario (2026-09-17), ver docs/REGLAS-DE-NEGOCIO.md §11.
--
-- Solo aditiva:
--   * `sales` admite una modalidad NUEVA `credito` (cuotas libres). Las
--     restricciones se reemplazan por otras que aceptan exactamente lo mismo
--     que antes MÁS `credito`: ninguna venta existente cambia ni se revalida
--     con otra regla. `credito_4` y `credito_8` quedan para históricos.
--   * Enlace venta <-> solicitud (1 a 1).
--   * No toca pagos, cuotas ni precios históricos.
-- =====================================================================


-- =====================================================================
-- 1. MODALIDAD `credito`
-- =====================================================================
ALTER TABLE sales DROP CONSTRAINT IF EXISTS sales_payment_mode_check;
ALTER TABLE sales
    ADD CONSTRAINT sales_payment_mode_check
    CHECK (payment_mode IN ('contado', 'credito_4', 'credito_8', 'credito'));

ALTER TABLE sales DROP CONSTRAINT IF EXISTS sales_mode_installments;
ALTER TABLE sales
    ADD CONSTRAINT sales_mode_installments CHECK (
        (payment_mode = 'contado'   AND installments_count = 1) OR
        (payment_mode = 'credito_4' AND installments_count = 4) OR
        (payment_mode = 'credito_8' AND installments_count = 8) OR
        (payment_mode = 'credito'   AND installments_count >= 1)
    );

COMMENT ON COLUMN sales.payment_mode IS
    'contado | credito (desde 010: venta de una solicitud aprobada, cuotas libres) | credito_4 / credito_8 (históricos, reglas anteriores).';


-- =====================================================================
-- 2. ENLACE VENTA <-> SOLICITUD
-- =====================================================================
ALTER TABLE sales ADD COLUMN IF NOT EXISTS credit_application_id INTEGER
    REFERENCES credit_applications (id) ON DELETE RESTRICT;

CREATE UNIQUE INDEX IF NOT EXISTS ux_sales_credit_application
    ON sales (credit_application_id) WHERE credit_application_id IS NOT NULL;

-- Toda venta `credito` nace de una solicitud: no hay camino que la salte.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sales_credito_requires_application') THEN
        ALTER TABLE sales
            ADD CONSTRAINT sales_credito_requires_application
            CHECK (payment_mode <> 'credito' OR credit_application_id IS NOT NULL);
    END IF;
END $$;

ALTER TABLE credit_applications ADD COLUMN IF NOT EXISTS sale_id BIGINT
    REFERENCES sales (id) ON DELETE RESTRICT;
CREATE UNIQUE INDEX IF NOT EXISTS ux_credit_applications_sale
    ON credit_applications (sale_id) WHERE sale_id IS NOT NULL;

ALTER TABLE credit_applications ADD COLUMN IF NOT EXISTS concretized_at TIMESTAMPTZ;
ALTER TABLE credit_applications ADD COLUMN IF NOT EXISTS concretized_by BIGINT
    REFERENCES users (id) ON DELETE RESTRICT;
ALTER TABLE credit_applications ADD COLUMN IF NOT EXISTS activated_at TIMESTAMPTZ;
ALTER TABLE credit_applications ADD COLUMN IF NOT EXISTS actual_down_payment NUMERIC(12, 2);

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'credit_applications_actual_down_payment_check') THEN
        ALTER TABLE credit_applications
            ADD CONSTRAINT credit_applications_actual_down_payment_check
            CHECK (actual_down_payment IS NULL OR actual_down_payment >= 0);
    END IF;
END $$;

COMMENT ON COLUMN credit_applications.actual_down_payment IS
    'Enganche REAL registrado al concretar la venta (pago inicial). Puede ser menor que el aprobado; Q0 no genera pago.';


-- =====================================================================
-- 3. CONTROL DE REGULARIZACIÓN DEL CRÉDITO EXCEPCIONAL (regla 13)
--
-- Solo informativo y calculado: créditos excepcionales activos con saldo y
-- días transcurridos desde la activación (fecha de la venta concretada). `requires_regularization` indica
-- que superaron 60 días. El PROCESO de regularización no se implementa aquí.
-- =====================================================================
CREATE OR REPLACE VIEW v_exceptional_credit_control AS
SELECT ca.id                                                   AS credit_application_id,
       ca.application_number,
       ca.customer_id,
       ca.customer_full_name_snapshot,
       ca.branch_id,
       ca.sale_id,
       ca.activated_at,
       vs.sale_date                                            AS activation_date,
       (app_today() - vs.sale_date)                            AS days_since_activation,
       vs.total,
       vs.paid_amount,
       vs.balance,
       (vs.balance > 0
        AND (app_today() - vs.sale_date) > 60)                 AS requires_regularization
  FROM credit_applications ca
  JOIN v_sales vs ON vs.id = ca.sale_id
 WHERE ca.credit_type = 'EXCEPCIONAL_CONTADO'
   AND ca.status = 'ACTIVO';


-- =====================================================================
-- 4. PERMISOS
-- =====================================================================
INSERT INTO permissions (code, module, name, description) VALUES
    ('credits.concretize',     'creditos', 'Concretar la venta de cualquier solicitud aprobada',
     'Respaldo operativo: Administración y Gerencia.'),
    ('credits.concretize.own', 'creditos', 'Concretar la venta de las solicitudes propias',
     'Solo solicitudes aprobadas creadas por el propio usuario.')
ON CONFLICT (code) DO UPDATE
    SET module = EXCLUDED.module, name = EXCLUDED.name, description = EXCLUDED.description;

INSERT INTO role_permissions (role_code, permission_code)
SELECT 'admin', code FROM permissions
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_code, permission_code)
SELECT r.code, p.code
  FROM (VALUES ('gerencia', 'credits.concretize'), ('vendedor', 'credits.concretize.own')) AS v(role_code, permission_code)
  JOIN roles r ON r.code = v.role_code
  JOIN permissions p ON p.code = v.permission_code
ON CONFLICT DO NOTHING;

-- =====================================================================
-- FIN 010
-- =====================================================================
