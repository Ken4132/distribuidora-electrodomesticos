-- =====================================================================
-- 016 — DEPÓSITOS Y CONCILIACIÓN (bloque 4.2)
--
-- Esta migración NO crea el modelo de depósitos: ya existe desde 013
-- (deposits, deposit_payments, deposit_events, v_deposits). Aquí solo se
-- añade lo que faltaba para poder OPERARLO desde la aplicación:
--
--   1. los permisos del módulo (no existía ninguno `deposits.*`);
--   2. la trazabilidad de la INCLUSIÓN de un pago (evento + pago señalado);
--   3. las guardas de integridad que hasta ahora solo podía imponer el
--      servicio: sucursal, pago anulado y depósito ya validado;
--   4. la inmutabilidad del depósito y de la relación depósito↔pago.
--
-- Es ADITIVA y RE-EJECUTABLE: no borra filas, no reescribe históricos y no
-- cambia económicamente ningún pago. Los estados del depósito siguen siendo
-- EXACTAMENTE dos, REVISADO y VALIDADO: aquí no se crea ninguno más.
-- =====================================================================


-- =====================================================================
-- 1. PERMISOS DEL MÓDULO
--
-- Decisiones del propietario (2026-09-18), que es lo que faltaba definir:
--
--   * CREA el depósito quien recauda y lo lleva al banco: COBRADOR y
--     ADMINISTRACIÓN. El vendedor cobra su cartera pero no maneja la caja,
--     así que NO recibe `deposits.create`.
--   * REVISA y VALIDA: ADMINISTRACIÓN y GERENCIA (regla ya documentada).
--   * Un pago cuya VENTA no tiene sucursal (ventas anteriores a la
--     migración 005) no entra a ningún depósito salvo que lo incluya
--     ADMINISTRACIÓN, y queda constancia de quién lo hizo. Ese es el único
--     objeto de `deposits.override`: no amplía ninguna otra regla.
--
-- Se sigue el patrón del catálogo: los permisos NO se crean desde la
-- interfaz, se siembran aquí, y el administrador decide qué rol tiene cuáles.
-- =====================================================================
INSERT INTO permissions (code, module, name, description) VALUES
    ('deposits.view',     'depositos', 'Consultar depósitos y su conciliación',
                          'Listado, detalle, pagos incluidos e historial.'),
    ('deposits.create',   'depositos', 'Registrar depósitos e incluir pagos',
                          'Quien recauda y deposita. Decisión del propietario (2026-09-18): Cobrador y Administración.'),
    ('deposits.review',   'depositos', 'Revisar y validar depósitos',
                          'Observar, rechazar (evento de historial) y validar. Administración y Gerencia.'),
    ('deposits.override', 'depositos', 'Incluir pagos sin sucursal determinable',
                          'Excepción para ventas históricas sin sucursal. Exclusivo de Administración; queda auditado.')
ON CONFLICT (code) DO UPDATE
    SET module = EXCLUDED.module,
        name = EXCLUDED.name,
        description = EXCLUDED.description;

-- Administración conserva acceso total (misma política que 004/007/012).
INSERT INTO role_permissions (role_code, permission_code)
SELECT 'admin', code FROM permissions
ON CONFLICT DO NOTHING;

-- Gerencia: supervisa. Revisa y valida, pero no arma depósitos ni usa la
-- excepción de sucursal.
-- Cobrador: arma el depósito con lo que recaudó. No se valida a sí mismo.
INSERT INTO role_permissions (role_code, permission_code)
SELECT r.code, p.code
  FROM (VALUES
            ('gerencia', 'deposits.view'),
            ('gerencia', 'deposits.review'),
            ('cobrador', 'deposits.view'),
            ('cobrador', 'deposits.create')
       ) AS v(role_code, permission_code)
  JOIN roles r ON r.code = v.role_code
  JOIN permissions p ON p.code = v.permission_code
ON CONFLICT DO NOTHING;

