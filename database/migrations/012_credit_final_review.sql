-- =====================================================================
-- 012_credit_final_review.sql
-- CORRECCIÓN FINAL DEL BLOQUE 3.2 / 3.3 (decisiones del propietario,
-- 2026-09-17). Ver docs/REGLAS-DE-NEGOCIO.md §10, §11 y §12.
--
--   1. Última revisión de Administración/Gerencia (`requires_final_review`)
--      cuando quien modifica una solicitud APROBADA es el vendedor.
--   2. Líneas retiradas con `is_void` (nunca DELETE físico) y líneas nuevas.
--   3. Permisos adicionales POR USUARIO (`user_permissions`), sin roles nuevos.
--   4. Gerencia consulta y anula ventas.
--   5. Estado `VENTA_ANULADA` de la solicitud y registro de la anulación.
--
-- SOLO ADITIVA Y RE-EJECUTABLE:
--   * ninguna fila existente se borra, se reescribe ni se reinterpreta;
--   * las restricciones sobre columnas existentes solo AMPLÍAN lo permitido;
--   * las columnas nuevas nacen con el valor que corresponde a lo ya guardado
--     (`requires_final_review = FALSE`, `is_void = FALSE`);
--   * los historiales nuevos empiezan vacíos: no se inventa historia anterior.
-- =====================================================================


-- =====================================================================
-- 1. ÚLTIMA REVISIÓN DE ADMINISTRACIÓN / GERENCIA
--
-- No se crea el estado APROBADO_CON_CAMBIOS: la solicitud sigue siendo
-- APROBADO y conserva su única decisión. La bandera es lo que impide
-- concretar mientras la revisión esté pendiente.
-- =====================================================================
ALTER TABLE credit_applications
    ADD COLUMN IF NOT EXISTS requires_final_review BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE credit_applications
    ADD COLUMN IF NOT EXISTS final_review_requested_at TIMESTAMPTZ;
ALTER TABLE credit_applications
    ADD COLUMN IF NOT EXISTS final_review_requested_by BIGINT
        REFERENCES users (id) ON DELETE RESTRICT;

COMMENT ON COLUMN credit_applications.requires_final_review IS
    'TRUE cuando el vendedor modificó las condiciones DESPUÉS de la aprobación: la aprobación anterior ya no basta para concretar. Solo Administración o Gerencia la retiran con una última revisión. Una modificación de Administración o Gerencia NO la enciende.';

-- Historial de revisiones finales: evidencia, solo inserción.
CREATE TABLE IF NOT EXISTS credit_final_reviews (
    id                    BIGSERIAL   PRIMARY KEY,
    credit_application_id INTEGER     NOT NULL REFERENCES credit_applications (id) ON DELETE RESTRICT,
    result                VARCHAR(20) NOT NULL CHECK (result IN ('CONFIRMADO', 'RECHAZADO')),
    reviewed_by           BIGINT      NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
    reviewed_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Quién dejó la solicitud pendiente de revisión y cuándo.
    triggered_by          BIGINT      REFERENCES users (id) ON DELETE RESTRICT,
    triggered_at          TIMESTAMPTZ,
    comment               TEXT
);

CREATE INDEX IF NOT EXISTS ix_credit_final_reviews_application
    ON credit_final_reviews (credit_application_id, reviewed_at, id);


-- =====================================================================
-- 2. LÍNEAS: RETIRO LÓGICO (`is_void`), NUNCA DELETE FÍSICO
-- =====================================================================
ALTER TABLE credit_application_items
    ADD COLUMN IF NOT EXISTS is_void BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE credit_application_items
    ADD COLUMN IF NOT EXISTS voided_at TIMESTAMPTZ;
ALTER TABLE credit_application_items
    ADD COLUMN IF NOT EXISTS voided_by BIGINT REFERENCES users (id) ON DELETE RESTRICT;

COMMENT ON COLUMN credit_application_items.is_void IS
    'Línea retirada de la solicitud. La fila se conserva íntegra para la trazabilidad; deja de contar en totales, mínimos, cuotas y excepciones.';

