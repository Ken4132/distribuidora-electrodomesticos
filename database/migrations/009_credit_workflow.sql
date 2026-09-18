-- =====================================================================
-- 009_credit_workflow.sql
-- BLOQUE 3.2: verificación, modificación de condiciones, decisión,
-- cancelación, reconfirmación de cliente y crédito excepcional a contado.
--
-- Decisiones del propietario (2026-09-17): ver docs/REGLAS-DE-NEGOCIO.md §10.
--
-- Solo aditiva. No borra ni reescribe filas existentes:
--   * las restricciones nuevas sobre columnas existentes aceptan todos los
--     valores ya guardados (solo AMPLÍAN lo permitido);
--   * los historiales empiezan vacíos: no se inventa historia anterior;
--   * las solicitudes existentes quedan como NORMAL.
-- =====================================================================


-- =====================================================================
-- 1. SOLICITUD: tipo, conclusión de verificación, cancelación, reconfirmación
-- =====================================================================
ALTER TABLE credit_applications ADD COLUMN IF NOT EXISTS credit_type VARCHAR(30) NOT NULL DEFAULT 'NORMAL';

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'credit_applications_credit_type_check') THEN
        ALTER TABLE credit_applications
            ADD CONSTRAINT credit_applications_credit_type_check
            CHECK (credit_type IN ('NORMAL', 'EXCEPCIONAL_CONTADO'));
    END IF;
END $$;

ALTER TABLE credit_applications ADD COLUMN IF NOT EXISTS verification_concluded_at TIMESTAMPTZ;
ALTER TABLE credit_applications ADD COLUMN IF NOT EXISTS verification_concluded_by BIGINT
    REFERENCES users (id) ON DELETE RESTRICT;
ALTER TABLE credit_applications ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ;
ALTER TABLE credit_applications ADD COLUMN IF NOT EXISTS cancelled_by BIGINT
    REFERENCES users (id) ON DELETE RESTRICT;
ALTER TABLE credit_applications ADD COLUMN IF NOT EXISTS cancel_reason TEXT;

COMMENT ON COLUMN credit_applications.credit_type IS
    'NORMAL: flujo con verificación. EXCEPCIONAL_CONTADO: precio de contado, enganche Q0, un pago al mes siguiente, decisión directa de Administración o Gerencia.';

-- Las líneas del crédito excepcional usan su propio tipo de financiamiento.
ALTER TABLE credit_application_items DROP CONSTRAINT IF EXISTS credit_application_items_financing_type_check;
ALTER TABLE credit_application_items
    ADD CONSTRAINT credit_application_items_financing_type_check
    CHECK (financing_type IN ('PREDEFINIDO', 'ESPECIAL', 'CONTADO_EXCEPCIONAL'));


-- =====================================================================
-- 2. RECONFIRMACIÓN DE DATOS DEL CLIENTE (regla 9 / decisión 8)
--
-- Cada reconfirmación congela la ficha del cliente en ese momento. Un
-- cliente existente (con solicitudes o ventas previas) necesita una
-- reconfirmación posterior a su última operación para iniciar otra solicitud.
-- =====================================================================
CREATE TABLE IF NOT EXISTS customer_confirmations (
    id           BIGSERIAL   PRIMARY KEY,
    customer_id  BIGINT      NOT NULL REFERENCES customers (id) ON DELETE RESTRICT,
    confirmed_by BIGINT      NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
    confirmed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    snapshot     JSONB       NOT NULL,
    changed_fields TEXT[]    NOT NULL DEFAULT '{}',
    notes        TEXT
);

CREATE INDEX IF NOT EXISTS ix_customer_confirmations_customer
    ON customer_confirmations (customer_id, confirmed_at DESC);

ALTER TABLE credit_applications ADD COLUMN IF NOT EXISTS customer_confirmation_id BIGINT
    REFERENCES customer_confirmations (id) ON DELETE RESTRICT;


-- =====================================================================
-- 3. HISTORIALES (solo inserción)
-- =====================================================================
CREATE TABLE IF NOT EXISTS credit_application_status_history (
    id                    BIGSERIAL   PRIMARY KEY,
    credit_application_id INTEGER     NOT NULL REFERENCES credit_applications (id) ON DELETE RESTRICT,
    from_status           VARCHAR(40),
    to_status             VARCHAR(40) NOT NULL,
    changed_by            BIGINT      REFERENCES users (id) ON DELETE RESTRICT,
    changed_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    reason                TEXT
);

