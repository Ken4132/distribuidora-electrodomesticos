-- =====================================================================
-- 019 — COBRANZA, MOROSIDAD Y REESTRUCTURACIÓN (bloque 5)
--
-- Tres cosas, en este orden:
--
--   1. CARTERA y MOROSIDAD: vistas derivadas. No se almacena ni un solo
--      indicador de atraso: todo sale de `due_date` y de los pagos ya
--      aplicados. No hay estados nuevos de crédito ni de cuota.
--   2. REESTRUCTURACIÓN / REGULARIZACIÓN: historial propio, cuotas
--      anteriores conservadas y sustituidas (nunca borradas), nuevo saldo
--      = nuevo total - lo ya pagado.
--   3. El permiso que la autoriza.
--
-- ADITIVA y RE-EJECUTABLE. No borra datos, no reescribe históricos y no
-- cambia el FIFO: las vistas se redefinen añadiendo un filtro que hoy no
-- excluye ninguna fila (ninguna cuota está sustituida todavía).
-- =====================================================================


-- =====================================================================
-- 1. HISTORIAL DE REESTRUCTURACIONES
--
-- Una reestructuración NO crea una segunda deuda: es el MISMO crédito con
-- otras condiciones. Por eso vive colgada de la venta, conserva la foto de
-- lo anterior y nunca se edita ni se borra.
-- =====================================================================
CREATE TABLE IF NOT EXISTS sale_restructurings (
    id                 BIGSERIAL      PRIMARY KEY,
    sale_id            BIGINT         NOT NULL REFERENCES sales (id) ON DELETE RESTRICT,
    -- REESTRUCTURACION: cambio de condiciones antes de que el crédito
    --                   excepcional cumpla 60 días (emergencia).
    -- REGULARIZACION:   crédito excepcional con saldo y más de 60 días
    --                   desde la activación. Es obligatoria en ese caso.
    kind               VARCHAR(20)    NOT NULL
                       CHECK (kind IN ('REESTRUCTURACION', 'REGULARIZACION')),

    -- Situación ANTERIOR, congelada.
    previous_total     NUMERIC(12, 2) NOT NULL CHECK (previous_total >= 0),
    previous_paid      NUMERIC(12, 2) NOT NULL CHECK (previous_paid >= 0),
    previous_balance   NUMERIC(12, 2) NOT NULL CHECK (previous_balance >= 0),
    previous_installments INTEGER     NOT NULL CHECK (previous_installments >= 0),

    -- Condición NUEVA.
    new_total          NUMERIC(12, 2) NOT NULL CHECK (new_total >= 0),
    new_installments   INTEGER        NOT NULL CHECK (new_installments >= 1),
    new_balance        NUMERIC(12, 2) NOT NULL CHECK (new_balance >= 0),
    first_due_date     DATE           NOT NULL,

    reason             TEXT           NOT NULL,
    -- Quién la autorizó. La autorización ES la operación: solo la puede
    -- ejecutar quien tiene `credits.restructure` (Administración/Gerencia).
    approved_by        BIGINT         NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
    approved_at        TIMESTAMPTZ    NOT NULL DEFAULT now(),
    -- Foto completa de las condiciones y cuotas anteriores.
    previous_snapshot  JSONB          NOT NULL DEFAULT '{}'::jsonb,

    -- El saldo nuevo es el total nuevo menos lo ya pagado. Nunca se
    -- "reinicia" la deuda ignorando los pagos anteriores.
    CONSTRAINT restructuring_balance_math CHECK (new_balance = new_total - previous_paid)
);

CREATE INDEX IF NOT EXISTS ix_sale_restructurings_sale
    ON sale_restructurings (sale_id, approved_at DESC);

-- Evidencia: solo inserción. Misma regla y misma función que el crédito,
-- los pagos y los depósitos.
DROP TRIGGER IF EXISTS trg_sale_restructurings_append_only ON sale_restructurings;
CREATE TRIGGER trg_sale_restructurings_append_only
    BEFORE UPDATE OR DELETE ON sale_restructurings
    FOR EACH ROW EXECUTE FUNCTION credit_evidence_is_append_only();

