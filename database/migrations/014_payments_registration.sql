-- =====================================================================
-- 014_payments_registration.sql
-- BLOQUE 4.1 — REGISTRO Y ANULACIÓN DE PAGOS
--
-- La 013 puso la base (inmutabilidad, fechas, orden de anulación, depósitos,
-- comprobante y recibo). Esta migración solo añade las dos piezas que le
-- faltaban al REGISTRO:
--
--   1. Protección contra el doble envío (Idempotency-Key), con el MISMO
--      patrón que ya usan las solicitudes de crédito desde la 007: no se
--      inventa un mecanismo nuevo.
--   2. Quién anuló un pago. Hasta ahora se guardaba cuándo y por qué, pero
--      el quién solo vivía en la bitácora; con el bloque 4 la anulación es
--      una operación formal y el dato pertenece también al propio pago.
--
-- SOLO ADITIVA Y RE-EJECUTABLE. No reescribe ni reinterpreta ningún pago:
-- las columnas nuevas nacen NULL en todo lo ya registrado.
-- =====================================================================


-- =====================================================================
-- 1. DOBLE ENVÍO (mismo patrón que credit_applications, migración 007)
--
-- `client_request_id` es la cabecera Idempotency-Key que manda el cliente y
-- `request_fingerprint` el SHA-256 del cuerpo ya validado. Repetir la misma
-- clave con el MISMO cuerpo devuelve el pago que ya se registró; repetirla
-- con un cuerpo distinto es un error del cliente y se rechaza.
--
-- El índice único es la garantía de verdad: aunque dos peticiones entren a
-- la vez, la base deja pasar una sola. La clave es POR USUARIO, así que dos
-- cobradores pueden usar la misma sin estorbarse.
-- =====================================================================
ALTER TABLE payments ADD COLUMN IF NOT EXISTS client_request_id VARCHAR(100);
ALTER TABLE payments ADD COLUMN IF NOT EXISTS request_fingerprint CHAR(64);

CREATE UNIQUE INDEX IF NOT EXISTS ux_payments_request
    ON payments (created_by, client_request_id)
    WHERE client_request_id IS NOT NULL;

COMMENT ON COLUMN payments.client_request_id IS
    'Cabecera Idempotency-Key del registro del pago. NULL en los pagos anteriores y en los que se registran sin clave.';
COMMENT ON COLUMN payments.request_fingerprint IS
    'SHA-256 del cuerpo validado. Detecta que la misma clave se reutilizó con datos distintos.';


-- =====================================================================
-- 2. QUIÉN ANULÓ EL PAGO
--
-- `voided_at` y `void_reason` ya existían desde la 001. Falta el usuario:
-- la anulación es una operación formal y auditada, y el pago debe poder
-- responder por sí mismo quién la hizo, sin tener que cruzar la bitácora.
--
-- Queda NULL en los pagos ya anulados: no se inventa un responsable que no
-- se registró en su momento. La bitácora conserva ese dato para ellos.
-- =====================================================================
ALTER TABLE payments ADD COLUMN IF NOT EXISTS voided_by BIGINT
    REFERENCES users (id) ON DELETE RESTRICT;

COMMENT ON COLUMN payments.voided_by IS
    'Usuario que anuló el pago (bloque 4.1). NULL en anulaciones anteriores: su responsable está en la bitácora.';

-- Un pago anulado tiene que decir cuándo y por qué. Se valida solo hacia
-- adelante (NOT VALID): las filas ya guardadas no se revisan ni se corrigen.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payments_voided_fields') THEN
        ALTER TABLE payments
            ADD CONSTRAINT payments_voided_fields
            CHECK (
                status <> 'anulado'
                OR (voided_at IS NOT NULL AND length(btrim(coalesce(void_reason, ''))) > 0)
            ) NOT VALID;
    END IF;
END $$;


-- =====================================================================
-- 3. ÍNDICE PARA EL EXPEDIENTE DEL COMPROBANTE
--
-- El registro de un pago inserta ahora su primer evento documental, y la
-- pantalla del pago los lee en orden. El índice de la 013 ya cubre la
-- consulta por pago; aquí se añade el de la bandeja por acción y fecha.
-- =====================================================================
CREATE INDEX IF NOT EXISTS ix_payment_voucher_events_action
    ON payment_voucher_events (action, occurred_at DESC);

-- =====================================================================
-- FIN 014
-- =====================================================================
