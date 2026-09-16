-- =====================================================================
-- 008_credit_minimums.sql
-- BLOQUE 3.1 (corrección tras revisión humana): mínimos de financiamiento
--
-- Decisiones confirmadas por el propietario (2026-09-16):
--
--   1. CUOTA MÍNIMA EFECTIVA
--        MAX( cuota matemática del precio mínimo,
--             minimum_installment configurada en el plan )
--      La cuota configurada nunca permite una cuota inferior a la matemática.
--
--   2. PRECIO MÍNIMO PREDEFINIDO
--      product_financing_plans.minimum_price >= costo x (1 + porcentaje)
--        4 -> +40   5 -> +50   6 -> +60   10 -> +80   12 -> +100
--      Ej.: costo Q1000 +40% = Q1400. Q1400 o más: válido. Q1399.99: inválido.
--
-- ESTRATEGIA DE COMPATIBILIDAD CON DATOS HISTÓRICOS
--
--   * La regla 2 compara contra el costo del PRODUCTO (otra tabla), así que
--     no puede ser un CHECK. Se impone con un trigger BEFORE INSERT/UPDATE
--     que solo actúa sobre configuraciones NUEVAS o sobre filas cuyo precio,
--     plazo, porcentaje o producto se MODIFICA. Los planes existentes no se
--     revalidan ni se reescriben; desactivar un plan histórico sigue siendo
--     posible.
--   * Si el costo del producto sube después de configurar un plan, el plan no
--     se toca: el backend usa como mínimo efectivo el MAYOR entre el
--     configurado y el matemático, así que nunca se permite un precio menor.
--   * Las solicitudes existentes no se recalculan. Las columnas nuevas de
--     snapshot quedan NULL en ellas.
--   * No toca `sales`, `sale_items`, `products` ni las reglas históricas de
--     ventas (products.price_credit_4 / price_credit_8, utils/pricing.js).
-- =====================================================================


-- =====================================================================
-- 1. SNAPSHOT DE LO CONFIGURADO POR ADMINISTRACIÓN
--
-- `minimum_price_snapshot` y `minimum_installment_snapshot` guardan el
-- mínimo EFECTIVO aplicado. Estas columnas conservan además lo que el plan
-- tenía configurado en ese momento, para poder auditar de dónde salió el
-- mínimo. NULL en ESPECIAL (no hay plan) y en solicitudes anteriores a 008.
-- =====================================================================
ALTER TABLE credit_application_items
    ADD COLUMN IF NOT EXISTS configured_minimum_price_snapshot NUMERIC(12, 2);

ALTER TABLE credit_application_items
    ADD COLUMN IF NOT EXISTS configured_minimum_installment_snapshot NUMERIC(12, 2);

COMMENT ON COLUMN credit_application_items.configured_minimum_price_snapshot IS
    'Precio mínimo UNITARIO configurado en el plan PREDEFINIDO al crear la solicitud. NULL en ESPECIAL o antes de 008.';
COMMENT ON COLUMN credit_application_items.configured_minimum_installment_snapshot IS
    'Cuota mínima POR UNIDAD configurada en el plan PREDEFINIDO al crear la solicitud. NULL en ESPECIAL o antes de 008.';
COMMENT ON COLUMN credit_application_items.minimum_price_snapshot IS
    'Precio mínimo UNITARIO efectivo. Desde 008 = MAX(costo x (1+pct), mínimo configurado).';
COMMENT ON COLUMN credit_application_items.minimum_installment_snapshot IS
    'Cuota mínima efectiva de la LÍNEA. Desde 008 = MAX(round(precio mínimo x cantidad / cuotas), cuota mínima configurada x cantidad).';
COMMENT ON COLUMN product_financing_plans.minimum_installment IS
    'Cuota mínima POR UNIDAD definida por Administración. El sistema aplica MAX(esta cuota x cantidad, cuota matemática del precio mínimo).';