-- La excepción de sucursal no se reparte: solo administración.
DELETE FROM role_permissions
 WHERE permission_code = 'deposits.override'
   AND role_code <> 'admin';


-- =====================================================================
-- 2. TRAZABILIDAD DE LA INCLUSIÓN DE UN PAGO
--
-- El historial de 013 ya cubría creación, observación, explicación,
-- validación y rechazo. Faltaba el hecho que más se consulta cuando una
-- conciliación no cuadra: CUÁNDO y QUIÉN metió cada pago al depósito.
--
-- `PAGO_AGREGADO` es un EVENTO del historial, no un estado: el depósito
-- sigue REVISADO. Se amplía el CHECK (superset: ninguna fila existente deja
-- de ser válida) y se añade la columna que señala el pago implicado, que
-- también sirve para el evento que ya deja la anulación de un pago
-- depositado.
-- =====================================================================
ALTER TABLE deposit_events DROP CONSTRAINT IF EXISTS deposit_events_event_check;
ALTER TABLE deposit_events ADD CONSTRAINT deposit_events_event_check
    CHECK (event IN ('CREADO', 'PAGO_AGREGADO', 'OBSERVADO', 'EXPLICADO', 'VALIDADO', 'RECHAZADO'));

ALTER TABLE deposit_events
    ADD COLUMN IF NOT EXISTS payment_id BIGINT REFERENCES payments (id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS ix_deposit_events_payment
    ON deposit_events (payment_id) WHERE payment_id IS NOT NULL;

COMMENT ON COLUMN deposit_events.payment_id IS
    'Pago al que se refiere el evento (inclusión en el depósito, o anulación de un pago ya depositado). NULL en los eventos que hablan del depósito completo.';


-- =====================================================================
-- 3. QUÉ PAGO PUEDE ENTRAR A UN DEPÓSITO
--
-- Tres reglas, las tres en la base y no solo en el servicio: si únicamente
-- las impusiera la aplicación, cualquiera con acceso a la base las saltaría.
--
--   a) Un depósito VALIDADO ya no cambia de importe -> no admite más pagos.
--   b) Un pago ANULADO no entra a un depósito (decisión del propietario,
--      2026-09-18). Lo que sí se permite, y no cambia, es anular un pago que
--      YA estaba depositado: ahí el pago se queda dentro y la conciliación
--      lo refleja.
--   c) SUCURSAL: el pago tiene que ser de la misma sucursal que el depósito.
--      La sucursal del pago es la de su VENTA (`sales.branch_id`): la tabla
--      `payments` no tiene sucursal propia y no se le añade una, porque sería
--      un dato derivado que se puede desincronizar.
--
--      Las ventas anteriores a la migración 005 tienen `branch_id` NULL. Ese
--      caso NO lo decide la base: aquí se deja pasar y es el servicio quien
--      exige `deposits.override` y deja el rastro. La base impone la parte
--      dura —un pago de OTRA sucursal es imposible— y la excepción, que es
--      una cuestión de permisos, vive donde se conocen los permisos.
--
-- No se comprueba aquí que el pago ya esté en otro depósito: de eso se
-- encarga el UNIQUE de `deposit_payments.payment_id` desde 013, y duplicar
-- la comprobación solo cambiaría el código de error.
-- =====================================================================
CREATE OR REPLACE FUNCTION deposit_payments_guard() RETURNS trigger
    LANGUAGE plpgsql
AS $$
DECLARE
    v_deposit_status deposits.status%TYPE;
    v_deposit_branch deposits.branch_id%TYPE;
    v_payment_status payments.status%TYPE;
    v_payment_branch BIGINT;
