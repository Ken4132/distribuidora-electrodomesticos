-- ============================================================
-- MIGRATION 005: CREDIT SYSTEM
-- Distribuidora de electrodomésticos
--
-- Objetivo:
--   Implementar el flujo de solicitudes de crédito, planes de
--   financiamiento, verificaciones y decisiones de crédito.
--
-- Principios:
--   - No elimina información existente.
--   - La solicitud de crédito es independiente de la venta.
--   - Las condiciones comerciales de una solicitud se congelan.
--   - Las verificaciones y decisiones son históricas.
--   - Las cuotas continúan utilizando la estructura existente.
-- ============================================================


-- ============================================================
-- 1. SALES: RELACIÓN CON SUCURSAL
-- ============================================================

ALTER TABLE sales
    ADD COLUMN IF NOT EXISTS branch_id INTEGER;

ALTER TABLE sales
    DROP CONSTRAINT IF EXISTS sales_branch_id_fkey;

ALTER TABLE sales
    ADD CONSTRAINT sales_branch_id_fkey
    FOREIGN KEY (branch_id)
    REFERENCES branches(id)
    ON UPDATE CASCADE
    ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS idx_sales_branch_id
    ON sales(branch_id);

-- ============================================================
-- 2. PLANES DE FINANCIAMIENTO POR PRODUCTO
-- ============================================================
--
-- Un producto puede ofrecer diferentes plazos predefinidos.
--
-- Ejemplo:
--   producto X -> 4, 6, 10 y 12 meses
--
-- El porcentaje de financiamiento y el precio mínimo comercial
-- quedan registrados en este plan.
--
-- Los planes especiales NO necesitan existir aquí.
-- ============================================================

CREATE TABLE IF NOT EXISTS product_financing_plans (
    id SERIAL PRIMARY KEY,

    product_id INTEGER NOT NULL
        REFERENCES products(id)
        ON UPDATE CASCADE
        ON DELETE RESTRICT,

    installments_count INTEGER NOT NULL,

    financing_percentage NUMERIC(7,2) NOT NULL,

    minimum_price NUMERIC(12,2) NOT NULL,

    minimum_installment NUMERIC(12,2) NOT NULL,

    is_active BOOLEAN NOT NULL DEFAULT TRUE,

    created_by INTEGER NOT NULL
        REFERENCES users(id)
        ON UPDATE CASCADE
        ON DELETE RESTRICT,

    updated_by INTEGER
        REFERENCES users(id)
        ON UPDATE CASCADE
        ON DELETE RESTRICT,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT product_financing_plans_installments_positive
        CHECK (installments_count > 0),

    CONSTRAINT product_financing_plans_percentage_nonnegative
        CHECK (financing_percentage >= 0),

    CONSTRAINT product_financing_plans_minimum_price_nonnegative
        CHECK (minimum_price >= 0),

    CONSTRAINT product_financing_plans_minimum_installment_nonnegative
        CHECK (minimum_installment >= 0),

    CONSTRAINT product_financing_plans_product_term_unique
        UNIQUE (product_id, installments_count)
);

CREATE INDEX IF NOT EXISTS idx_product_financing_plans_product
    ON product_financing_plans(product_id);

CREATE INDEX IF NOT EXISTS idx_product_financing_plans_active
    ON product_financing_plans(is_active);

-- ============================================================
-- 3. SOLICITUDES DE CRÉDITO
-- ============================================================
--
-- Representa el expediente de una solicitud.
--
-- IMPORTANTE:
--   Una solicitud NO representa dinero recibido.
--   Una solicitud NO genera saldo.
--   Una solicitud NO genera cuotas activas.
--   Una solicitud aprobada solamente puede convertirse
--   posteriormente en una venta.
-- ============================================================