CREATE INDEX IF NOT EXISTS ix_credit_status_history_application
    ON credit_application_status_history (credit_application_id, changed_at, id);

-- Modificaciones de condiciones por Administración o Gerencia (decisión 4).
CREATE TABLE IF NOT EXISTS credit_application_changes (
    id                         BIGSERIAL   PRIMARY KEY,
    credit_application_id      INTEGER     NOT NULL REFERENCES credit_applications (id) ON DELETE RESTRICT,
    credit_application_item_id INTEGER     REFERENCES credit_application_items (id) ON DELETE RESTRICT,
    field                      VARCHAR(60) NOT NULL,
    old_value                  TEXT,
    new_value                  TEXT,
    changed_by                 BIGINT      NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
    changed_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
    comment                    TEXT
);

CREATE INDEX IF NOT EXISTS ix_credit_changes_application
    ON credit_application_changes (credit_application_id, changed_at, id);

-- Autorizaciones de excepción por línea dentro de la decisión (decisión 5).
CREATE TABLE IF NOT EXISTS credit_decision_exceptions (
    id                         BIGSERIAL      PRIMARY KEY,
    credit_decision_id         INTEGER        NOT NULL REFERENCES credit_decisions (id) ON DELETE RESTRICT,
    credit_application_item_id INTEGER        NOT NULL REFERENCES credit_application_items (id) ON DELETE RESTRICT,
    exception_kind             VARCHAR(20)    NOT NULL
                               CHECK (exception_kind IN ('PRECIO', 'CUOTA', 'PRECIO_Y_CUOTA')),
    minimum_unit_price         NUMERIC(12, 2) NOT NULL,
    proposed_unit_price        NUMERIC(12, 2) NOT NULL,
    unit_price_difference      NUMERIC(12, 2) NOT NULL,
    minimum_line_installment   NUMERIC(12, 2) NOT NULL,
    proposed_line_installment  NUMERIC(12, 2) NOT NULL,
    reason                     TEXT           NOT NULL CHECK (length(btrim(reason)) > 0),
    authorized_by              BIGINT         NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
    branch_id                  BIGINT         NOT NULL REFERENCES branches (id) ON DELETE RESTRICT,
    created_at                 TIMESTAMPTZ    NOT NULL DEFAULT now(),
    CONSTRAINT ux_credit_decision_exception_item UNIQUE (credit_decision_id, credit_application_item_id)
);

-- Una sola decisión por solicitud: el rechazo es definitivo y la aprobación
-- no se repite. Se crea solo si no hay duplicados previos (no se borra nada).
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM credit_decisions GROUP BY credit_application_id HAVING COUNT(*) > 1
    ) THEN
        CREATE UNIQUE INDEX IF NOT EXISTS ux_credit_decisions_application ON credit_decisions (credit_application_id);
    END IF;
END $$;

-- Verificaciones, decisiones, excepciones, historiales y reconfirmaciones
-- son evidencia: no se modifican ni se eliminan.
CREATE OR REPLACE FUNCTION credit_evidence_is_append_only() RETURNS trigger
    LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'El registro de % es de solo inserción: no se puede %', TG_TABLE_NAME, TG_OP
        USING ERRCODE = 'restrict_violation';
END;
$$;

DO $$
DECLARE
    t text;
BEGIN
    FOREACH t IN ARRAY ARRAY[
        'credit_verifications', 'credit_decisions', 'credit_decision_exceptions',
        'credit_application_status_history', 'credit_application_changes', 'customer_confirmations'
    ] LOOP
        EXECUTE format('DROP TRIGGER IF EXISTS trg_%s_append_only ON %I', t, t);
        EXECUTE format(
            'CREATE TRIGGER trg_%s_append_only BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION credit_evidence_is_append_only()',
            t, t
        );
    END LOOP;
END $$;