BEGIN
    SELECT d.status, d.branch_id INTO v_deposit_status, v_deposit_branch
      FROM deposits d WHERE d.id = NEW.deposit_id;

    IF v_deposit_status = 'VALIDADO' THEN
        RAISE EXCEPTION 'Un depósito validado ya no admite más pagos'
            USING ERRCODE = 'restrict_violation';
    END IF;

    SELECT p.status, s.branch_id INTO v_payment_status, v_payment_branch
      FROM payments p JOIN sales s ON s.id = p.sale_id
     WHERE p.id = NEW.payment_id;

    IF v_payment_status IS DISTINCT FROM 'aplicado' THEN
        RAISE EXCEPTION 'Un pago anulado no se puede incluir en un depósito'
            USING ERRCODE = 'restrict_violation';
    END IF;

    IF v_payment_branch IS NOT NULL AND v_payment_branch <> v_deposit_branch THEN
        RAISE EXCEPTION 'El pago pertenece a otra sucursal que la del depósito'
            USING ERRCODE = 'restrict_violation';
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_deposit_payments_guard ON deposit_payments;
CREATE TRIGGER trg_deposit_payments_guard
    BEFORE INSERT ON deposit_payments
    FOR EACH ROW EXECUTE FUNCTION deposit_payments_guard();


-- =====================================================================
-- 4. INMUTABILIDAD
--
-- Un pago no se saca de un depósito, ni cambiando la fila ni borrándola.
-- Es la misma regla de "evidencia de solo inserción" que ya usan el crédito
-- y el historial de pagos, así que se reutiliza la misma función (009) en
-- lugar de escribir otra igual.
-- =====================================================================
DROP TRIGGER IF EXISTS trg_deposit_payments_append_only ON deposit_payments;
CREATE TRIGGER trg_deposit_payments_append_only
    BEFORE UPDATE OR DELETE ON deposit_payments
    FOR EACH ROW EXECUTE FUNCTION credit_evidence_is_append_only();

-- Un depósito no se borra nunca: es un hecho de caja con historial propio.
-- Si se registró por error, se deja constancia por evento; no hay edición
-- destructiva ni borrado, ni siquiera cuando todavía no tiene pagos.
CREATE OR REPLACE FUNCTION deposits_no_delete() RETURNS trigger
    LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'Un depósito no se elimina: su historial es la trazabilidad de la caja'
        USING ERRCODE = 'restrict_violation';
END;
$$;

DROP TRIGGER IF EXISTS trg_deposits_no_delete ON deposits;
CREATE TRIGGER trg_deposits_no_delete
    BEFORE DELETE ON deposits
    FOR EACH ROW EXECUTE FUNCTION deposits_no_delete();

-- Guarda de estado, ampliada respecto de 013 (misma función, redefinida):
--
--   * VALIDADO es TERMINAL y la fila queda CONGELADA: no vuelve a revisión,
--     no cambia de importe y tampoco de fecha, banco, referencia o sucursal.
--     013 solo congelaba estado e importe.
--   * La sucursal de un depósito que ya tiene pagos no se puede cambiar: si
--     se pudiera, se reescribiría la relación histórica con esos pagos.
-- =====================================================================
CREATE OR REPLACE FUNCTION deposits_guard_status() RETURNS trigger
    LANGUAGE plpgsql
AS $$
DECLARE
    v_payments INTEGER;
BEGIN
    IF OLD.status = 'VALIDADO' THEN
        IF NEW.status <> 'VALIDADO' THEN
            RAISE EXCEPTION 'Un depósito validado no vuelve a revisión'
                USING ERRCODE = 'restrict_violation';
        END IF;
        IF NEW.declared_amount IS DISTINCT FROM OLD.declared_amount THEN
            RAISE EXCEPTION 'El monto de un depósito validado no se modifica'
                USING ERRCODE = 'restrict_violation';
        END IF;
        RAISE EXCEPTION 'Un depósito validado es definitivo: no se modifica'
            USING ERRCODE = 'restrict_violation';
    END IF;

    IF NEW.branch_id IS DISTINCT FROM OLD.branch_id THEN
        SELECT COUNT(*) INTO v_payments FROM deposit_payments WHERE deposit_id = OLD.id;
        IF v_payments > 0 THEN
            RAISE EXCEPTION 'No se cambia la sucursal de un depósito que ya tiene pagos incluidos'
                USING ERRCODE = 'restrict_violation';
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_deposits_guard_status ON deposits;
CREATE TRIGGER trg_deposits_guard_status
    BEFORE UPDATE ON deposits
    FOR EACH ROW EXECUTE FUNCTION deposits_guard_status();


