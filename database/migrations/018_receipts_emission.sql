-- =====================================================================
-- 018 — EMISIÓN DE RECIBOS (bloque 4.3)
--
-- La tabla `payment_receipts` existe desde la migración 013, con su
-- disparador de solo inserción, pero nadie la escribía: 4.0 solo dejó la
-- estructura. Aquí se añade lo que faltaba para EMITIR recibos:
--
--   1. la numeración;
--   2. la invariante económica del recibo;
--   3. los índices y la vista de consulta.
--
-- El OUTBOX **no se toca**: `integration_events` (migraciones 001 y 002) ya
-- es una bandeja de salida transaccional con idempotencia, reintentos con
-- espera creciente e historial por intento, y `recordEvent()` ya escribe en
-- ella DENTRO de la transacción del pago. Crear otra sería duplicarla.
--
-- Migración ADITIVA y RE-EJECUTABLE. No borra datos, no reescribe
-- históricos y no cambia económicamente ningún pago.
-- =====================================================================


-- =====================================================================
-- 1. NUMERACIÓN DEL RECIBO
--
-- Una secuencia, no un contador con bloqueo: el proyecto ya tiene pruebas
-- de concurrencia sobre el cobro, y serializar todos los pagos contra una
-- fila contador para conseguir numeración sin huecos sería cambiar el
-- comportamiento del bloque 4.1.
--
-- Contrapartida ACEPTADA y documentada: una transacción que termina en
-- ROLLBACK consume el número, así que la serie puede tener huecos. El
-- recibo es un documento interno de trazabilidad, no un documento fiscal
-- con exigencia de correlatividad. Si algún día hace falta una serie sin
-- huecos, se cambia aquí y solo aquí.
-- =====================================================================
CREATE SEQUENCE IF NOT EXISTS receipt_number_seq AS BIGINT START WITH 1;

CREATE OR REPLACE FUNCTION next_receipt_number() RETURNS VARCHAR
    LANGUAGE sql
AS $$
    SELECT 'R-' || LPAD(nextval('receipt_number_seq')::text, 8, '0');
$$;

COMMENT ON FUNCTION next_receipt_number() IS
    'Siguiente número de recibo (R-00000001). La serie puede tener huecos: un ROLLBACK consume el número. Decisión del bloque 4.3.';


-- =====================================================================
-- 2. INVARIANTE ECONÓMICA DEL RECIBO
--
-- Un recibo dice "el saldo era X, se pagaron Y, queda Z". Si esos tres
-- números no cuadran, el recibo miente. Se comprueba en la base para que
-- tampoco se pueda escribir un recibo incoherente por SQL directo.
--
-- NOT VALID: se aplica a todo lo que se inserte a partir de ahora y no
-- obliga a revalidar filas anteriores. No se reinterpreta ningún histórico.
-- =====================================================================
ALTER TABLE payment_receipts DROP CONSTRAINT IF EXISTS payment_receipts_balance_math;

ALTER TABLE payment_receipts ADD CONSTRAINT payment_receipts_balance_math
    CHECK (balance_after = balance_before - amount) NOT VALID;

COMMENT ON CONSTRAINT payment_receipts_balance_math ON payment_receipts IS
    'El recibo tiene que cuadrar: saldo posterior = saldo anterior - monto.';


-- =====================================================================
-- 3. ÍNDICES DE CONSULTA
--
-- Los de venta y cliente ya están (013). Faltaban los dos que usan las
-- pantallas de 4.3: el listado por fecha y el filtro por sucursal.
-- =====================================================================
CREATE INDEX IF NOT EXISTS ix_payment_receipts_issued
    ON payment_receipts (issued_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS ix_payment_receipts_branch
    ON payment_receipts (branch_id, issued_at DESC);


-- =====================================================================
-- 4. VISTA DE CONSULTA
--
-- Separa con claridad DOS cosas que no son lo mismo:
--
--   * lo CONGELADO en el recibo (monto, saldos, método, sucursal, fecha):
--     es lo que decía el sistema cuando se emitió y no cambia nunca;
--   * lo VIVO del pago al que pertenece (si después se anuló, en qué
--     depósito acabó, en qué estado va su comprobante).
--
-- Un pago anulado NO borra ni modifica su recibo: el recibo se conserva y
-- la vista muestra la anulación al lado. Esa es la trazabilidad que pide
-- la regla de correcciones: nunca se edita el histórico.
-- =====================================================================
CREATE OR REPLACE VIEW v_payment_receipts AS
SELECT r.id,
       r.receipt_number,
       r.issued_at,
       r.payment_id,
       'P-' || LPAD(r.payment_id::text, 6, '0')      AS payment_number,
       r.sale_id,
       'V-' || LPAD(r.sale_id::text, 6, '0')         AS sale_number,
       r.customer_id,
       c.full_name                                   AS customer_name,
       c.dpi                                         AS customer_dpi,
       c.phone                                       AS customer_phone,
       r.branch_id,
       b.code                                        AS branch_code,
       b.name                                        AS branch_name,
       r.issued_by,
       u.username                                    AS issued_by_username,
       r.payment_date,
       r.method,
       r.amount,
       r.balance_before,
       r.balance_after,
       r.deposit_id,
       r.deposit_reference,
       r.allocations,
       r.snapshot,
       -- Estado VIVO del pago: el recibo no cambia, pero hay que poder ver
       -- si el pago que documenta sigue en pie.
       p.status                                      AS payment_status,
       p.voucher_status,
       p.voided_at,
       p.void_reason,
       vb.username                                   AS voided_by_username,
       dp.deposit_id                                 AS current_deposit_id,
       CASE WHEN dp.deposit_id IS NULL THEN NULL
            ELSE 'D-' || LPAD(dp.deposit_id::text, 6, '0') END AS current_deposit_number
  FROM payment_receipts r
  JOIN payments p   ON p.id = r.payment_id
  JOIN customers c  ON c.id = r.customer_id
  LEFT JOIN branches b ON b.id = r.branch_id
  LEFT JOIN users u    ON u.id = r.issued_by
  LEFT JOIN users vb   ON vb.id = p.voided_by
  LEFT JOIN deposit_payments dp ON dp.payment_id = r.payment_id;

COMMENT ON VIEW v_payment_receipts IS
    'Recibos emitidos. Las columnas del recibo están CONGELADAS; payment_status, voided_at y current_deposit_* son el estado vivo del pago que documenta.';


-- =====================================================================
-- FIN 018
-- =====================================================================
