-- =====================================================================
-- 007_credit_stabilization.sql
-- BLOQUE 3.1: estabilización del sistema de créditos
--
-- Qué añade (solo aditivo, compatible con 001-006):
--   1. Enganche propuesto a nivel de SOLICITUD (decisión confirmada: el
--      enganche pertenece al total de la solicitud y está incluido dentro
--      del precio financiado).
--   2. Protección técnica contra doble envío mediante clave de idempotencia.
--   3. Restricción de reglas comerciales en planes PREDEFINIDOS.
--   4. Normalización de los textos de negocio de la solicitud (red de
--      seguridad en base de datos; el backend sigue siendo la autoridad).
--   5. Permisos con alcance para consultar solicitudes.
--   6. Vistas derivadas con totales por línea y por solicitud.
--
-- Qué NO hace:
--   * No borra columnas, tablas ni filas de negocio.
--   * No recalcula ni reescribe solicitudes, ventas ni precios históricos.
--   * No toca `sales`, `sale_items`, `installments` ni `payments`.
--   * No implementa verificación, decisión ni conversión a venta.
--
-- El runner (backend/src/scripts/migrate.js) envuelve el archivo en una
-- transacción.
-- =====================================================================


-- =====================================================================
-- 1. ENGANCHE A NIVEL DE SOLICITUD
--
-- Nullable a propósito: las solicitudes creadas antes de esta migración
-- guardaban el enganche por línea (`credit_application_items.
-- proposed_down_payment`). Rellenar esta columna con 0 inventaría un dato
-- que nunca se registró. Las vistas usan COALESCE para leer ambas formas.
-- Toda solicitud nueva la registra el backend con un valor explícito.
-- =====================================================================
ALTER TABLE credit_applications
    ADD COLUMN IF NOT EXISTS proposed_down_payment NUMERIC(12, 2);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'credit_applications_down_payment_nonnegative'
    ) THEN
        ALTER TABLE credit_applications
            ADD CONSTRAINT credit_applications_down_payment_nonnegative
            CHECK (proposed_down_payment IS NULL OR proposed_down_payment >= 0);
    END IF;
END $$;

COMMENT ON COLUMN credit_applications.proposed_down_payment IS
    'Enganche PROPUESTO para el total de la solicitud. Está incluido dentro del precio financiado; no es un pago ni modifica saldo. NULL = solicitud anterior a 007 (enganche registrado por línea).';

COMMENT ON COLUMN credit_application_items.proposed_price IS
    'Precio UNITARIO propuesto. Total de la línea = proposed_price x quantity.';
COMMENT ON COLUMN credit_application_items.minimum_price_snapshot IS
    'Precio mínimo UNITARIO vigente al crear la solicitud.';
COMMENT ON COLUMN credit_application_items.proposed_installment IS
    'Desde 007: cuota de la LÍNEA completa = (proposed_price x quantity) / installments_count, sin enganche (el enganche es de la solicitud).';
COMMENT ON COLUMN credit_application_items.minimum_installment_snapshot IS
    'Desde 007: cuota mínima de la LÍNEA completa = (minimum_price_snapshot x quantity) / installments_count.';
COMMENT ON COLUMN credit_application_items.proposed_down_payment IS
    'OBSOLETA desde 007: el enganche se registra en credit_applications.proposed_down_payment. Se conserva para las solicitudes anteriores; las nuevas guardan 0.';


-- =====================================================================
-- 2. PROTECCIÓN CONTRA DOBLE ENVÍO (idempotencia técnica)
--
-- El cliente HTTP puede enviar la cabecera `Idempotency-Key`. Si repite la
-- misma clave, el backend devuelve la solicitud ya creada en lugar de crear
-- otra. No es una regla comercial: no impide que un cliente tenga varias
-- solicitudes, solo que un mismo envío se registre dos veces.
--
-- `request_fingerprint` (SHA-256 del cuerpo ya validado) detecta que se
-- reutilizó una clave con datos distintos.
-- =====================================================================
ALTER TABLE credit_applications
    ADD COLUMN IF NOT EXISTS client_request_id VARCHAR(100);

ALTER TABLE credit_applications
    ADD COLUMN IF NOT EXISTS request_fingerprint CHAR(64);