-- =====================================================================
-- 5. CONCILIACIÓN: LA VISTA
--
-- La vista de 013 NO cambia de significado —nada de lo que ya calculaba se
-- toca— y se le añade solo lo que faltaba para presentarla:
--
--     declared_amount   lo que el empleado declara haber depositado
--     expected_amount   TODO lo incluido, ANTES de anulaciones (bruto)
--     voided_amount     la parte que después se anuló
--     applied_amount    la suma de los pagos APLICABLES incluidos
--     difference        declared_amount - applied_amount
--
-- La conciliación del enunciado es la última línea:
--
--     MONTO ESPERADO  = applied_amount   (pagos aplicables incluidos)
--     MONTO DECLARADO = declared_amount
--     DIFERENCIA      = declarado - esperado
--
-- La diferencia puede ser cero, positiva (se depositó de más) o negativa
-- (faltó dinero). No se fuerza a cero y NO revierte ningún pago.
--
-- `expected_amount` se conserva con su nombre y su significado de 013 (el
-- bruto incluido) para no reinterpretar lo que ya está probado; es el dato
-- que permite ver que un depósito nació por Q300 aunque hoy solo queden
-- Q0 aplicados.
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
       e.last_event_at,
       -- Columnas NUEVAS de 4.2: van al final porque CREATE OR REPLACE VIEW no
       -- permite insertar ni reordenar columnas de una vista que ya existe.
       COALESCE(p.applied_count, 0)                                  AS applied_count,
       COALESCE(ev.events_count, 0)                                  AS events_count
  FROM deposits d
  JOIN branches b ON b.id = d.branch_id
  LEFT JOIN users u ON u.id = d.created_by
  LEFT JOIN users v ON v.id = d.validated_by
  LEFT JOIN LATERAL (
      SELECT COUNT(*)::int                                                       AS payments_count,
             COUNT(*) FILTER (WHERE pay.status = 'aplicado')::int                AS applied_count,
             SUM(pay.amount)                                                     AS expected_amount,
             COUNT(*) FILTER (WHERE pay.status = 'anulado')::int                 AS voided_count,
             COALESCE(SUM(pay.amount) FILTER (WHERE pay.status = 'anulado'), 0)  AS voided_amount,
             COALESCE(SUM(pay.amount) FILTER (WHERE pay.status = 'aplicado'), 0) AS applied_amount
        FROM deposit_payments dp
        JOIN payments pay ON pay.id = dp.payment_id
       WHERE dp.deposit_id = d.id
  ) p ON TRUE
  LEFT JOIN LATERAL (
      SELECT ev2.event AS last_event, ev2.occurred_at AS last_event_at
        FROM deposit_events ev2
       WHERE ev2.deposit_id = d.id
    ORDER BY ev2.occurred_at DESC, ev2.id DESC
       LIMIT 1
  ) e ON TRUE
  LEFT JOIN LATERAL (
      SELECT COUNT(*)::int AS events_count FROM deposit_events ev3 WHERE ev3.deposit_id = d.id
  ) ev ON TRUE;

COMMENT ON VIEW v_deposits IS
    'Conciliación del depósito. MONTO ESPERADO = applied_amount (pagos aplicables incluidos); DIFERENCIA = declared_amount - applied_amount. expected_amount es el bruto incluido antes de anulaciones y se conserva con el significado que tiene desde la migración 013.';


-- =====================================================================
-- FIN 016
-- =====================================================================
