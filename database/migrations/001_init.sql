-- =====================================================================
-- 001_init.sql — Esquema base del sistema de la distribuidora
-- Motor: PostgreSQL 14+
--
-- Convenciones:
--   * Dinero:  NUMERIC(12,2)  (exacto, nunca float)
--   * Fechas de negocio: DATE  (sin hora -> sin ambigüedad de timezone)
--   * Marcas de tiempo técnicas: TIMESTAMPTZ (se guardan en UTC)
--   * Borrado lógico mediante `is_active` / `status`, nunca DELETE físico
-- =====================================================================

-- ---------------------------------------------------------------------
-- Helper: "hoy" según la zona horaria operativa del negocio.
-- Evita que una cuota se marque vencida 6 horas antes de tiempo.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_today() RETURNS date
    LANGUAGE sql STABLE
AS $$ SELECT (now() AT TIME ZONE 'America/Guatemala')::date $$;

-- ---------------------------------------------------------------------
-- Trigger genérico para mantener updated_at
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger
    LANGUAGE plpgsql
AS $$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END;
$$;

-- =====================================================================
-- USUARIOS (autenticación / autorización)
-- =====================================================================
CREATE TABLE users (
    id            BIGSERIAL PRIMARY KEY,
    username      VARCHAR(50)  NOT NULL UNIQUE,
    full_name     VARCHAR(150) NOT NULL,
    email         VARCHAR(150),
    password_hash VARCHAR(255) NOT NULL,
    role          VARCHAR(20)  NOT NULL DEFAULT 'vendedor'
                  CHECK (role IN ('admin', 'vendedor')),
    is_active     BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_users_updated
    BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- =====================================================================
-- CLIENTES
-- =====================================================================
CREATE TABLE customers (
    id            BIGSERIAL PRIMARY KEY,
    dpi           VARCHAR(13)  NOT NULL,
    full_name     VARCHAR(150) NOT NULL,
    phone         VARCHAR(20)  NOT NULL,
    phone_alt     VARCHAR(20),
    email         VARCHAR(150),
    address       TEXT         NOT NULL,
    address_ref   TEXT,                       -- punto de referencia
    -- Preparado para geolocalización / Google Maps (fase posterior)
    latitude      NUMERIC(10, 7),
    longitude     NUMERIC(10, 7),
    notes         TEXT,
    is_active     BOOLEAN      NOT NULL DEFAULT TRUE,
    created_by    BIGINT       REFERENCES users (id) ON DELETE SET NULL,
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),

    CONSTRAINT customers_dpi_format CHECK (dpi ~ '^[0-9]{13}$')
);

-- El DPI es el identificador natural del cliente: único a nivel de BD.
CREATE UNIQUE INDEX ux_customers_dpi ON customers (dpi);
-- Búsqueda rápida por nombre (la operación diaria busca por nombre o DPI)
CREATE INDEX ix_customers_name ON customers (lower(full_name));
CREATE INDEX ix_customers_phone ON customers (phone);