CREATE TABLE IF NOT EXISTS credit_applications (
    id SERIAL PRIMARY KEY,

    application_number BIGINT NOT NULL UNIQUE,

    customer_id INTEGER NOT NULL
        REFERENCES customers(id)
        ON UPDATE CASCADE
        ON DELETE RESTRICT,

    branch_id INTEGER NOT NULL
        REFERENCES branches(id)
        ON UPDATE CASCADE
        ON DELETE RESTRICT,

    created_by INTEGER NOT NULL
        REFERENCES users(id)
        ON UPDATE CASCADE
        ON DELETE RESTRICT,

    -- ========================================================
    -- Snapshot de información personal
    -- ========================================================

    customer_dpi_snapshot VARCHAR(32) NOT NULL,
    customer_full_name_snapshot VARCHAR(200) NOT NULL,
    customer_phone_snapshot VARCHAR(50) NOT NULL,
    customer_phone_alt_snapshot VARCHAR(50),
    customer_email_snapshot VARCHAR(255),

    customer_address_snapshot TEXT NOT NULL,
    customer_address_ref_snapshot TEXT,

    customer_municipality_snapshot VARCHAR(120),
    customer_department_snapshot VARCHAR(120),

    housing_type_snapshot VARCHAR(100),
    residence_time_snapshot VARCHAR(100),

    -- ========================================================
    -- Snapshot de información laboral
    -- ========================================================

    employer_name_snapshot VARCHAR(200),
    employer_address_snapshot TEXT,
    employer_phone_snapshot VARCHAR(50),
    employment_time_snapshot VARCHAR(100),
    job_position_snapshot VARCHAR(150),
    monthly_income_snapshot NUMERIC(12,2),

    labor_reference_name_snapshot VARCHAR(200),
    labor_reference_phone_snapshot VARCHAR(50),
    labor_reference_relation_snapshot VARCHAR(100),

    -- ========================================================
    -- Snapshot de referencia personal
    -- ========================================================

    personal_reference_name_snapshot VARCHAR(200),
    personal_reference_phone_snapshot VARCHAR(50),
    personal_reference_relation_snapshot VARCHAR(100),

    -- ========================================================
    -- Snapshot de garante / fiador
    -- ========================================================

    guarantor_name_snapshot VARCHAR(200),
    guarantor_dpi_snapshot VARCHAR(32),
    guarantor_phone_snapshot VARCHAR(50),
    guarantor_address_snapshot TEXT,
    guarantor_relation_snapshot VARCHAR(100),

    -- ========================================================
    -- Estado y flujo
    -- ========================================================

    status VARCHAR(40) NOT NULL DEFAULT 'SOLICITADO',

    submitted_at TIMESTAMPTZ,

    -- ========================================================
    -- Solicitud de corrección
    -- ========================================================

    correction_requested BOOLEAN NOT NULL DEFAULT FALSE,
    correction_reason TEXT,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT credit_applications_status_check
        CHECK (
            status IN (
                'SOLICITADO',
                'EN_VERIFICACION',
                'EN_EVALUACION',
                'APROBADO',
                'VENTA_CONCRETADA',
                'ACTIVO',
                'RECHAZADO',
                'CANCELADO'
            )
        ),

    CONSTRAINT credit_applications_income_nonnegative
        CHECK (
            monthly_income_snapshot IS NULL
            OR monthly_income_snapshot >= 0
        )
);

CREATE INDEX IF NOT EXISTS idx_credit_applications_customer
    ON credit_applications(customer_id);

CREATE INDEX IF NOT EXISTS idx_credit_applications_branch
    ON credit_applications(branch_id);

CREATE INDEX IF NOT EXISTS idx_credit_applications_status
    ON credit_applications(status);

CREATE INDEX IF NOT EXISTS idx_credit_applications_created_by
    ON credit_applications(created_by);

CREATE INDEX IF NOT EXISTS idx_credit_applications_created_at
    ON credit_applications(created_at);

-- ============================================================
-- 4. PRODUCTOS SOLICITADOS
-- ============================================================
--
-- Una solicitud puede contener uno o más productos.
--
-- Toda la información comercial relevante se congela aquí.
-- ============================================================

CREATE TABLE IF NOT EXISTS credit_application_items (
    id SERIAL PRIMARY KEY,

    credit_application_id INTEGER NOT NULL
        REFERENCES credit_applications(id)
        ON UPDATE CASCADE
        ON DELETE RESTRICT,

    product_id INTEGER NOT NULL
        REFERENCES products(id)
        ON UPDATE CASCADE
        ON DELETE RESTRICT,

    quantity INTEGER NOT NULL DEFAULT 1,

    -- ========================================================
    -- Snapshot del producto
    -- ========================================================

    product_code_snapshot VARCHAR(100) NOT NULL,
    product_name_snapshot VARCHAR(200) NOT NULL,

    cost_snapshot NUMERIC(12,2) NOT NULL,

    -- ========================================================
    -- Condiciones financieras
    -- ========================================================

    financing_type VARCHAR(20) NOT NULL,

    installments_count INTEGER NOT NULL,

    financing_percentage_snapshot NUMERIC(7,2) NOT NULL,

    minimum_price_snapshot NUMERIC(12,2) NOT NULL,

    minimum_installment_snapshot NUMERIC(12,2) NOT NULL,

    proposed_price NUMERIC(12,2) NOT NULL,

    proposed_installment NUMERIC(12,2) NOT NULL,

    proposed_down_payment NUMERIC(12,2) NOT NULL DEFAULT 0,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT credit_application_items_quantity_positive
        CHECK (quantity > 0),

    CONSTRAINT credit_application_items_financing_type_check
        CHECK (
            financing_type IN (
                'PREDEFINIDO',
                'ESPECIAL'
            )
        ),

    CONSTRAINT credit_application_items_installments_positive
        CHECK (installments_count > 0),

    CONSTRAINT credit_application_items_cost_nonnegative
        CHECK (cost_snapshot >= 0),

    CONSTRAINT credit_application_items_percentage_nonnegative
        CHECK (financing_percentage_snapshot >= 0),

    CONSTRAINT credit_application_items_min_price_nonnegative
        CHECK (minimum_price_snapshot >= 0),

    CONSTRAINT credit_application_items_min_installment_nonnegative
        CHECK (minimum_installment_snapshot >= 0),

    CONSTRAINT credit_application_items_proposed_price_nonnegative
        CHECK (proposed_price >= 0),

    CONSTRAINT credit_application_items_proposed_installment_nonnegative
        CHECK (proposed_installment >= 0),

    CONSTRAINT credit_application_items_down_payment_nonnegative
        CHECK (proposed_down_payment >= 0)
);

