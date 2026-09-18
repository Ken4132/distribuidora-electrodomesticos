-- =====================================================================
-- 013_payments_foundation.sql
-- BLOQUE 4.0 — FUNDACIÓN DEL SISTEMA DE PAGOS
--
-- Esta migración NO implementa pagos: el registro FIFO, la anulación y la
-- cartera ya existen desde el bloque 1 y se CONSERVAN tal cual. Lo que hace
-- es poner la base que le falta al módulo para el bloque 4:
--
--   1. Guardas de integridad sobre lo que ya existe (el historial de pagos
--      es inmutable, la fecha real tiene límites, la anulación tiene orden).
--   2. Estado DOCUMENTAL del comprobante, separado del estado económico.
--   3. Depósitos: agrupan pagos, con su conciliación y su historial.
--   4. Recibo inmutable, preparado y vacío (lo llena el bloque 4.2/4.3).
--   5. Los índices que esas consultas van a necesitar.
--
-- QUÉ NO HACE (a propósito):
--   * no crea permisos ni endpoints de depósitos: eso es el bloque 4.2;
--   * no toca n8n, WhatsApp ni genera recibos;
--   * no recalcula, reinterpreta ni reescribe NINGÚN pago, venta o crédito
--     existente. Todas las guardas nuevas actúan solo sobre filas NUEVAS.
--
-- SOLO ADITIVA Y RE-EJECUTABLE:
--   * las tablas y columnas nuevas usan IF NOT EXISTS;
--   * las guardas se aplican a operaciones futuras, no revalidan lo guardado;
--   * `payments.voucher_status` nace NULL en los pagos históricos: NULL
--     significa "anterior al control documental", no "le falta la boleta".
-- =====================================================================


-- =====================================================================
-- 1. EL HISTORIAL DE PAGOS ES INMUTABLE
--
-- Regla D1/D2: un pago no se borra nunca; se anula. Hasta ahora eso vivía
-- solo en el servicio. `payment_allocations` además tenía ON DELETE CASCADE
-- desde `payments`, así que un DELETE habría arrastrado en silencio la
-- distribución FIFO, que es justo la prueba de a qué cuota fue cada quetzal.
-- =====================================================================
CREATE OR REPLACE FUNCTION payments_are_never_deleted() RETURNS trigger
    LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'Un pago no se elimina: se anula (status = ''anulado'') conservando su historial'
        USING ERRCODE = 'restrict_violation';
END;
$$;

DROP TRIGGER IF EXISTS trg_payments_no_delete ON payments;
CREATE TRIGGER trg_payments_no_delete
    BEFORE DELETE ON payments
    FOR EACH ROW EXECUTE FUNCTION payments_are_never_deleted();

CREATE OR REPLACE FUNCTION payment_allocations_are_immutable() RETURNS trigger
    LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'La distribución de un pago a sus cuotas no se modifica ni se elimina: es la trazabilidad del FIFO'
        USING ERRCODE = 'restrict_violation';
END;
$$;

DROP TRIGGER IF EXISTS trg_payment_allocations_immutable ON payment_allocations;
CREATE TRIGGER trg_payment_allocations_immutable
    BEFORE UPDATE OR DELETE ON payment_allocations
    FOR EACH ROW EXECUTE FUNCTION payment_allocations_are_immutable();


-- =====================================================================
-- 2. FECHA ECONÓMICA DEL PAGO
--
-- `payment_date` es la fecha REAL en que el cliente pagó y `created_at` la
-- fecha en que se registró en el sistema: son dos cosas distintas y las dos
-- se conservan (regla A10/A12).
--
--   * no puede ser futura (A9);
--   * no puede ser anterior a la fecha de la venta (A11).
--
-- Se comprueba en un trigger BEFORE INSERT y no en un CHECK porque depende
-- de otra tabla (`sales.sale_date`) y de la fecha operativa de Guatemala.
-- Solo mira filas NUEVAS: ningún pago histórico se revalida ni se corrige.
-- =====================================================================
CREATE OR REPLACE FUNCTION payments_guard_date() RETURNS trigger
    LANGUAGE plpgsql
AS $$
DECLARE
    v_sale_date date;