-- =====================================================================
-- 2. PRECIO MÍNIMO PREDEFINIDO >= MÍNIMO MATEMÁTICO (solo configuraciones nuevas)
-- =====================================================================
CREATE OR REPLACE FUNCTION product_financing_plans_validate_minimum() RETURNS trigger
    LANGUAGE plpgsql
AS $$
DECLARE
    v_cost    NUMERIC(12, 2);
    v_minimum NUMERIC(12, 2);
BEGIN
    -- En UPDATE solo se valida si cambia algo que afecta al mínimo.
    -- Así un plan histórico se puede desactivar sin tener que corregirlo.
    IF TG_OP = 'UPDATE'
       AND NEW.minimum_price        IS NOT DISTINCT FROM OLD.minimum_price
       AND NEW.installments_count   IS NOT DISTINCT FROM OLD.installments_count
       AND NEW.financing_percentage IS NOT DISTINCT FROM OLD.financing_percentage
       AND NEW.product_id           IS NOT DISTINCT FROM OLD.product_id THEN
        RETURN NEW;
    END IF;

    SELECT cost INTO v_cost FROM products WHERE id = NEW.product_id;
    IF v_cost IS NULL THEN
        RETURN NEW; -- la llave foránea reporta el producto inexistente
    END IF;

    -- Redondeo al centavo con el medio centavo hacia arriba (igual que el backend).
    v_minimum := ROUND(v_cost * (100 + NEW.financing_percentage) / 100, 2);

    IF NEW.minimum_price < v_minimum THEN
        RAISE EXCEPTION
            'El precio mínimo del plan de % cuotas (Q%) es inferior al mínimo matemático: costo Q% más % por ciento = Q%',
            NEW.installments_count, NEW.minimum_price, v_cost, NEW.financing_percentage, v_minimum
            USING ERRCODE = 'check_violation',
                  CONSTRAINT = 'product_financing_plans_minimum_price_rule',
                  TABLE = 'product_financing_plans';
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_product_financing_plans_minimum ON product_financing_plans;
CREATE TRIGGER trg_product_financing_plans_minimum
    BEFORE INSERT OR UPDATE ON product_financing_plans
    FOR EACH ROW EXECUTE FUNCTION product_financing_plans_validate_minimum();

-- Planes existentes cuyo precio mínimo quedó por debajo del mínimo matemático
-- con el costo ACTUAL (históricos o por subida de costo). Consulta de apoyo.
CREATE OR REPLACE VIEW v_financing_plans_below_minimum AS
SELECT p.*,
       pr.cost                                                             AS current_cost,
       ROUND(pr.cost * (100 + p.financing_percentage) / 100, 2)::NUMERIC(12, 2) AS mathematical_minimum_price
  FROM product_financing_plans p
  JOIN products pr ON pr.id = p.product_id
 WHERE p.minimum_price < ROUND(pr.cost * (100 + p.financing_percentage) / 100, 2);