-- =====================================================================
-- 4. TRANSICIONES DE ESTADO PERMITIDAS (red de seguridad en BD)
--
--   SOLICITADO      -> EN_VERIFICACION | CANCELADO
--   EN_VERIFICACION -> EN_EVALUACION   | CANCELADO
--   EN_EVALUACION   -> APROBADO | RECHAZADO | CANCELADO
--   APROBADO        -> VENTA_CONCRETADA | CANCELADO
--   VENTA_CONCRETADA-> ACTIVO
--   Crédito EXCEPCIONAL_CONTADO: decisión directa desde SOLICITADO,
--   EN_VERIFICACION o EN_EVALUACION.
-- =====================================================================
CREATE OR REPLACE FUNCTION credit_applications_guard_status() RETURNS trigger
    LANGUAGE plpgsql
AS $$
DECLARE
    v_ok boolean;
BEGIN
    IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
        RETURN NEW;
    END IF;

    v_ok := CASE OLD.status
        WHEN 'SOLICITADO'       THEN NEW.status IN ('EN_VERIFICACION', 'CANCELADO')
        WHEN 'EN_VERIFICACION'  THEN NEW.status IN ('EN_EVALUACION', 'CANCELADO')
        WHEN 'EN_EVALUACION'    THEN NEW.status IN ('APROBADO', 'RECHAZADO', 'CANCELADO')
        WHEN 'APROBADO'         THEN NEW.status IN ('VENTA_CONCRETADA', 'CANCELADO')
        WHEN 'VENTA_CONCRETADA' THEN NEW.status = 'ACTIVO'
        ELSE FALSE
    END;

    IF NOT v_ok AND OLD.credit_type = 'EXCEPCIONAL_CONTADO'
       AND OLD.status IN ('SOLICITADO', 'EN_VERIFICACION')
       AND NEW.status IN ('APROBADO', 'RECHAZADO') THEN
        v_ok := TRUE;
    END IF;

    IF NOT v_ok THEN
        RAISE EXCEPTION 'Transición de estado no permitida: % -> %', OLD.status, NEW.status
            USING ERRCODE = 'check_violation', CONSTRAINT = 'credit_applications_status_transition';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_credit_applications_status ON credit_applications;
CREATE TRIGGER trg_credit_applications_status
    BEFORE UPDATE OF status ON credit_applications
    FOR EACH ROW EXECUTE FUNCTION credit_applications_guard_status();

-- Las líneas solo se modifican antes de la decisión y nunca se eliminan.
CREATE OR REPLACE FUNCTION credit_application_items_guard() RETURNS trigger
    LANGUAGE plpgsql
AS $$
DECLARE
    v_status text;
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'Las líneas de una solicitud no se eliminan'
            USING ERRCODE = 'restrict_violation';
    END IF;
    SELECT status INTO v_status FROM credit_applications WHERE id = OLD.credit_application_id;
    IF v_status NOT IN ('SOLICITADO', 'EN_VERIFICACION', 'EN_EVALUACION') THEN
        RAISE EXCEPTION 'Las condiciones de una solicitud en estado % ya no se pueden modificar', v_status
            USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_credit_application_items_guard ON credit_application_items;
CREATE TRIGGER trg_credit_application_items_guard
    BEFORE UPDATE OR DELETE ON credit_application_items
    FOR EACH ROW EXECUTE FUNCTION credit_application_items_guard();


-- =====================================================================
-- 5. PERMISOS
-- =====================================================================
INSERT INTO permissions (code, module, name, description) VALUES
    ('credits.cancel', 'creditos', 'Cancelar cualquier solicitud de crédito',
     'Antes de la decisión o ya aprobada y sin venta. El vendedor creador cancela las suyas con credits.create.')
ON CONFLICT (code) DO UPDATE
    SET module = EXCLUDED.module, name = EXCLUDED.name, description = EXCLUDED.description;

UPDATE permissions
   SET description = 'Aprobar, rechazar y modificar precio, plazo y enganche de solicitudes. Exclusivo de Administración y Gerencia.'
 WHERE code = 'credits.decide';

INSERT INTO role_permissions (role_code, permission_code)
SELECT 'admin', code FROM permissions
ON CONFLICT DO NOTHING;

DELETE FROM role_permissions
 WHERE permission_code = 'credits.cancel'
   AND role_code <> 'admin';

-- =====================================================================
-- 6. VISTA: tipo de crédito al final (CREATE OR REPLACE solo agrega columnas al final)
-- =====================================================================
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
       COALESCE(t.requires_price_exception OR t.requires_installment_exception, FALSE) AS requires_exception,
       -- NUEVA (009)
       ca.credit_type
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
-- FIN 009
-- =====================================================================