CREATE UNIQUE INDEX IF NOT EXISTS ux_credit_applications_request
    ON credit_applications (created_by, client_request_id)
    WHERE client_request_id IS NOT NULL;

COMMENT ON COLUMN credit_applications.client_request_id IS
    'Clave de idempotencia enviada por el cliente (cabecera Idempotency-Key). Única por usuario creador.';


-- =====================================================================
-- 3. PLANES PREDEFINIDOS: REGLA COMERCIAL VIGENTE
--
--     4 cuotas  -> +40%
--     5 cuotas  -> +50%
--     6 cuotas  -> +60%
--     10 cuotas -> +80%
--     12 cuotas -> +100%
--
-- NOT VALID: la restricción se aplica a todo INSERT/UPDATE desde ahora,
-- pero NO revalida filas existentes. Si hubiera un plan histórico fuera de
-- regla, no se borra ni se reescribe; el backend lo rechaza al usarlo en
-- una solicitud nueva (y la consulta de abajo permite encontrarlo).
-- =====================================================================
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'product_financing_plans_predefined_rule'
    ) THEN
        ALTER TABLE product_financing_plans
            ADD CONSTRAINT product_financing_plans_predefined_rule
            CHECK (
                (installments_count, financing_percentage) IN (
                    (4, 40.00),
                    (5, 50.00),
                    (6, 60.00),
                    (10, 80.00),
                    (12, 100.00)
                )
            ) NOT VALID;
    END IF;
END $$;

-- Planes existentes que no cumplen la regla vigente (consulta de apoyo).
CREATE OR REPLACE VIEW v_financing_plans_out_of_rule AS
SELECT p.*
  FROM product_financing_plans p
 WHERE (p.installments_count, p.financing_percentage) NOT IN (
        (4, 40.00), (5, 50.00), (6, 60.00), (10, 80.00), (12, 100.00)
       );


-- =====================================================================
-- 4. NORMALIZACIÓN DE LA SOLICITUD
--
-- Misma regla que clientes y productos (normalize_business_text, 004):
-- MAYÚSCULAS, sin tildes, conserva la Ñ, espacios colapsados.
--
-- Solo BEFORE INSERT: los datos de la solicitud son un snapshot congelado.
-- Un UPDATE posterior (por ejemplo, un cambio de estado) nunca reescribe lo
-- que se registró. Tampoco hay backfill: las filas existentes no se tocan.
--
-- No se normalizan: teléfonos, DPI, correo, estado, campos técnicos ni el
-- motivo de corrección.
-- =====================================================================
CREATE OR REPLACE FUNCTION credit_applications_normalize() RETURNS trigger
    LANGUAGE plpgsql
AS $$
BEGIN
    NEW.customer_full_name_snapshot          := normalize_business_text(NEW.customer_full_name_snapshot);
    NEW.customer_address_snapshot            := normalize_business_text(NEW.customer_address_snapshot);
    NEW.customer_address_ref_snapshot        := NULLIF(normalize_business_text(NEW.customer_address_ref_snapshot), '');
    NEW.customer_municipality_snapshot       := NULLIF(normalize_business_text(NEW.customer_municipality_snapshot), '');
    NEW.customer_department_snapshot         := NULLIF(normalize_business_text(NEW.customer_department_snapshot), '');
    NEW.housing_type_snapshot                := NULLIF(normalize_business_text(NEW.housing_type_snapshot), '');
    NEW.residence_time_snapshot              := NULLIF(normalize_business_text(NEW.residence_time_snapshot), '');
    NEW.employer_name_snapshot               := NULLIF(normalize_business_text(NEW.employer_name_snapshot), '');
    NEW.employer_address_snapshot            := NULLIF(normalize_business_text(NEW.employer_address_snapshot), '');
    NEW.employment_time_snapshot             := NULLIF(normalize_business_text(NEW.employment_time_snapshot), '');
    NEW.job_position_snapshot                := NULLIF(normalize_business_text(NEW.job_position_snapshot), '');
    NEW.labor_reference_name_snapshot        := NULLIF(normalize_business_text(NEW.labor_reference_name_snapshot), '');
    NEW.labor_reference_relation_snapshot    := NULLIF(normalize_business_text(NEW.labor_reference_relation_snapshot), '');
    NEW.personal_reference_name_snapshot     := NULLIF(normalize_business_text(NEW.personal_reference_name_snapshot), '');
    NEW.personal_reference_relation_snapshot := NULLIF(normalize_business_text(NEW.personal_reference_relation_snapshot), '');
    NEW.guarantor_name_snapshot              := NULLIF(normalize_business_text(NEW.guarantor_name_snapshot), '');
    NEW.guarantor_address_snapshot           := NULLIF(normalize_business_text(NEW.guarantor_address_snapshot), '');
    NEW.guarantor_relation_snapshot          := NULLIF(normalize_business_text(NEW.guarantor_relation_snapshot), '');
    NEW.customer_email_snapshot              := normalize_email(NEW.customer_email_snapshot);
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_credit_applications_normalize ON credit_applications;
CREATE TRIGGER trg_credit_applications_normalize
    BEFORE INSERT ON credit_applications
    FOR EACH ROW EXECUTE FUNCTION credit_applications_normalize();