-- =====================================================================
-- 3. VISTAS: EXCEPCIÓN POR CUOTA
--
-- CREATE OR REPLACE VIEW solo admite columnas nuevas AL FINAL: las de 007 se
-- conservan en el mismo orden y tipo.
--
--   requires_price_exception       precio unitario < precio mínimo (sin cambio)
--   requires_installment_exception cuota de la línea < cuota mínima efectiva
--   requires_exception             cualquiera de las dos
-- =====================================================================
CREATE OR REPLACE VIEW v_credit_application_items AS
SELECT i.id,
       i.credit_application_id,
       i.product_id,
       i.product_code_snapshot,
       i.product_name_snapshot,
       i.quantity,
       i.cost_snapshot,
       i.financing_type,
       i.installments_count,
       i.financing_percentage_snapshot,
       i.minimum_price_snapshot                                    AS minimum_unit_price,
       i.proposed_price                                            AS proposed_unit_price,
       (i.proposed_price - i.minimum_price_snapshot)::NUMERIC(12, 2) AS unit_price_difference,
       (i.proposed_price * i.quantity)::NUMERIC(12, 2)             AS line_total,
       (i.minimum_price_snapshot * i.quantity)::NUMERIC(12, 2)     AS line_minimum_total,
       ((i.proposed_price - i.minimum_price_snapshot) * i.quantity)::NUMERIC(12, 2) AS line_difference,
       i.proposed_installment                                      AS line_installment,
       i.minimum_installment_snapshot                              AS line_minimum_installment,
       (i.proposed_price < i.minimum_price_snapshot)               AS requires_price_exception,
       i.created_at,
       -- NUEVAS (008)
       i.configured_minimum_price_snapshot                         AS configured_minimum_unit_price,
       i.configured_minimum_installment_snapshot                   AS configured_minimum_unit_installment,
       (i.proposed_installment < i.minimum_installment_snapshot)   AS requires_installment_exception,
       (i.proposed_price < i.minimum_price_snapshot
        OR i.proposed_installment < i.minimum_installment_snapshot) AS requires_exception
FROM credit_application_items i;

CREATE OR REPLACE VIEW v_credit_applications AS
SELECT ca.id,
       ca.application_number,
       ca.status,
       ca.customer_id,
       ca.customer_dpi_snapshot,
       ca.customer_full_name_snapshot,
       ca.branch_id,
       b.code                                                       AS branch_code,
       b.name                                                       AS branch_name,
       ca.created_by,
       u.username                                                   AS created_by_username,
       ca.created_at,
       ca.updated_at,
       ca.submitted_at,
       COALESCE(t.items_count, 0)                                   AS items_count,
       COALESCE(t.quantity_total, 0)                                AS quantity_total,
       COALESCE(t.total, 0)::NUMERIC(12, 2)                         AS total,
       COALESCE(ca.proposed_down_payment, t.legacy_down_payment, 0)::NUMERIC(12, 2) AS proposed_down_payment,
       (COALESCE(t.total, 0)
        - COALESCE(ca.proposed_down_payment, t.legacy_down_payment, 0))::NUMERIC(12, 2) AS financed_amount,
       t.installments_count,
       CASE WHEN t.installments_count IS NOT NULL THEN
           ROUND((COALESCE(t.total, 0)
                  - COALESCE(ca.proposed_down_payment, t.legacy_down_payment, 0))
                 / t.installments_count, 2)
       END::NUMERIC(12, 2)                                          AS proposed_installment,
       COALESCE(t.requires_price_exception, FALSE)                  AS requires_price_exception,
       COALESCE(t.financing_types, '{}')                            AS financing_types,
       -- NUEVAS (008)
       COALESCE(t.requires_installment_exception, FALSE)            AS requires_installment_exception,
       COALESCE(t.requires_price_exception OR t.requires_installment_exception, FALSE) AS requires_exception
FROM credit_applications ca
JOIN branches b ON b.id = ca.branch_id
LEFT JOIN users u ON u.id = ca.created_by
LEFT JOIN LATERAL (
    SELECT COUNT(*)::int                                            AS items_count,
           SUM(i.quantity)::int                                     AS quantity_total,
           SUM(i.proposed_price * i.quantity)                       AS total,
           SUM(i.proposed_down_payment)                             AS legacy_down_payment,
           CASE WHEN COUNT(DISTINCT i.installments_count) = 1
                THEN MIN(i.installments_count) END                  AS installments_count,
           BOOL_OR(i.proposed_price < i.minimum_price_snapshot)     AS requires_price_exception,
           BOOL_OR(i.proposed_installment < i.minimum_installment_snapshot) AS requires_installment_exception,
           ARRAY_AGG(DISTINCT i.financing_type)                     AS financing_types
      FROM credit_application_items i
     WHERE i.credit_application_id = ca.id
) t ON TRUE;

-- =====================================================================
-- FIN 008
-- =====================================================================