CREATE INDEX IF NOT EXISTS idx_credit_application_items_application
    ON credit_application_items(credit_application_id);

CREATE INDEX IF NOT EXISTS idx_credit_application_items_product
    ON credit_application_items(product_id);

-- ============================================================
-- 5. VERIFICACIONES HISTÓRICAS
-- ============================================================
--
-- El Cobrador puede realizar múltiples verificaciones.
-- Cada intento permanece almacenado.
-- ============================================================

CREATE TABLE IF NOT EXISTS credit_verifications (
    id SERIAL PRIMARY KEY,

    credit_application_id INTEGER NOT NULL
        REFERENCES credit_applications(id)
        ON UPDATE CASCADE
        ON DELETE RESTRICT,

    verified_by INTEGER NOT NULL
        REFERENCES users(id)
        ON UPDATE CASCADE
        ON DELETE RESTRICT,

    verification_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- ========================================================
    -- Resultado general
    -- ========================================================

    result VARCHAR(30) NOT NULL,

    -- ========================================================
    -- Checklist
    -- ========================================================

    address_matches VARCHAR(20) NOT NULL,
    housing_verified VARCHAR(20) NOT NULL,
    residence_time_matches VARCHAR(20) NOT NULL,

    employment_verified VARCHAR(20),
    labor_reference_confirmed VARCHAR(20),
    personal_reference_confirmed VARCHAR(20),

    -- ========================================================
    -- Observaciones y recomendación
    -- ========================================================

    comments TEXT,

    recommendation VARCHAR(30) NOT NULL,

    -- ========================================================
    -- Coordenadas de verificación
    -- ========================================================

    latitude NUMERIC(10,7),
    longitude NUMERIC(10,7),

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT credit_verifications_result_check
        CHECK (
            result IN (
                'FAVORABLE',
                'DESFAVORABLE',
                'NECESITA_REVISION'
            )
        ),

    CONSTRAINT credit_verifications_recommendation_check
        CHECK (
            recommendation IN (
                'FAVORABLE',
                'DESFAVORABLE',
                'NECESITA_REVISION'
            )
        ),

    CONSTRAINT credit_verifications_address_check
        CHECK (
            address_matches IN (
                'SI',
                'NO',
                'NO_VERIFICABLE'
            )
        ),

    CONSTRAINT credit_verifications_housing_check
        CHECK (
            housing_verified IN (
                'SI',
                'NO',
                'NO_VERIFICABLE'
            )
        ),

    CONSTRAINT credit_verifications_residence_check
        CHECK (
            residence_time_matches IN (
                'SI',
                'NO',
                'NO_VERIFICABLE'
            )
        ),

    CONSTRAINT credit_verifications_employment_check
        CHECK (
            employment_verified IS NULL
            OR employment_verified IN (
                'SI',
                'NO',
                'NO_VERIFICABLE'
            )
        ),

    CONSTRAINT credit_verifications_labor_reference_check
        CHECK (
            labor_reference_confirmed IS NULL
            OR labor_reference_confirmed IN (
                'SI',
                'NO',
                'NO_VERIFICABLE'
            )
        ),

    CONSTRAINT credit_verifications_personal_reference_check
        CHECK (
            personal_reference_confirmed IS NULL
            OR personal_reference_confirmed IN (
                'SI',
                'NO',
                'NO_VERIFICABLE'
            )
        ),

    CONSTRAINT credit_verifications_latitude_check
        CHECK (
            latitude IS NULL
            OR latitude BETWEEN -90 AND 90
        ),

    CONSTRAINT credit_verifications_longitude_check
        CHECK (
            longitude IS NULL
            OR longitude BETWEEN -180 AND 180
        )
);