-- Una solicitud no puede quedarse sin ninguna línea vigente.
CREATE OR REPLACE FUNCTION credit_application_items_guard() RETURNS trigger
    LANGUAGE plpgsql
AS $$
DECLARE
    v_application bigint;
    v_status      text;
    v_alive       integer;
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'Las líneas de una solicitud no se eliminan: se retiran con is_void'
            USING ERRCODE = 'restrict_violation';
    END IF;

    -- En UPDATE vale la solicitud de destino; en INSERT, la de la línea nueva.
    v_application := COALESCE(NEW.credit_application_id, OLD.credit_application_id);
    SELECT status INTO v_status FROM credit_applications WHERE id = v_application;

    IF v_status IS NOT NULL
       AND v_status NOT IN ('SOLICITADO', 'EN_VERIFICACION', 'EN_EVALUACION', 'APROBADO') THEN
        RAISE EXCEPTION 'Las condiciones de una solicitud en estado % ya no se pueden modificar', v_status
            USING ERRCODE = 'restrict_violation';
    END IF;

    -- Una línea que ya fue retirada no vuelve atrás ni se edita.
    IF TG_OP = 'UPDATE' AND OLD.is_void AND NEW.is_void IS NOT DISTINCT FROM OLD.is_void THEN
        RAISE EXCEPTION 'Una línea retirada no se modifica'
            USING ERRCODE = 'restrict_violation';
    END IF;
    IF TG_OP = 'UPDATE' AND OLD.is_void AND NOT NEW.is_void THEN
        RAISE EXCEPTION 'Una línea retirada no se reactiva: agrega una línea nueva'
            USING ERRCODE = 'restrict_violation';
    END IF;

    -- Retirar la última línea vigente dejaría una solicitud sin contenido.
    IF TG_OP = 'UPDATE' AND NEW.is_void AND NOT OLD.is_void THEN
        SELECT COUNT(*) INTO v_alive
          FROM credit_application_items
         WHERE credit_application_id = v_application AND NOT is_void AND id <> OLD.id;
        IF v_alive = 0 THEN
            RAISE EXCEPTION 'La solicitud debe conservar al menos una línea vigente'
                USING ERRCODE = 'restrict_violation';
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_credit_application_items_guard ON credit_application_items;
CREATE TRIGGER trg_credit_application_items_guard
    BEFORE INSERT OR UPDATE OR DELETE ON credit_application_items
    FOR EACH ROW EXECUTE FUNCTION credit_application_items_guard();


-- =====================================================================
-- 3. PERMISOS ADICIONALES POR USUARIO
--
-- El rol sigue siendo la base. Esta tabla concede (GRANT) o retira (REVOKE)
-- permisos a UN usuario concreto, sin crear roles nuevos.
-- Permiso efectivo = permisos del rol + GRANT del usuario - REVOKE del usuario.
-- =====================================================================
CREATE TABLE IF NOT EXISTS user_permissions (
    user_id         BIGINT      NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    permission_code VARCHAR(60) NOT NULL REFERENCES permissions (code) ON DELETE CASCADE ON UPDATE CASCADE,
    effect          VARCHAR(10) NOT NULL DEFAULT 'GRANT' CHECK (effect IN ('GRANT', 'REVOKE')),
    granted_by      BIGINT      REFERENCES users (id) ON DELETE RESTRICT,
    granted_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    reason          TEXT,
    PRIMARY KEY (user_id, permission_code)
);

CREATE INDEX IF NOT EXISTS ix_user_permissions_user ON user_permissions (user_id);

-- Historial de concesiones y retiros: evidencia, solo inserción.
CREATE TABLE IF NOT EXISTS user_permission_changes (
    id              BIGSERIAL   PRIMARY KEY,
    user_id         BIGINT      NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
    permission_code VARCHAR(60) NOT NULL,
    action          VARCHAR(20) NOT NULL CHECK (action IN ('CONCEDIDO', 'REVOCADO', 'RETIRADO')),
    effect          VARCHAR(10),
    changed_by      BIGINT      NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
    changed_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    reason          TEXT
);

CREATE INDEX IF NOT EXISTS ix_user_permission_changes_user
    ON user_permission_changes (user_id, changed_at, id);

