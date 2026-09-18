-- =====================================================================
-- 011_credit_post_approval_changes.sql
-- Modificación de condiciones DESPUÉS de la aprobación (decisión del
-- propietario, 2026-09-17; ver docs/REGLAS-DE-NEGOCIO.md CF6).
--
--   * Administración o Gerencia pueden modificar una solicitud APROBADA
--     (antes de concretar la venta). La aprobación se conserva: no vuelve a
--     EN_EVALUACION ni requiere otra decisión.
--   * Cada cambio queda en credit_application_changes (ya existente).
--   * Si la modificación deja una línea bajo el mínimo, la autorización con
--     motivo se registra como excepción de ORIGEN 'MODIFICACION', ligada a la
--     decisión existente (no se crea un segundo proceso de aprobación).
--
-- Solo aditiva y re-ejecutable: no modifica ni borra datos.
-- =====================================================================

-- 1. Las líneas pueden actualizarse también en APROBADO.
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
    IF v_status NOT IN ('SOLICITADO', 'EN_VERIFICACION', 'EN_EVALUACION', 'APROBADO') THEN
        RAISE EXCEPTION 'Las condiciones de una solicitud en estado % ya no se pueden modificar', v_status
            USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
END;
$$;

-- 2. Origen de la autorización de excepción.
ALTER TABLE credit_decision_exceptions
    ADD COLUMN IF NOT EXISTS source VARCHAR(20) NOT NULL DEFAULT 'DECISION';

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'credit_decision_exceptions_source_check'
    ) THEN
        ALTER TABLE credit_decision_exceptions
            ADD CONSTRAINT credit_decision_exceptions_source_check
            CHECK (source IN ('DECISION', 'MODIFICACION'));
    END IF;
END $$;

-- En la decisión, una autorización por línea; tras modificaciones puede haber
-- varias (una por cada cambio que deje la línea bajo el mínimo).
ALTER TABLE credit_decision_exceptions DROP CONSTRAINT IF EXISTS ux_credit_decision_exception_item;
CREATE UNIQUE INDEX IF NOT EXISTS ux_credit_decision_exception_item_decision
    ON credit_decision_exceptions (credit_decision_id, credit_application_item_id)
    WHERE source = 'DECISION';
CREATE INDEX IF NOT EXISTS ix_credit_decision_exceptions_item
    ON credit_decision_exceptions (credit_application_item_id, id);

-- 3. Descripción del permiso.
UPDATE permissions
   SET description = 'Aprobar, rechazar y modificar precio, plazo y enganche de solicitudes (también aprobadas, antes de concretar la venta). Exclusivo de Administración y Gerencia.'
 WHERE code = 'credits.decide';