CREATE INDEX IF NOT EXISTS idx_credit_verifications_application
    ON credit_verifications(credit_application_id);

CREATE INDEX IF NOT EXISTS idx_credit_verifications_user
    ON credit_verifications(verified_by);

CREATE INDEX IF NOT EXISTS idx_credit_verifications_date
    ON credit_verifications(verification_date);

-- ============================================================
-- 6. DECISIONES DE CRÉDITO
-- ============================================================
--
-- Admin o Gerencia pueden tomar la decisión.
--
-- La autorización excepcional de precio queda registrada
-- dentro de la misma decisión y además podrá ser auditada.
-- ============================================================

CREATE TABLE IF NOT EXISTS credit_decisions (
    id SERIAL PRIMARY KEY,

    credit_application_id INTEGER NOT NULL
        REFERENCES credit_applications(id)
        ON UPDATE CASCADE
        ON DELETE RESTRICT,

    decided_by INTEGER NOT NULL
        REFERENCES users(id)
        ON UPDATE CASCADE
        ON DELETE RESTRICT,

    decision VARCHAR(20) NOT NULL,

    decision_comment TEXT,

    -- ========================================================
    -- Excepción comercial
    -- ========================================================

    exceptional_price_authorized BOOLEAN NOT NULL DEFAULT FALSE,

    exceptional_price NUMERIC(12,2),

    exceptional_price_reason TEXT,

    decision_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT credit_decisions_decision_check
        CHECK (
            decision IN (
                'APROBADO',
                'RECHAZADO'
            )
        ),

    CONSTRAINT credit_decisions_exceptional_price_check
        CHECK (
            exceptional_price IS NULL
            OR exceptional_price >= 0
        ),

    CONSTRAINT credit_decisions_exceptional_price_reason_check
        CHECK (
            exceptional_price_authorized = FALSE
            OR (
                exceptional_price IS NOT NULL
                AND exceptional_price_reason IS NOT NULL
                AND LENGTH(TRIM(exceptional_price_reason)) > 0
            )
        )
);

CREATE INDEX IF NOT EXISTS idx_credit_decisions_application
    ON credit_decisions(credit_application_id);

CREATE INDEX IF NOT EXISTS idx_credit_decisions_user
    ON credit_decisions(decided_by);

CREATE INDEX IF NOT EXISTS idx_credit_decisions_date
    ON credit_decisions(decision_date);

-- ============================================================
-- 7. TRIGGERS updated_at
-- ============================================================

DROP TRIGGER IF EXISTS trg_product_financing_plans_updated_at
    ON product_financing_plans;

CREATE TRIGGER trg_product_financing_plans_updated_at
BEFORE UPDATE ON product_financing_plans
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_credit_applications_updated_at
    ON credit_applications;

CREATE TRIGGER trg_credit_applications_updated_at
BEFORE UPDATE ON credit_applications
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

-- ============================================================
-- 8. SECUENCIA DE SOLICITUDES
-- ============================================================
--
-- application_number es independiente del ID interno.
-- ============================================================

CREATE SEQUENCE IF NOT EXISTS credit_application_number_seq
    START WITH 1
    INCREMENT BY 1;

ALTER TABLE credit_applications
    ALTER COLUMN application_number
    SET DEFAULT nextval('credit_application_number_seq');

-- ============================================================
-- 9. VISTA DEL BURÓ INTERNO DE SOLICITUDES RECHAZADAS
-- ============================================================
--
-- No duplicamos solicitudes rechazadas en otra tabla.
-- Se conserva la solicitud y sus decisiones como historial.
-- Esta vista facilita la consulta interna.
-- ============================================================

CREATE OR REPLACE VIEW v_rejected_credit_applications AS
SELECT
    ca.id,
    ca.application_number,
    ca.customer_id,
    ca.customer_dpi_snapshot,
    ca.customer_full_name_snapshot,
    ca.branch_id,
    ca.created_by,
    ca.created_at,
    cd.id AS decision_id,
    cd.decided_by,
    cd.decision_date,
    cd.decision_comment,
    cd.exceptional_price_authorized
FROM credit_applications ca
JOIN LATERAL (
    SELECT
        d.id,
        d.decided_by,
        d.decision_date,
        d.decision_comment,
        d.exceptional_price_authorized,
        d.decision
    FROM credit_decisions d
    WHERE d.credit_application_id = ca.id
    ORDER BY d.decision_date DESC, d.id DESC
    LIMIT 1
) cd ON TRUE
WHERE ca.status = 'RECHAZADO'
  AND cd.decision = 'RECHAZADO';
