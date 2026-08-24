-- =====================================================================
-- 002_outbox_dispatcher.sql — Despachador confiable de eventos hacia n8n
--
-- La migración 001 dejó la tabla `integration_events` como bandeja de
-- salida (outbox). Esta migración le agrega lo que le faltaba para ser
-- confiable en producción:
--
--   * idempotencia      -> unique_key
--   * reintentos con espera creciente -> next_attempt_at
--   * trazabilidad por intento        -> integration_event_attempts
--
-- No se borra ni se reescribe nada de lo existente.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Idempotencia.
-- Los eventos que nacen de un barrido programado (una cuota por vencer,
-- una cuota vencida) se podrían generar varias veces si el barrido corre
-- más de una vez al día. `unique_key` lo impide a nivel de base de datos.
-- Los eventos que nacen de una acción del usuario (una venta, un pago)
-- dejan esta columna en NULL: cada acción es un evento distinto.
-- ---------------------------------------------------------------------
ALTER TABLE integration_events
    ADD COLUMN IF NOT EXISTS unique_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS ux_events_unique_key
    ON integration_events (unique_key)
    WHERE unique_key IS NOT NULL;

-- ---------------------------------------------------------------------
-- Reintentos con espera creciente.
-- Sin esta columna el despachador reintentaba de inmediato y agotaba los
-- intentos en segundos cuando n8n estaba caído.
-- ---------------------------------------------------------------------
ALTER TABLE integration_events
    ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now();

ALTER TABLE integration_events
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

-- Momento en que el evento quedó definitivamente descartado.
ALTER TABLE integration_events
    ADD COLUMN IF NOT EXISTS discarded_at TIMESTAMPTZ;

CREATE TRIGGER trg_integration_events_updated
    BEFORE UPDATE ON integration_events
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- El despachador busca por (estado, momento del próximo intento).
DROP INDEX IF EXISTS ix_events_pending;
CREATE INDEX ix_events_dispatchable
    ON integration_events (next_attempt_at, id)
    WHERE status IN ('pendiente', 'fallido');

CREATE INDEX IF NOT EXISTS ix_events_type_created
    ON integration_events (event_type, created_at DESC);

-- ---------------------------------------------------------------------
-- Trazabilidad: un registro por intento de envío.
-- `integration_events.last_error` solo conserva el último error; para
-- diagnosticar una integración hace falta ver la secuencia completa.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS integration_event_attempts (
    id           BIGSERIAL PRIMARY KEY,
    event_id     BIGINT      NOT NULL REFERENCES integration_events (id) ON DELETE CASCADE,
    attempt_no   INTEGER     NOT NULL CHECK (attempt_no >= 1),
    started_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    duration_ms  INTEGER,
    http_status  INTEGER,
    ok           BOOLEAN     NOT NULL DEFAULT FALSE,
    error        TEXT,
    -- Respuesta del webhook, recortada: sirve para depurar sin llenar la BD.
    response_excerpt TEXT,

    CONSTRAINT ux_event_attempt UNIQUE (event_id, attempt_no)
);

CREATE INDEX IF NOT EXISTS ix_event_attempts_event
    ON integration_event_attempts (event_id, attempt_no);

-- ---------------------------------------------------------------------
-- Vista de apoyo: cuotas candidatas a generar eventos de cobranza.
-- Solo cuotas con saldo, de ventas activas, con los datos que n8n
-- necesita para notificar (nombre y teléfono del cliente).
-- ---------------------------------------------------------------------
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
  AND vi.balance > 0;