COMMENT ON TABLE sale_restructurings IS
    'Reestructuraciones y regularizaciones de un crédito. NO crean una deuda nueva: conservan el histórico y recalculan el saldo como nuevo total menos lo ya pagado.';


-- =====================================================================
-- 2. CUOTAS SUSTITUIDAS
--
-- Una reestructuración no borra las cuotas anteriores ni sus pagos: las
-- SUSTITUYE. La cuota vieja se queda con su historial y deja de contar
-- como deuda viva; las nuevas se numeran a continuación, de modo que el
-- FIFO sigue funcionando exactamente igual (cuota más antigua primero).
-- =====================================================================
ALTER TABLE installments
    ADD COLUMN IF NOT EXISTS superseded_at TIMESTAMPTZ;

ALTER TABLE installments
    ADD COLUMN IF NOT EXISTS restructuring_id BIGINT REFERENCES sale_restructurings (id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS ix_installments_restructuring
    ON installments (restructuring_id) WHERE restructuring_id IS NOT NULL;

COMMENT ON COLUMN installments.superseded_at IS
    'Momento en que una reestructuración sustituyó esta cuota. La cuota y sus pagos se conservan; deja de contar como deuda viva.';


-- =====================================================================
-- 3. VISTAS BASE, CON EL FILTRO DE SUSTITUCIÓN
--
-- Hoy ninguna cuota está sustituida, así que estas tres vistas devuelven
-- EXACTAMENTE lo mismo que antes. El filtro solo empieza a actuar cuando
-- existe una reestructuración.
-- =====================================================================

-- `is_superseded` se añade AL FINAL: CREATE OR REPLACE VIEW no permite
-- insertar ni reordenar columnas.
CREATE OR REPLACE VIEW v_installments AS
SELECT i.id,
       i.sale_id,
       i.number,
       i.due_date,
       i.amount,
       COALESCE(a.paid, 0)::NUMERIC(12, 2)              AS paid_amount,
       (i.amount - COALESCE(a.paid, 0))::NUMERIC(12, 2) AS balance,
       CASE
           WHEN COALESCE(a.paid, 0) >= i.amount           THEN 'pagada'
           WHEN i.due_date < app_today()                  THEN 'vencida'
           WHEN COALESCE(a.paid, 0) > 0                   THEN 'parcial'
           ELSE 'pendiente'
       END                                              AS status,
       (app_today() - i.due_date)                       AS days_overdue,
       (i.superseded_at IS NOT NULL)                    AS is_superseded,
       i.restructuring_id
FROM installments i
LEFT JOIN (
    SELECT pa.installment_id, SUM(pa.amount) AS paid
    FROM payment_allocations pa
    JOIN payments p ON p.id = pa.payment_id AND p.status = 'aplicado'
    GROUP BY pa.installment_id
) a ON a.installment_id = i.id;

-- v_sales: idéntica, salvo que el resumen de cuotas ignora las sustituidas.
CREATE OR REPLACE VIEW v_sales AS
SELECT s.id,
       'V-' || LPAD(s.id::text, 6, '0')                    AS sale_number,
       s.customer_id,
       c.full_name                                         AS customer_name,
       c.dpi                                               AS customer_dpi,
       c.phone                                             AS customer_phone,
       s.sale_date,
       s.payment_mode,
       s.installments_count,
       s.subtotal,
       s.total,
       s.status,
       s.notes,
       s.created_at,
       COALESCE(pg.paid, 0)::NUMERIC(12, 2)                AS paid_amount,
       (s.total - COALESCE(pg.paid, 0))::NUMERIC(12, 2)    AS balance,
       COALESCE(iv.paid_count, 0)                          AS installments_paid,
       COALESCE(iv.pending_count, 0)                       AS installments_pending,
       COALESCE(iv.overdue_count, 0)                       AS installments_overdue,
       iv.next_due_date,
       iv.next_due_amount,
       CASE
           WHEN s.status = 'anulada'                       THEN 'anulada'
           WHEN COALESCE(pg.paid, 0) >= s.total            THEN 'pagada'
           WHEN COALESCE(iv.overdue_count, 0) > 0          THEN 'vencida'
           WHEN COALESCE(pg.paid, 0) > 0                   THEN 'al_dia'
           ELSE 'pendiente'
       END                                                 AS account_status,
       s.created_by,
       u.username                                          AS created_by_username
FROM sales s
JOIN customers c ON c.id = s.customer_id
LEFT JOIN users u ON u.id = s.created_by
LEFT JOIN (
    SELECT sale_id, SUM(amount) AS paid
    FROM payments
    WHERE status = 'aplicado'
    GROUP BY sale_id
) pg ON pg.sale_id = s.id
LEFT JOIN (
    SELECT sale_id,
           COUNT(*) FILTER (WHERE status = 'pagada')                       AS paid_count,
           COUNT(*) FILTER (WHERE status <> 'pagada')                      AS pending_count,
           COUNT(*) FILTER (WHERE status = 'vencida')                      AS overdue_count,
           MIN(due_date) FILTER (WHERE status <> 'pagada')                 AS next_due_date,
           MIN(balance)  FILTER (WHERE status <> 'pagada')                 AS next_due_amount
    FROM v_installments
    WHERE NOT is_superseded
    GROUP BY sale_id
) iv ON iv.sale_id = s.id;

-- Los avisos de cobranza tampoco deben hablar de una cuota sustituida.
CREATE OR REPLACE VIEW v_installment_alerts AS
SELECT vi.id                                        AS installment_id,
       vi.sale_id,
       'V-' || LPAD(vi.sale_id::text, 6, '0')       AS sale_number,
       vi.number                                    AS installment_number,
       s.installments_count,
       vi.due_date,
       vi.amount,
       vi.paid_amount,
       vi.balance,
       vi.status,
       (vi.due_date - app_today())                  AS days_to_due,
       GREATEST(app_today() - vi.due_date, 0)       AS days_overdue,
       c.id                                         AS customer_id,
       c.full_name                                  AS customer_name,
       c.dpi                                        AS customer_dpi,
       c.phone                                      AS customer_phone,
       c.email                                      AS customer_email
FROM v_installments vi
JOIN sales s     ON s.id = vi.sale_id
JOIN customers c ON c.id = s.customer_id
WHERE s.status = 'activa'
  AND vi.balance > 0
  AND NOT vi.is_superseded;


-- =====================================================================
-- 4. CARTERA Y MOROSIDAD  (todo derivado, nada almacenado)
--
-- La clasificación de mora es la habitual de cartera:
--
--     AL_DIA   sin cuotas vencidas
--     1_30     hasta 30 días de atraso
--     31_60
--     61_90
--     MAS_90
--
-- Se calcula sobre la cuota vencida MÁS ANTIGUA con saldo, que es la que
-- manda en una cartera con FIFO estricto.
-- =====================================================================
CREATE OR REPLACE FUNCTION overdue_bucket(days INTEGER) RETURNS VARCHAR
    LANGUAGE sql IMMUTABLE
AS $$
    SELECT CASE
        WHEN days IS NULL OR days <= 0 THEN 'AL_DIA'
        WHEN days <= 30                THEN '1_30'
        WHEN days <= 60                THEN '31_60'
        WHEN days <= 90                THEN '61_90'
        ELSE                                'MAS_90'
    END;
$$;

COMMENT ON FUNCTION overdue_bucket(INTEGER) IS
    'Tramo de morosidad a partir de los días de atraso. Derivado: no se almacena.';

-- Cuota a cuota, con todo lo que la pantalla de cobranza necesita.
CREATE OR REPLACE VIEW v_collections_installments AS
SELECT vi.id                                        AS installment_id,
       vi.sale_id,
       'V-' || LPAD(vi.sale_id::text, 6, '0')       AS sale_number,
       vi.number                                    AS installment_number,
       vi.due_date,
       vi.amount,
       vi.paid_amount,
       vi.balance,
       vi.status,
       GREATEST(vi.days_overdue, 0)                 AS days_overdue,
       (vi.due_date - app_today())                  AS days_to_due,
       overdue_bucket(
           CASE WHEN vi.balance > 0 THEN GREATEST(vi.days_overdue, 0) ELSE 0 END
       )                                            AS overdue_bucket,
       vi.restructuring_id,
       s.customer_id,
       c.full_name                                  AS customer_name,
       c.dpi                                        AS customer_dpi,
       c.phone                                      AS customer_phone,
       c.email                                      AS customer_email,
       s.branch_id,
       b.code                                       AS branch_code,
       b.name                                       AS branch_name,
       s.payment_mode,
       s.created_by,
       u.username                                   AS created_by_username,
       s.status                                     AS sale_status
  FROM v_installments vi
  JOIN sales s     ON s.id = vi.sale_id
  JOIN customers c ON c.id = s.customer_id
  LEFT JOIN branches b ON b.id = s.branch_id
  LEFT JOIN users u    ON u.id = s.created_by
 WHERE NOT vi.is_superseded;

-- Crédito a crédito: la cartera propiamente dicha.
CREATE OR REPLACE VIEW v_collections_portfolio AS
SELECT vs.id                                        AS sale_id,
       vs.sale_number,
       vs.customer_id,
       vs.customer_name,
       vs.customer_dpi,
       vs.customer_phone,
       vs.sale_date,
       vs.payment_mode,
       vs.installments_count,
       vs.total,
       vs.paid_amount,
       vs.balance,
       vs.installments_paid,
       vs.installments_pending,
       vs.installments_overdue,
       vs.next_due_date,
       vs.next_due_amount,
       vs.account_status,
       vs.created_by,
       vs.created_by_username,
       s.branch_id,
       b.code                                       AS branch_code,
       b.name                                       AS branch_name,
       ov.oldest_due_date,
       COALESCE(ov.days_overdue, 0)                 AS days_overdue,
       COALESCE(ov.overdue_balance, 0)::NUMERIC(12, 2) AS overdue_balance,
       overdue_bucket(ov.days_overdue)              AS overdue_bucket,
       COALESCE(rs.restructurings, 0)               AS restructurings
  FROM v_sales vs
  JOIN sales s ON s.id = vs.id
  LEFT JOIN branches b ON b.id = s.branch_id
  LEFT JOIN LATERAL (
      SELECT MIN(vi.due_date)                                   AS oldest_due_date,
             MAX(app_today() - vi.due_date)                     AS days_overdue,
             SUM(vi.balance)                                    AS overdue_balance
        FROM v_installments vi
       WHERE vi.sale_id = vs.id
         AND NOT vi.is_superseded
         AND vi.balance > 0
         AND vi.due_date < app_today()
  ) ov ON TRUE
  LEFT JOIN LATERAL (
      SELECT COUNT(*)::int AS restructurings
        FROM sale_restructurings sr WHERE sr.sale_id = vs.id
  ) rs ON TRUE
 WHERE vs.status = 'activa';

COMMENT ON VIEW v_collections_portfolio IS
    'Cartera viva: un crédito por fila, con saldo, atraso y tramo de morosidad. Todo derivado de due_date y de los pagos aplicados.';


-- =====================================================================
-- 5. PERMISO
--
-- No se crea ningún rol ni se cambia ningún permiso existente. La consulta
-- de cartera sigue usando el par `receivables.view` / `receivables.view.own`
-- del bloque 1. Lo único nuevo es quién puede reestructurar.
-- =====================================================================
INSERT INTO permissions (code, module, name, description) VALUES
    ('credits.restructure', 'creditos', 'Reestructurar o regularizar un crédito',
     'Cambia las condiciones de un crédito vivo conservando pagos e historial. Exclusivo de Administración y Gerencia.')
ON CONFLICT (code) DO UPDATE
    SET module = EXCLUDED.module, name = EXCLUDED.name, description = EXCLUDED.description;

INSERT INTO role_permissions (role_code, permission_code)
SELECT 'admin', code FROM permissions
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_code, permission_code)
SELECT r.code, p.code
  FROM (VALUES ('gerencia', 'credits.restructure')) AS v(role_code, permission_code)
  JOIN roles r ON r.code = v.role_code
  JOIN permissions p ON p.code = v.permission_code
ON CONFLICT DO NOTHING;

DELETE FROM role_permissions
 WHERE permission_code = 'credits.restructure'
   AND role_code NOT IN ('admin', 'gerencia');


-- =====================================================================
-- FIN 019
-- =====================================================================