CREATE TRIGGER trg_customers_updated
    BEFORE UPDATE ON customers
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- =====================================================================
-- PRODUCTOS
--
-- REGLA COMERCIAL (definida por el negocio, no modificar sin autorización):
--     Contado          = costo + 30%
--     Crédito 4 pagos  = costo + 50%
--     Crédito 8 pagos  = costo + 70%
--
-- Se implementa con columnas GENERADAS: la base de datos garantiza que
-- el precio SIEMPRE respete la regla y que nunca quede desincronizado
-- del costo. El precio histórico de cada venta se congela en sale_items.
-- =====================================================================
CREATE TABLE products (
    id             BIGSERIAL PRIMARY KEY,
    code           VARCHAR(40)  NOT NULL,
    name           VARCHAR(150) NOT NULL,
    description    TEXT,
    category       VARCHAR(80)  NOT NULL DEFAULT 'General',
    brand          VARCHAR(80),
    cost           NUMERIC(12, 2) NOT NULL CHECK (cost >= 0),

    price_cash     NUMERIC(12, 2)
                   GENERATED ALWAYS AS (ROUND(cost * 1.30, 2)) STORED,
    price_credit_4 NUMERIC(12, 2)
                   GENERATED ALWAYS AS (ROUND(cost * 1.50, 2)) STORED,
    price_credit_8 NUMERIC(12, 2)
                   GENERATED ALWAYS AS (ROUND(cost * 1.70, 2)) STORED,

    stock          INTEGER      NOT NULL DEFAULT 0 CHECK (stock >= 0),
    min_stock      INTEGER      NOT NULL DEFAULT 0 CHECK (min_stock >= 0),
    is_active      BOOLEAN      NOT NULL DEFAULT TRUE,
    created_by     BIGINT       REFERENCES users (id) ON DELETE SET NULL,
    created_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX ux_products_code ON products (upper(code));
CREATE INDEX ix_products_name ON products (lower(name));
CREATE INDEX ix_products_category ON products (category);

CREATE TRIGGER trg_products_updated
    BEFORE UPDATE ON products
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- =====================================================================
-- VENTAS
-- =====================================================================
CREATE TABLE sales (
    id                 BIGSERIAL PRIMARY KEY,
    customer_id        BIGINT       NOT NULL REFERENCES customers (id) ON DELETE RESTRICT,
    sale_date          DATE         NOT NULL DEFAULT app_today(),
    payment_mode       VARCHAR(20)  NOT NULL
                       CHECK (payment_mode IN ('contado', 'credito_4', 'credito_8')),
    installments_count INTEGER      NOT NULL CHECK (installments_count >= 1),
    subtotal           NUMERIC(12, 2) NOT NULL CHECK (subtotal >= 0),
    total              NUMERIC(12, 2) NOT NULL CHECK (total >= 0),
    -- Ciclo de vida del documento. El estado FINANCIERO (pagada / pendiente /
    -- vencida) NO se almacena: se deriva de los pagos en la vista v_sales.
    status             VARCHAR(20)  NOT NULL DEFAULT 'activa'
                       CHECK (status IN ('activa', 'anulada')),
    notes              TEXT,
    created_by         BIGINT       REFERENCES users (id) ON DELETE SET NULL,
    created_at         TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ  NOT NULL DEFAULT now(),
    cancelled_at       TIMESTAMPTZ,
    cancel_reason      TEXT,

    CONSTRAINT sales_mode_installments CHECK (
        (payment_mode = 'contado'   AND installments_count = 1) OR
        (payment_mode = 'credito_4' AND installments_count = 4) OR
        (payment_mode = 'credito_8' AND installments_count = 8)
    )
);

CREATE INDEX ix_sales_customer ON sales (customer_id);
CREATE INDEX ix_sales_date ON sales (sale_date DESC);
CREATE INDEX ix_sales_status ON sales (status);

CREATE TRIGGER trg_sales_updated
    BEFORE UPDATE ON sales
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------
-- DETALLE DE VENTA (una venta puede llevar N productos)
-- Se congelan código, nombre, costo y precio al momento de la venta para
-- conservar trazabilidad histórica aunque el producto cambie después.
-- ---------------------------------------------------------------------
CREATE TABLE sale_items (
    id           BIGSERIAL PRIMARY KEY,
    sale_id      BIGINT       NOT NULL REFERENCES sales (id) ON DELETE CASCADE,
    product_id   BIGINT       NOT NULL REFERENCES products (id) ON DELETE RESTRICT,
    product_code VARCHAR(40)  NOT NULL,
    product_name VARCHAR(150) NOT NULL,
    quantity     INTEGER      NOT NULL CHECK (quantity > 0),
    unit_cost    NUMERIC(12, 2) NOT NULL CHECK (unit_cost >= 0),
    unit_price   NUMERIC(12, 2) NOT NULL CHECK (unit_price >= 0),
    line_total   NUMERIC(12, 2)
                 GENERATED ALWAYS AS (ROUND(quantity * unit_price, 2)) STORED
);

CREATE INDEX ix_sale_items_sale ON sale_items (sale_id);
CREATE INDEX ix_sale_items_product ON sale_items (product_id);

-- ---------------------------------------------------------------------
-- CUOTAS
-- Toda venta genera cuotas, incluso la de contado (1 cuota con
-- vencimiento el mismo día). Así el cálculo de saldo, estado de cuenta y
-- cobranza usa una sola maquinaria para contado y crédito.
-- ---------------------------------------------------------------------
CREATE TABLE installments (
    id         BIGSERIAL PRIMARY KEY,
    sale_id    BIGINT      NOT NULL REFERENCES sales (id) ON DELETE CASCADE,
    number     INTEGER     NOT NULL CHECK (number >= 1),
    due_date   DATE        NOT NULL,
    amount     NUMERIC(12, 2) NOT NULL CHECK (amount > 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT ux_installments_sale_number UNIQUE (sale_id, number)
);

CREATE INDEX ix_installments_due ON installments (due_date);

-- ---------------------------------------------------------------------
-- PAGOS
-- ---------------------------------------------------------------------
CREATE TABLE payments (
    id           BIGSERIAL PRIMARY KEY,
    sale_id      BIGINT      NOT NULL REFERENCES sales (id) ON DELETE RESTRICT,
    customer_id  BIGINT      NOT NULL REFERENCES customers (id) ON DELETE RESTRICT,
    payment_date DATE        NOT NULL DEFAULT app_today(),
    amount       NUMERIC(12, 2) NOT NULL CHECK (amount > 0),
    method       VARCHAR(20) NOT NULL DEFAULT 'efectivo'
                 CHECK (method IN ('efectivo', 'transferencia', 'deposito',
                                   'tarjeta', 'cheque', 'otro')),
    reference    VARCHAR(80),
    notes        TEXT,
    status       VARCHAR(20) NOT NULL DEFAULT 'aplicado'
                 CHECK (status IN ('aplicado', 'anulado')),
    created_by   BIGINT      REFERENCES users (id) ON DELETE SET NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    voided_at    TIMESTAMPTZ,
    void_reason  TEXT
);

CREATE INDEX ix_payments_sale ON payments (sale_id);
CREATE INDEX ix_payments_customer ON payments (customer_id);
CREATE INDEX ix_payments_date ON payments (payment_date DESC);

-- ---------------------------------------------------------------------
-- ASIGNACIÓN DE PAGOS A CUOTAS
-- Un pago puede cubrir parte de una cuota, una cuota completa o varias.
-- Esta tabla es la que da trazabilidad real: no guardamos un "saldo"
-- suelto, guardamos a qué cuota se aplicó cada quetzal.
-- ---------------------------------------------------------------------
CREATE TABLE payment_allocations (
    id             BIGSERIAL PRIMARY KEY,
    payment_id     BIGINT NOT NULL REFERENCES payments (id) ON DELETE CASCADE,
    installment_id BIGINT NOT NULL REFERENCES installments (id) ON DELETE RESTRICT,
    amount         NUMERIC(12, 2) NOT NULL CHECK (amount > 0),

    CONSTRAINT ux_alloc_payment_installment UNIQUE (payment_id, installment_id)
);

CREATE INDEX ix_alloc_installment ON payment_allocations (installment_id);

-- ---------------------------------------------------------------------
-- MOVIMIENTOS DE INVENTARIO (trazabilidad de stock)
-- ---------------------------------------------------------------------
CREATE TABLE stock_movements (
    id           BIGSERIAL PRIMARY KEY,
    product_id   BIGINT      NOT NULL REFERENCES products (id) ON DELETE RESTRICT,
    movement     VARCHAR(20) NOT NULL
                 CHECK (movement IN ('entrada', 'salida', 'ajuste')),
    quantity     INTEGER     NOT NULL,
    stock_after  INTEGER     NOT NULL,
    reason       VARCHAR(40) NOT NULL,
    sale_id      BIGINT      REFERENCES sales (id) ON DELETE SET NULL,
    created_by   BIGINT      REFERENCES users (id) ON DELETE SET NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX ix_stock_movements_product ON stock_movements (product_id, created_at DESC);

-- =====================================================================
-- PUENTE DE INTEGRACIÓN CON n8n (patrón OUTBOX)
--
-- La aplicación NUNCA depende de n8n para guardar información: primero
-- persiste en la BD (misma transacción) y deja el evento aquí. Un
-- despachador posterior lo envía al webhook. Si n8n está caído, el
-- evento queda pendiente y se reintenta; la operación comercial no falla.
-- =====================================================================
CREATE TABLE integration_events (
    id           BIGSERIAL PRIMARY KEY,
    event_type   VARCHAR(60) NOT NULL,       -- customer.created, sale.created, ...
    aggregate    VARCHAR(40) NOT NULL,       -- customer | sale | payment | installment
    aggregate_id BIGINT      NOT NULL,
    payload      JSONB       NOT NULL,
    status       VARCHAR(20) NOT NULL DEFAULT 'pendiente'
                 CHECK (status IN ('pendiente', 'enviado', 'fallido', 'descartado')),
    attempts     INTEGER     NOT NULL DEFAULT 0,
    last_error   TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    sent_at      TIMESTAMPTZ
);

CREATE INDEX ix_events_pending ON integration_events (status, created_at)
    WHERE status IN ('pendiente', 'fallido');

-- =====================================================================
-- VISTAS DERIVADAS  (saldos y estados SIEMPRE calculados, nunca duplicados)
-- =====================================================================

-- Estado de cada cuota
CREATE VIEW v_installments AS
SELECT i.id,
       i.sale_id,
       i.number,
       i.due_date,
       i.amount,
       COALESCE(a.paid, 0)::NUMERIC(12, 2)              AS paid_amount,
       (i.amount - COALESCE(a.paid, 0))::NUMERIC(12, 2) AS balance,
       CASE
           WHEN COALESCE(a.paid, 0) >= i.amount           THEN 'pagada'
           WHEN i.due_date < app_today()                  THEN 'vencida'
           WHEN COALESCE(a.paid, 0) > 0                   THEN 'parcial'
           ELSE 'pendiente'
       END                                              AS status,
       (app_today() - i.due_date)                       AS days_overdue
FROM installments i
LEFT JOIN (
    SELECT pa.installment_id, SUM(pa.amount) AS paid
    FROM payment_allocations pa
    JOIN payments p ON p.id = pa.payment_id AND p.status = 'aplicado'
    GROUP BY pa.installment_id
) a ON a.installment_id = i.id;

-- Venta con su situación financiera completa
CREATE VIEW v_sales AS
SELECT s.id,
       'V-' || LPAD(s.id::text, 6, '0')                    AS sale_number,
       s.customer_id,
       c.full_name                                         AS customer_name,
       c.dpi                                               AS customer_dpi,
       c.phone                                             AS customer_phone,
       s.sale_date,
       s.payment_mode,
       s.installments_count,
       s.subtotal,
       s.total,
       s.status,
       s.notes,
       s.created_at,
       COALESCE(pg.paid, 0)::NUMERIC(12, 2)                AS paid_amount,
       (s.total - COALESCE(pg.paid, 0))::NUMERIC(12, 2)    AS balance,
       COALESCE(iv.paid_count, 0)                          AS installments_paid,
       COALESCE(iv.pending_count, 0)                       AS installments_pending,
       COALESCE(iv.overdue_count, 0)                       AS installments_overdue,
       iv.next_due_date,
       iv.next_due_amount,
       CASE
           WHEN s.status = 'anulada'                       THEN 'anulada'
           WHEN COALESCE(pg.paid, 0) >= s.total            THEN 'pagada'
           WHEN COALESCE(iv.overdue_count, 0) > 0          THEN 'vencida'
           WHEN COALESCE(pg.paid, 0) > 0                   THEN 'al_dia'
           ELSE 'pendiente'
       END                                                 AS account_status
FROM sales s
JOIN customers c ON c.id = s.customer_id
LEFT JOIN (
    SELECT sale_id, SUM(amount) AS paid
    FROM payments
    WHERE status = 'aplicado'
    GROUP BY sale_id
) pg ON pg.sale_id = s.id
LEFT JOIN (
    SELECT sale_id,
           COUNT(*) FILTER (WHERE status = 'pagada')                       AS paid_count,
           COUNT(*) FILTER (WHERE status <> 'pagada')                      AS pending_count,
           COUNT(*) FILTER (WHERE status = 'vencida')                      AS overdue_count,
           MIN(due_date) FILTER (WHERE status <> 'pagada')                 AS next_due_date,
           MIN(balance)  FILTER (WHERE status <> 'pagada')                 AS next_due_amount
    FROM v_installments
    GROUP BY sale_id
) iv ON iv.sale_id = s.id;

-- Estado de cuenta consolidado por cliente
CREATE VIEW v_customer_accounts AS
SELECT c.id                                              AS customer_id,
       c.dpi,
       c.full_name,
       c.phone,
       c.is_active,
       COUNT(vs.id) FILTER (WHERE vs.status = 'activa')  AS sales_count,
       COALESCE(SUM(vs.total)   FILTER (WHERE vs.status = 'activa'), 0)::NUMERIC(12, 2) AS total_sold,
       COALESCE(SUM(vs.paid_amount) FILTER (WHERE vs.status = 'activa'), 0)::NUMERIC(12, 2) AS total_paid,
       COALESCE(SUM(vs.balance) FILTER (WHERE vs.status = 'activa'), 0)::NUMERIC(12, 2) AS total_balance,
       COALESCE(SUM(vs.installments_overdue) FILTER (WHERE vs.status = 'activa'), 0)   AS overdue_installments,
       MIN(vs.next_due_date) FILTER (WHERE vs.status = 'activa' AND vs.balance > 0)    AS next_due_date
FROM customers c
LEFT JOIN v_sales vs ON vs.customer_id = c.id
GROUP BY c.id, c.dpi, c.full_name, c.phone, c.is_active;