BEGIN
    IF NEW.payment_date > app_today() THEN
        RAISE EXCEPTION 'La fecha del pago (%) no puede ser futura', NEW.payment_date
            USING ERRCODE = 'check_violation', CONSTRAINT = 'payments_date_not_future';
    END IF;

    SELECT sale_date INTO v_sale_date FROM sales WHERE id = NEW.sale_id;
    IF v_sale_date IS NOT NULL AND NEW.payment_date < v_sale_date THEN
        RAISE EXCEPTION 'La fecha del pago (%) no puede ser anterior a la fecha de la venta (%)',
            NEW.payment_date, v_sale_date
            USING ERRCODE = 'check_violation', CONSTRAINT = 'payments_date_after_sale';
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_payments_guard_date ON payments;
CREATE TRIGGER trg_payments_guard_date
    BEFORE INSERT ON payments
    FOR EACH ROW EXECUTE FUNCTION payments_guard_date();


-- =====================================================================
-- 3. LA ANULACIÓN SIGUE EL ORDEN INVERSO AL DE APLICACIÓN
--
-- Decisión del propietario (bloque 4): solo se anula el ÚLTIMO pago aplicado
-- de la venta. El motivo es el FIFO: las cuotas se fueron llenando en el
-- orden en que entraron los pagos, así que anular uno intermedio dejaría una
-- distribución que ya no corresponde a ningún recorrido posible. Para anular
-- uno anterior hay que anular antes los posteriores, y cada anulación queda
-- registrada.
--
-- "Último" = el de mayor `id` entre los aplicados de esa venta, que es el
-- orden real de aplicación (no `payment_date`, que puede venir con fecha
-- atrasada precisamente porque es la fecha económica y no la de registro).
-- =====================================================================
CREATE OR REPLACE FUNCTION payments_guard_void_order() RETURNS trigger
    LANGUAGE plpgsql
AS $$
DECLARE
    v_posterior bigint;
BEGIN
    IF NOT (OLD.status = 'aplicado' AND NEW.status = 'anulado') THEN
        RETURN NEW;
    END IF;

    SELECT MAX(id) INTO v_posterior
      FROM payments
     WHERE sale_id = OLD.sale_id
       AND status = 'aplicado'
       AND id > OLD.id;

    IF v_posterior IS NOT NULL THEN
        RAISE EXCEPTION 'Solo se anula el último pago aplicado de la venta: primero hay que anular el pago #%', v_posterior
            USING ERRCODE = 'restrict_violation';
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_payments_void_order ON payments;
CREATE TRIGGER trg_payments_void_order
    BEFORE UPDATE OF status ON payments
    FOR EACH ROW EXECUTE FUNCTION payments_guard_void_order();


-- =====================================================================
-- 4. ESTADO DOCUMENTAL DEL COMPROBANTE
--
-- NO es el estado económico de la cuota ni del pago. Un pago en efectivo
-- reduce el saldo en el momento (regla H) y aun así queda PENDIENTE_DE_BOLETA
-- hasta que llegue su respaldo. Son dos ejes independientes y no deben
-- mezclarse (docs/REGLAS-DE-NEGOCIO.md §17).
--
-- La columna nace NULL y NO tiene DEFAULT: los pagos ya registrados quedan
-- NULL, que significa "anterior al control documental". Poner un valor por
-- defecto los habría convertido de golpe en pagos "pendientes de boleta", que
-- es exactamente la reinterpretación del histórico que la regla M prohíbe.
-- =====================================================================
ALTER TABLE payments ADD COLUMN IF NOT EXISTS voucher_status VARCHAR(30);

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payments_voucher_status_check') THEN
        ALTER TABLE payments
            ADD CONSTRAINT payments_voucher_status_check
            CHECK (voucher_status IS NULL OR voucher_status IN
                   ('PENDIENTE_DE_BOLETA', 'EN_REVISION', 'REVISADA', 'RECHAZADA'));
    END IF;
END $$;

COMMENT ON COLUMN payments.voucher_status IS
    'Estado del COMPROBANTE, independiente del estado económico del pago. NULL = pago anterior al control documental del bloque 4 (no se reinterpreta).';