-- =====================================================================
-- 5. PERMISOS CON ALCANCE PARA CONSULTAR SOLICITUDES
--
-- Decisión confirmada:
--   Vendedor       -> solo las solicitudes que creó          (credits.view.own)
--   Cobrador       -> las de SU sucursal disponibles para
--                     verificación                           (credits.view.branch)
--   Gerencia/Admin -> todas                                  (credits.view)
--
-- `credits.view` pasa a significar "todas". Vendedor y Cobrador lo tenían
-- desde 006 y les daba acceso a todas las solicitudes de todas las
-- sucursales; se les sustituye por su permiso de alcance. Solo cambia la
-- configuración de acceso: no se borra ningún dato de negocio.
-- =====================================================================
INSERT INTO permissions (code, module, name, description) VALUES
    ('credits.view',        'creditos', 'Consultar TODAS las solicitudes de crédito',
                            'Todas las sucursales y todos los creadores.'),
    ('credits.view.own',    'creditos', 'Consultar las solicitudes propias',
                            'Solo las solicitudes de crédito creadas por el propio usuario.'),
    ('credits.view.branch', 'creditos', 'Consultar las solicitudes de la propia sucursal por verificar',
                            'Solo solicitudes de la sucursal del usuario en estado SOLICITADO o EN_VERIFICACION.')
ON CONFLICT (code) DO UPDATE
    SET module = EXCLUDED.module,
        name = EXCLUDED.name,
        description = EXCLUDED.description;

-- Administración conserva acceso total.
INSERT INTO role_permissions (role_code, permission_code)
SELECT 'admin', code FROM permissions
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_code, permission_code)
SELECT r.code, p.code
  FROM (VALUES ('vendedor', 'credits.view.own'), ('cobrador', 'credits.view.branch'))
       AS v(role_code, permission_code)
  JOIN roles r ON r.code = v.role_code
  JOIN permissions p ON p.code = v.permission_code
ON CONFLICT DO NOTHING;

DELETE FROM role_permissions
 WHERE permission_code = 'credits.view'
   AND role_code IN ('vendedor', 'cobrador');


-- =====================================================================
-- 6. VISTAS DERIVADAS
--
-- Nada de esto se almacena: se calcula al consultar a partir de los datos
-- congelados de cada línea.
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
       i.created_at
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
       COALESCE(t.financing_types, '{}')                            AS financing_types
FROM credit_applications ca
JOIN branches b ON b.id = ca.branch_id
LEFT JOIN users u ON u.id = ca.created_by
LEFT JOIN LATERAL (
    SELECT COUNT(*)::int                                            AS items_count,
           SUM(i.quantity)::int                                     AS quantity_total,
           SUM(i.proposed_price * i.quantity)                       AS total,
           SUM(i.proposed_down_payment)                             AS legacy_down_payment,
           -- Cuota consolidada solo si todas las líneas comparten plazo.
           -- Con plazos mixtos el reparto del enganche es PENDIENTE DE DISEÑO.
           CASE WHEN COUNT(DISTINCT i.installments_count) = 1
                THEN MIN(i.installments_count) END                  AS installments_count,
           BOOL_OR(i.proposed_price < i.minimum_price_snapshot)     AS requires_price_exception,
           ARRAY_AGG(DISTINCT i.financing_type)                     AS financing_types
      FROM credit_application_items i
     WHERE i.credit_application_id = ca.id
) t ON TRUE;

-- =====================================================================
-- FIN 007
-- =====================================================================