COMMENT ON TABLE user_permissions IS
    'Permisos adicionales o retirados a un usuario concreto, además de los de su rol. Ejemplo: un Cobrador con capacidades de Vendedor. No sustituye al rol ni crea roles nuevos.';

-- Permiso efectivo de cada usuario, ya resuelto.
CREATE OR REPLACE VIEW v_user_effective_permissions AS
SELECT u.id                                   AS user_id,
       u.username,
       u.role,
       p.code                                 AS permission_code,
       (rp.permission_code IS NOT NULL)       AS from_role,
       up.effect                              AS user_effect
  FROM users u
  CROSS JOIN permissions p
  LEFT JOIN role_permissions rp
         ON rp.role_code = u.role AND rp.permission_code = p.code
  LEFT JOIN user_permissions up
         ON up.user_id = u.id AND up.permission_code = p.code
 WHERE (rp.permission_code IS NOT NULL OR up.effect = 'GRANT')
   AND COALESCE(up.effect, '') <> 'REVOKE';


-- =====================================================================
-- 4. GERENCIA: CONSULTA Y ANULACIÓN DE VENTAS
--
-- Gerencia ya decidía y concretaba créditos, pero no podía ver la venta
-- resultante ni anularla. Se le dan EXACTAMENTE esos dos permisos:
--
--   * `sales.view`   consultar ventas (supervisión, revisión, concreción,
--                    anulación y auditoría). `GET /sales/:id` ya trae las
--                    cuotas y los pagos de la venta, así que no hace falta
--                    abrirle el módulo de pagos.
--   * `sales.cancel` anular una venta (con motivo).
--
-- NO recibe cobranza (`receivables.*`) ni el módulo de pagos: PE2 mantiene a
-- Gerencia como perfil de supervisión. La anulación de PAGOS sigue siendo
-- exclusiva de Administración (decisión del propietario sobre pagos).
-- =====================================================================
INSERT INTO role_permissions (role_code, permission_code)
SELECT 'gerencia', code FROM permissions WHERE code IN (
    'sales.view',
    'sales.cancel'
)
ON CONFLICT DO NOTHING;


-- =====================================================================
-- 5. ANULACIÓN DE VENTA
-- =====================================================================
ALTER TABLE sales ADD COLUMN IF NOT EXISTS cancelled_by BIGINT
    REFERENCES users (id) ON DELETE RESTRICT;

-- Expediente de la anulación: impacto económico y stock restituido.
CREATE TABLE IF NOT EXISTS sale_cancellations (
    id                     BIGSERIAL      PRIMARY KEY,
    sale_id                BIGINT         NOT NULL UNIQUE REFERENCES sales (id) ON DELETE RESTRICT,
    credit_application_id  INTEGER        REFERENCES credit_applications (id) ON DELETE RESTRICT,
    reason                 TEXT           NOT NULL CHECK (length(btrim(reason)) > 0),
    cancelled_by           BIGINT         NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
    cancelled_at           TIMESTAMPTZ    NOT NULL DEFAULT now(),
    sale_total             NUMERIC(12, 2) NOT NULL,
    payments_voided_count  INTEGER        NOT NULL DEFAULT 0,
    payments_voided_amount NUMERIC(12, 2) NOT NULL DEFAULT 0,
    down_payment_reverted  NUMERIC(12, 2) NOT NULL DEFAULT 0,
    stock_restored         JSONB          NOT NULL DEFAULT '[]'::jsonb
);

CREATE INDEX IF NOT EXISTS ix_sale_cancellations_application
    ON sale_cancellations (credit_application_id);

-- La solicitud cuya venta se anuló sale de la cartera activa y conserva todo
-- su historial. No se reutiliza para otra venta: el estado es terminal.
ALTER TABLE credit_applications DROP CONSTRAINT IF EXISTS credit_applications_status_check;
ALTER TABLE credit_applications
    ADD CONSTRAINT credit_applications_status_check
    CHECK (status IN (
        'SOLICITADO', 'EN_VERIFICACION', 'EN_EVALUACION', 'APROBADO',
        'VENTA_CONCRETADA', 'ACTIVO', 'RECHAZADO', 'CANCELADO',
        'VENTA_ANULADA'
    ));