-- Historial del comprobante: evidencia, solo inserción.
CREATE TABLE IF NOT EXISTS payment_voucher_events (
    id          BIGSERIAL   PRIMARY KEY,
    payment_id  BIGINT      NOT NULL REFERENCES payments (id) ON DELETE RESTRICT,
    from_status VARCHAR(30),
    to_status   VARCHAR(30) NOT NULL,
    action      VARCHAR(20) NOT NULL
                CHECK (action IN ('REGISTRADO', 'OBSERVADO', 'EXPLICADO', 'REVISADO', 'RECHAZADO')),
    actor_id    BIGINT      REFERENCES users (id) ON DELETE RESTRICT,
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    comment     TEXT
);

CREATE INDEX IF NOT EXISTS ix_payment_voucher_events_payment
    ON payment_voucher_events (payment_id, occurred_at, id);


-- =====================================================================
-- 5. DEPÓSITOS
--
-- Un depósito agrupa varios pagos ya registrados. NO cambia la situación
-- económica de nada: el pago ya redujo el saldo cuando se registró (regla H).
-- El depósito es control de caja y conciliación.
--
-- ESTADOS (decisión del propietario): REVISADO -> VALIDADO.
--   * REVISADO: lo registra quien depositó; ya declaró lo que llevó al banco.
--   * VALIDADO: Administración o Gerencia lo dan por bueno. Es terminal.
-- La observación, la explicación del empleado y el rechazo NO son estados:
-- son eventos del historial, y el depósito sigue REVISADO hasta que se valida.
--
-- El monto ESPERADO no se almacena: se calcula sumando los pagos incluidos
-- (v_deposits). Almacenar un derivado invita a que se desincronice.
-- =====================================================================
CREATE TABLE IF NOT EXISTS deposits (
    id              BIGSERIAL      PRIMARY KEY,
    branch_id       BIGINT         NOT NULL REFERENCES branches (id) ON DELETE RESTRICT,
    deposit_date    DATE           NOT NULL DEFAULT app_today(),
    bank            VARCHAR(80),
    account         VARCHAR(60),
    -- Correlativo / número de boleta del banco.
    reference       VARCHAR(80),
    declared_amount NUMERIC(12, 2) NOT NULL CHECK (declared_amount >= 0),
    notes           TEXT,
    status          VARCHAR(20)    NOT NULL DEFAULT 'REVISADO'
                    CHECK (status IN ('REVISADO', 'VALIDADO')),
    created_by      BIGINT         NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
    created_at      TIMESTAMPTZ    NOT NULL DEFAULT now(),
    validated_by    BIGINT         REFERENCES users (id) ON DELETE RESTRICT,
    validated_at    TIMESTAMPTZ,

    CONSTRAINT deposits_validated_fields CHECK (
        (status = 'VALIDADO' AND validated_by IS NOT NULL AND validated_at IS NOT NULL) OR
        (status = 'REVISADO' AND validated_by IS NULL AND validated_at IS NULL)
    )
);

CREATE INDEX IF NOT EXISTS ix_deposits_branch_status ON deposits (branch_id, status);
CREATE INDEX IF NOT EXISTS ix_deposits_date ON deposits (deposit_date DESC, id DESC);

-- Un pago pertenece como mucho a UN depósito. La restricción es global
-- (no por depósito): si no, el mismo pago podría contarse dos veces.
CREATE TABLE IF NOT EXISTS deposit_payments (
    deposit_id BIGINT      NOT NULL REFERENCES deposits (id) ON DELETE RESTRICT,
    payment_id BIGINT      NOT NULL UNIQUE REFERENCES payments (id) ON DELETE RESTRICT,
    added_by   BIGINT      REFERENCES users (id) ON DELETE RESTRICT,
    added_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

    PRIMARY KEY (deposit_id, payment_id)
);

CREATE INDEX IF NOT EXISTS ix_deposit_payments_deposit ON deposit_payments (deposit_id);

-- Trazabilidad completa: creación, observación, explicación, validación y
-- rechazo. Evidencia, solo inserción.
CREATE TABLE IF NOT EXISTS deposit_events (
    id          BIGSERIAL   PRIMARY KEY,
    deposit_id  BIGINT      NOT NULL REFERENCES deposits (id) ON DELETE RESTRICT,
    event       VARCHAR(20) NOT NULL
                CHECK (event IN ('CREADO', 'OBSERVADO', 'EXPLICADO', 'VALIDADO', 'RECHAZADO')),
    from_status VARCHAR(20),
    to_status   VARCHAR(20),
    actor_id    BIGINT      REFERENCES users (id) ON DELETE RESTRICT,
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    comment     TEXT
);