ALTER TABLE credit_applications ADD COLUMN IF NOT EXISTS sale_cancelled_at TIMESTAMPTZ;

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
        WHEN 'VENTA_CONCRETADA' THEN NEW.status IN ('ACTIVO', 'VENTA_ANULADA')
        WHEN 'ACTIVO'           THEN NEW.status = 'VENTA_ANULADA'
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


-- =====================================================================
-- 6. TODA VENTA DE CRÉDITO NUEVA NACE DE UNA SOLICITUD APROBADA Y REVISADA
--
-- Red de seguridad en la base: no depende de que el servicio o el frontend
-- se comporten bien. Solo afecta a INSERT nuevos; nada histórico se revalida.
-- =====================================================================
CREATE OR REPLACE FUNCTION sales_guard_credit_origin() RETURNS trigger
    LANGUAGE plpgsql
AS $$
DECLARE
    v_status text;
    v_review boolean;
BEGIN
    IF NEW.credit_application_id IS NULL THEN
        IF NEW.payment_mode = 'credito' THEN
            RAISE EXCEPTION 'Una venta a crédito debe originarse en una solicitud aprobada'
                USING ERRCODE = 'restrict_violation';
        END IF;
        RETURN NEW;
    END IF;

    SELECT status, requires_final_review INTO v_status, v_review
      FROM credit_applications WHERE id = NEW.credit_application_id;

    IF v_status IS DISTINCT FROM 'APROBADO' THEN
        RAISE EXCEPTION 'Solo se concreta la venta de una solicitud APROBADA (estado actual: %)', COALESCE(v_status, 'inexistente')
            USING ERRCODE = 'restrict_violation';
    END IF;
    IF v_review THEN
        RAISE EXCEPTION 'La solicitud tiene una modificación pendiente de la última revisión de Administración o Gerencia'
            USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sales_credit_origin ON sales;
CREATE TRIGGER trg_sales_credit_origin
    BEFORE INSERT ON sales
    FOR EACH ROW EXECUTE FUNCTION sales_guard_credit_origin();


-- =====================================================================
-- 7. EVIDENCIA DE SOLO INSERCIÓN (se suman las tablas nuevas)
-- =====================================================================
DO $$
DECLARE
    t text;
BEGIN
    FOREACH t IN ARRAY ARRAY[
        'credit_verifications', 'credit_decisions', 'credit_decision_exceptions',
        'credit_application_status_history', 'credit_application_changes', 'customer_confirmations',
        'credit_final_reviews', 'user_permission_changes', 'sale_cancellations'
    ] LOOP
        EXECUTE format('DROP TRIGGER IF EXISTS trg_%s_append_only ON %I', t, t);
        EXECUTE format(
            'CREATE TRIGGER trg_%s_append_only BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION credit_evidence_is_append_only()',
            t, t
        );
    END LOOP;
END $$;


-- =====================================================================
-- 8. VISTAS
-- =====================================================================

-- Las líneas retiradas siguen visibles en el expediente (`is_void` al final),
-- pero dejan de sumar en los totales de la solicitud.
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
       (i.proposed_price < i.minimum_price_snapshot
        AND NOT i.is_void)                                         AS requires_price_exception,
       i.created_at,
       i.configured_minimum_price_snapshot                         AS configured_minimum_unit_price,
       i.configured_minimum_installment_snapshot                   AS configured_minimum_unit_installment,
       (i.proposed_installment < i.minimum_installment_snapshot
        AND NOT i.is_void)                                         AS requires_installment_exception,
       ((i.proposed_price < i.minimum_price_snapshot
         OR i.proposed_installment < i.minimum_installment_snapshot)
        AND NOT i.is_void)                                         AS requires_exception,
       -- NUEVAS (012)
       i.is_void,
       i.voided_at,
       i.voided_by
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
       COALESCE(t.requires_installment_exception, FALSE)            AS requires_installment_exception,
       COALESCE(t.requires_price_exception OR t.requires_installment_exception, FALSE) AS requires_exception,
       ca.credit_type,
       -- NUEVAS (012)
       ca.requires_final_review,
       ca.final_review_requested_at,
       ca.sale_cancelled_at,
       COALESCE(t.voided_items_count, 0)                            AS voided_items_count