CREATE INDEX IF NOT EXISTS ix_deposit_events_deposit ON deposit_events (deposit_id, occurred_at, id);

-- Un depósito validado es terminal: no vuelve atrás ni cambia de importe.
CREATE OR REPLACE FUNCTION deposits_guard_status() RETURNS trigger
    LANGUAGE plpgsql
AS $$
BEGIN
    IF OLD.status = 'VALIDADO' AND NEW.status <> 'VALIDADO' THEN
        RAISE EXCEPTION 'Un depósito validado no vuelve a revisión'
            USING ERRCODE = 'restrict_violation';
    END IF;
    IF OLD.status = 'VALIDADO' AND NEW.declared_amount IS DISTINCT FROM OLD.declared_amount THEN
        RAISE EXCEPTION 'El monto de un depósito validado no se modifica'
            USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_deposits_guard_status ON deposits;
CREATE TRIGGER trg_deposits_guard_status
    BEFORE UPDATE ON deposits
    FOR EACH ROW EXECUTE FUNCTION deposits_guard_status();


-- =====================================================================
-- 6. RECIBO INMUTABLE (preparado, todavía vacío)
--
-- El flujo final será: pago persistido -> recibo -> outbox -> n8n -> WhatsApp.
-- Aquí solo queda la estructura. El generador, la numeración y el envío son
-- del bloque 4.2/4.3: esta tabla NO se llena en 4.0 y nada la consulta aún.
--
-- El recibo congela lo que decía el sistema en el momento de emitirlo
-- (saldo anterior, saldo nuevo, distribución FIFO, cliente, sucursal). Una
-- corrección NO edita el recibo: se anula el pago y se emite uno nuevo.
-- =====================================================================
CREATE TABLE IF NOT EXISTS payment_receipts (
    id              BIGSERIAL      PRIMARY KEY,
    payment_id      BIGINT         NOT NULL UNIQUE REFERENCES payments (id) ON DELETE RESTRICT,
    receipt_number  VARCHAR(20)    NOT NULL UNIQUE,
    issued_at       TIMESTAMPTZ    NOT NULL DEFAULT now(),

    -- A quién y sobre qué
    customer_id     BIGINT         NOT NULL REFERENCES customers (id) ON DELETE RESTRICT,
    sale_id         BIGINT         NOT NULL REFERENCES sales (id) ON DELETE RESTRICT,
    branch_id       BIGINT         REFERENCES branches (id) ON DELETE RESTRICT,
    issued_by       BIGINT         REFERENCES users (id) ON DELETE RESTRICT,

    -- Cifras congeladas
    payment_date    DATE           NOT NULL,
    method          VARCHAR(20)    NOT NULL,
    amount          NUMERIC(12, 2) NOT NULL CHECK (amount > 0),
    balance_before  NUMERIC(12, 2) NOT NULL CHECK (balance_before >= 0),
    balance_after   NUMERIC(12, 2) NOT NULL CHECK (balance_after >= 0),

    -- Respaldo
    deposit_id      BIGINT         REFERENCES deposits (id) ON DELETE RESTRICT,
    deposit_reference VARCHAR(80),

    -- Distribución FIFO y foto de los datos mostrados, tal cual se emitieron.
    allocations     JSONB          NOT NULL DEFAULT '[]'::jsonb,
    snapshot        JSONB          NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS ix_payment_receipts_sale ON payment_receipts (sale_id, issued_at);
CREATE INDEX IF NOT EXISTS ix_payment_receipts_customer ON payment_receipts (customer_id, issued_at);

COMMENT ON TABLE payment_receipts IS
    'Recibo INMUTABLE de un pago. Bloque 4.0 solo crea la estructura; la emisión y el envío son del bloque 4.2/4.3. Una corrección se hace anulando el pago y emitiendo otro recibo, nunca editando este.';


-- =====================================================================
-- 7. EVIDENCIA DE SOLO INSERCIÓN
--
-- Se reutiliza `credit_evidence_is_append_only()` (migración 009) en lugar de
-- escribir otra función igual: es exactamente la misma regla.
-- =====================================================================
DO $$
DECLARE
    t text;
BEGIN
    FOREACH t IN ARRAY ARRAY['deposit_events', 'payment_voucher_events', 'payment_receipts'] LOOP
        EXECUTE format('DROP TRIGGER IF EXISTS trg_%s_append_only ON %I', t, t);
        EXECUTE format(
            'CREATE TRIGGER trg_%s_append_only BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION credit_evidence_is_append_only()',
            t, t
        );
    END LOOP;
END $$;


-- =====================================================================
-- 8. ÍNDICES PARA LAS CONSULTAS DEL BLOQUE 4
-- =====================================================================

-- Saldo de una venta y "último pago aplicado": las dos consultas calientes.
CREATE INDEX IF NOT EXISTS ix_payments_sale_aplicado
    ON payments (sale_id, id DESC) WHERE status = 'aplicado';

-- Cartera propia del vendedor y cobranza por usuario.
CREATE INDEX IF NOT EXISTS ix_payments_created_by ON payments (created_by, payment_date DESC);

-- Bandeja de comprobantes pendientes de revisión.
CREATE INDEX IF NOT EXISTS ix_payments_voucher_status
    ON payments (voucher_status) WHERE voucher_status IS NOT NULL;


-- =====================================================================
-- 9. VISTA DE CONCILIACIÓN DEL DEPÓSITO
--
-- Una diferencia NO revierte ni borra ningún pago (regla G): solo se ve.
-- Si un pago incluido se anula después, el depósito lo SIGUE listando y la
-- vista muestra el efecto por separado, sin ocultar nada (decisión sobre
-- anulación de pagos ya depositados).
-- =====================================================================
CREATE OR REPLACE VIEW v_deposits AS
SELECT d.id,
       'D-' || LPAD(d.id::text, 6, '0')                              AS deposit_number,
       d.branch_id,
       b.code                                                        AS branch_code,
       b.name                                                        AS branch_name,
       d.deposit_date,
       d.bank,
       d.account,
       d.reference,
       d.declared_amount,
       d.status,
       d.notes,
       d.created_by,
       u.username                                                    AS created_by_username,
       d.created_at,
       d.validated_by,
       v.username                                                    AS validated_by_username,
       d.validated_at,
       COALESCE(p.payments_count, 0)                                 AS payments_count,
       COALESCE(p.expected_amount, 0)::NUMERIC(12, 2)                AS expected_amount,
       COALESCE(p.voided_count, 0)                                   AS voided_count,
       COALESCE(p.voided_amount, 0)::NUMERIC(12, 2)                  AS voided_amount,
       COALESCE(p.applied_amount, 0)::NUMERIC(12, 2)                 AS applied_amount,
       (d.declared_amount - COALESCE(p.applied_amount, 0))::NUMERIC(12, 2) AS difference,
       (d.declared_amount <> COALESCE(p.applied_amount, 0))          AS has_difference,
       e.last_event,
       e.last_event_at
  FROM deposits d
  JOIN branches b ON b.id = d.branch_id
  LEFT JOIN users u ON u.id = d.created_by
  LEFT JOIN users v ON v.id = d.validated_by
  LEFT JOIN LATERAL (
      SELECT COUNT(*)::int                                                       AS payments_count,
             SUM(pay.amount)                                                     AS expected_amount,
             COUNT(*) FILTER (WHERE pay.status = 'anulado')::int                 AS voided_count,
             COALESCE(SUM(pay.amount) FILTER (WHERE pay.status = 'anulado'), 0)  AS voided_amount,
             COALESCE(SUM(pay.amount) FILTER (WHERE pay.status = 'aplicado'), 0) AS applied_amount
        FROM deposit_payments dp
        JOIN payments pay ON pay.id = dp.payment_id
       WHERE dp.deposit_id = d.id
  ) p ON TRUE
  LEFT JOIN LATERAL (
      SELECT ev.event AS last_event, ev.occurred_at AS last_event_at
        FROM deposit_events ev
       WHERE ev.deposit_id = d.id
    ORDER BY ev.occurred_at DESC, ev.id DESC
       LIMIT 1
  ) e ON TRUE;

-- =====================================================================
-- FIN 013
-- =====================================================================