FROM credit_applications ca
JOIN branches b ON b.id = ca.branch_id
LEFT JOIN users u ON u.id = ca.created_by
LEFT JOIN LATERAL (
    SELECT (COUNT(*) FILTER (WHERE NOT i.is_void))::int              AS items_count,
           (COUNT(*) FILTER (WHERE i.is_void))::int                  AS voided_items_count,
           (SUM(i.quantity) FILTER (WHERE NOT i.is_void))::int      AS quantity_total,
           SUM(i.proposed_price * i.quantity) FILTER (WHERE NOT i.is_void) AS total,
           SUM(i.proposed_down_payment) FILTER (WHERE NOT i.is_void)       AS legacy_down_payment,
           CASE WHEN (COUNT(DISTINCT i.installments_count) FILTER (WHERE NOT i.is_void)) = 1
                THEN (MIN(i.installments_count) FILTER (WHERE NOT i.is_void)) END AS installments_count,
           BOOL_OR(i.proposed_price < i.minimum_price_snapshot) FILTER (WHERE NOT i.is_void) AS requires_price_exception,
           BOOL_OR(i.proposed_installment < i.minimum_installment_snapshot) FILTER (WHERE NOT i.is_void) AS requires_installment_exception,
           ARRAY_AGG(DISTINCT i.financing_type) FILTER (WHERE NOT i.is_void) AS financing_types
      FROM credit_application_items i
     WHERE i.credit_application_id = ca.id
) t ON TRUE;

-- Regularización del crédito excepcional: una venta anulada queda fuera.
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
   AND ca.status = 'ACTIVO'
   AND vs.status = 'activa';


-- =====================================================================
-- 9. PERMISOS NUEVOS
-- =====================================================================
INSERT INTO permissions (code, module, name, description) VALUES
    ('credits.review.final', 'creditos', 'Última revisión de una solicitud aprobada y modificada',
     'Confirma o rechaza las condiciones que el vendedor cambió después de la aprobación. Exclusivo de Administración y Gerencia.'),
    ('credits.modify.own',   'creditos', 'Modificar las condiciones de las solicitudes propias',
     'El vendedor creador ajusta precio, plazo, enganche, productos y cantidades. Si la solicitud ya estaba aprobada, queda pendiente de la última revisión de Administración o Gerencia.'),
    ('users.permissions',    'seguridad', 'Conceder o retirar permisos a un usuario',
     'Permisos adicionales por usuario, además de los de su rol.')
ON CONFLICT (code) DO UPDATE
    SET module = EXCLUDED.module, name = EXCLUDED.name, description = EXCLUDED.description;

UPDATE permissions
   SET description = 'Aprobar, rechazar y modificar precio, plazo, enganche, productos y cantidades de solicitudes (también aprobadas, antes de concretar la venta). Exclusivo de Administración y Gerencia.'
 WHERE code = 'credits.decide';

-- Administración conserva todos los permisos.
INSERT INTO role_permissions (role_code, permission_code)
SELECT 'admin', code FROM permissions
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_code, permission_code)
SELECT r.code, p.code
  FROM (VALUES
        ('gerencia', 'credits.review.final'),
        ('vendedor', 'credits.modify.own')) AS v(role_code, permission_code)
  JOIN roles r ON r.code = v.role_code
  JOIN permissions p ON p.code = v.permission_code
ON CONFLICT DO NOTHING;

-- Salvaguardas: la revisión final es de Administración y Gerencia; los
-- permisos por usuario los administra solo Administración.
DELETE FROM role_permissions
 WHERE permission_code = 'credits.review.final'
   AND role_code NOT IN ('admin', 'gerencia');

DELETE FROM role_permissions
 WHERE permission_code = 'users.permissions'
   AND role_code <> 'admin';

DELETE FROM role_permissions
 WHERE permission_code = 'credits.modify.own'
   AND role_code NOT IN ('admin', 'vendedor');

-- =====================================================================
-- FIN 012
-- =====================================================================
