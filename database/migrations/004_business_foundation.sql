-- =====================================================================
-- 004_business_foundation.sql — BLOQUE 2A: fundación empresarial
--
-- Qué añade:
--   2A.1  Normalización canónica de los datos textuales de negocio
--   2A.2  Sucursales
--   2A.3  Usuario -> sucursal
--   2A.4  Inventario por sucursal (compatible con products.stock)
--   2A.5  Categorías y marcas como entidades
--   2A.6  Histórico de costos de productos
--
-- Qué NO hace:
--   * No toca 001, 002 ni 003.
--   * No cambia el flujo de ventas: `sales`, `sale_items`, `installments`,
--     `payments` y `payment_allocations` quedan exactamente igual.
--   * No borra `products.stock`, `products.category` ni `products.brand`.
--   * No implementa nada de créditos, cobranza, pagos ni reportes.
--
-- El runner (backend/src/scripts/migrate.js) ya envuelve cada archivo en
-- BEGIN/COMMIT, por eso aquí no hay transacción propia.
-- =====================================================================


-- =====================================================================
-- 1. NORMALIZACIÓN CANÓNICA
--
--     MAYÚSCULAS + SIN TILDES + ESPACIOS NORMALIZADOS + TRIM
--
--     '   José   López Álvarez  '  ->  'JOSE LOPEZ ALVAREZ'
--
-- Decisiones:
--
--   * La Ñ SE CONSERVA. En español la eñe es una letra propia, no un
--     diacrítico: colapsarla haría que "PEÑA" y "PENA" fueran el mismo
--     apellido. Se quitan tildes y diéresis; la eñe se queda.
--
--   * No se usa la extensión `unaccent`. `translate()` es IMMUTABLE (sirve
--     para índices), no exige privilegios para crear extensiones y cubre
--     exactamente el juego de caracteres del español. Una dependencia menos
--     que pueda fallar en la instalación del cliente.
--
--   * La aplicación normaliza en el backend (utils/normalize.js). Esta
--     función es la MISMA regla escrita en SQL y cumple dos papeles: red de
--     seguridad en los triggers (ningún camino se escapa) y base de los
--     índices únicos de categorías y marcas.
-- =====================================================================
CREATE OR REPLACE FUNCTION normalize_business_text(txt text) RETURNS text
    LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$
    -- ORDEN DE LAS OPERACIONES, y no es indiferente:
    --
    --   1. el espacio duro (U+00A0) pasa a espacio normal — llega
    --      constantemente al pegar texto desde Word y ni btrim ni \s lo
    --      reconocen;
    --   2. se colapsa cualquier racha de espacios en blanco a un espacio;
    --   3. SOLO ENTONCES se recortan los extremos.
    --
    -- btrim() sin segundo argumento recorta únicamente el espacio U+0020:
    -- si se recortara antes de colapsar, un tabulador o un salto de línea
    -- al final sobrevivirían al recorte y se convertirían después en un
    -- espacio final. Se comprobó con 3.000 cadenas aleatorias contra la
    -- implementación de JavaScript.
    SELECT CASE WHEN txt IS NULL THEN NULL ELSE
        upper(
            translate(
                btrim(regexp_replace(replace(txt, U&'\00A0', ' '), '\s+', ' ', 'g')),
                'áàäâãéèëêíìïîóòöôõúùüûçñÁÀÄÂÃÉÈËÊÍÌÏÎÓÒÖÔÕÚÙÜÛÇ',
                'aaaaaeeeeiiiiooooouuuucÑAAAAAEEEEIIIIOOOOOUUUUC'
            )
        )
    END
$$;

COMMENT ON FUNCTION normalize_business_text(text) IS
    'Representación canónica de un texto de negocio: mayúsculas, sin tildes, espacios colapsados y sin extremos. Conserva la Ñ.';

/**
 * Normalización de correo: los buzones no distinguen mayúsculas en la
 * práctica, pero MAYÚSCULAS sería incorrecto. Minúsculas y sin espacios.
 */
CREATE OR REPLACE FUNCTION normalize_email(txt text) RETURNS text
    LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$
    SELECT CASE
        WHEN txt IS NULL THEN NULL
        WHEN btrim(txt) = '' THEN NULL
        ELSE lower(btrim(txt))
    END
$$;


-- =====================================================================
-- 2. SUCURSALES
--
-- La primera instalación opera con una sola sucursal, pero el modelo
-- admite N desde el primer día: el inventario, los usuarios y los
-- movimientos ya cuelgan de ella.
-- =====================================================================
CREATE TABLE IF NOT EXISTS branches (
    id          BIGSERIAL    PRIMARY KEY,
    code        VARCHAR(20)  NOT NULL,
    name        VARCHAR(120) NOT NULL,
    address     TEXT,
    phone       VARCHAR(20),
    -- Sucursal a la que se imputa todo movimiento que todavía no declara
    -- sucursal (ver la sección de inventario). Solo puede haber una.
    is_default  BOOLEAN      NOT NULL DEFAULT FALSE,
    is_active   BOOLEAN      NOT NULL DEFAULT TRUE,
    notes       TEXT,
    created_by  BIGINT       REFERENCES users (id) ON DELETE SET NULL,
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),

    CONSTRAINT branches_code_format CHECK (code ~ '^[A-Z0-9_-]{2,20}$')
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_branches_code ON branches (code);
CREATE UNIQUE INDEX IF NOT EXISTS ux_branches_name ON branches (normalize_business_text(name));
-- Exactamente una sucursal predeterminada.
CREATE UNIQUE INDEX IF NOT EXISTS ux_branches_default ON branches (is_default) WHERE is_default;

DROP TRIGGER IF EXISTS trg_branches_updated ON branches;
CREATE TRIGGER trg_branches_updated
    BEFORE UPDATE ON branches
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Normaliza nombre y dirección igual que el resto del sistema.
CREATE OR REPLACE FUNCTION branches_normalize() RETURNS trigger
    LANGUAGE plpgsql
AS $$
BEGIN
    NEW.code    := upper(btrim(NEW.code));
    NEW.name    := normalize_business_text(NEW.name);
    NEW.address := normalize_business_text(NEW.address);
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_branches_normalize ON branches;
CREATE TRIGGER trg_branches_normalize
    BEFORE INSERT OR UPDATE ON branches
    FOR EACH ROW EXECUTE FUNCTION branches_normalize();

-- ---------------------------------------------------------------------
-- Sucursal inicial.
--
-- NO es una sucursal real inventada: es el ancla de compatibilidad a la
-- que se imputa todo lo que existía antes de que el sistema supiera de
-- sucursales. El administrador debe renombrarla con el nombre real de su
-- local desde la pantalla de Sucursales; el código puede quedarse.
-- ---------------------------------------------------------------------
INSERT INTO branches (code, name, is_default, notes)
VALUES ('PRINCIPAL', 'SUCURSAL PRINCIPAL', TRUE,
        'Sucursal inicial creada por la migración 004 para dar destino al inventario y a los movimientos anteriores al control por sucursal. Renómbrala con el nombre real del local.')
ON CONFLICT (code) DO NOTHING;


-- =====================================================================
-- 3. USUARIO -> SUCURSAL
--
-- Nullable a propósito: la migración NO asigna sucursal a los usuarios
-- existentes. Inventar a qué local pertenece cada quien sería inventar
-- información de la empresa. El administrador los asigna desde la pantalla
-- de Usuarios.
--
-- NO se toca `users.role` ni el sistema de roles del bloque 1.
-- =====================================================================
ALTER TABLE users ADD COLUMN IF NOT EXISTS branch_id BIGINT
    REFERENCES branches (id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS ix_users_branch ON users (branch_id);

COMMENT ON COLUMN users.branch_id IS
    'Sucursal a la que pertenece el usuario. NULL = sin asignar (el administrador la asigna).';


-- =====================================================================
-- 4. CATEGORÍAS Y MARCAS
--
-- Hoy son texto suelto en `products`: nada impide "CAMA", "Cama" y "cama"
-- como tres categorías distintas. Se convierten en entidades con unicidad
-- sobre la forma normalizada.
--
-- COMPATIBILIDAD: las columnas `products.category` y `products.brand` NO
-- se eliminan. Siguen existiendo, siguen siendo las que leen el modelo, el
-- servicio y el frontend actuales, y un trigger las mantiene sincronizadas
-- con la entidad. Así el catálogo no se rompe mientras se migra.
-- =====================================================================
CREATE TABLE IF NOT EXISTS categories (
    id          BIGSERIAL    PRIMARY KEY,
    name        VARCHAR(80)  NOT NULL,
    description TEXT,
    is_active   BOOLEAN      NOT NULL DEFAULT TRUE,
    created_by  BIGINT       REFERENCES users (id) ON DELETE SET NULL,
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- La unicidad se define sobre la forma normalizada, no sobre el texto: es
-- lo que impide que entren CAMA / Cama / cama como tres filas.
CREATE UNIQUE INDEX IF NOT EXISTS ux_categories_name
    ON categories (normalize_business_text(name));

CREATE TABLE IF NOT EXISTS brands (
    id          BIGSERIAL    PRIMARY KEY,
    name        VARCHAR(80)  NOT NULL,
    description TEXT,
    is_active   BOOLEAN      NOT NULL DEFAULT TRUE,
    created_by  BIGINT       REFERENCES users (id) ON DELETE SET NULL,
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_brands_name
    ON brands (normalize_business_text(name));

DROP TRIGGER IF EXISTS trg_categories_updated ON categories;
CREATE TRIGGER trg_categories_updated
    BEFORE UPDATE ON categories FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_brands_updated ON brands;
CREATE TRIGGER trg_brands_updated
    BEFORE UPDATE ON brands FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- El nombre se guarda ya normalizado: lo que se ve en pantalla y lo que
-- se compara son el mismo valor, sin columnas duplicadas.
CREATE OR REPLACE FUNCTION taxonomy_normalize() RETURNS trigger
    LANGUAGE plpgsql
AS $$
BEGIN
    NEW.name := normalize_business_text(NEW.name);
    IF NEW.name IS NULL OR NEW.name = '' THEN
        RAISE EXCEPTION 'El nombre no puede quedar vacío después de normalizarlo'
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_categories_normalize ON categories;
CREATE TRIGGER trg_categories_normalize
    BEFORE INSERT OR UPDATE ON categories FOR EACH ROW EXECUTE FUNCTION taxonomy_normalize();

DROP TRIGGER IF EXISTS trg_brands_normalize ON brands;
CREATE TRIGGER trg_brands_normalize
    BEFORE INSERT OR UPDATE ON brands FOR EACH ROW EXECUTE FUNCTION taxonomy_normalize();

-- ---------------------------------------------------------------------
-- Backfill desde el catálogo existente: una categoría por cada valor
-- distinto YA NORMALIZADO. Si el catálogo tenía "Cama" y "CAMA", sale una
-- sola fila.
-- ---------------------------------------------------------------------
INSERT INTO categories (name)
SELECT DISTINCT normalize_business_text(category)
  FROM products
 WHERE category IS NOT NULL
   AND normalize_business_text(category) <> ''
ON CONFLICT (normalize_business_text(name)) DO NOTHING;

INSERT INTO brands (name)
SELECT DISTINCT normalize_business_text(brand)
  FROM products
 WHERE brand IS NOT NULL
   AND normalize_business_text(brand) <> ''
ON CONFLICT (normalize_business_text(name)) DO NOTHING;

-- Llaves foráneas en el producto. Nullable: un producto puede quedarse sin
-- marca, y la categoría se resuelve en el backfill de abajo.
ALTER TABLE products ADD COLUMN IF NOT EXISTS category_id BIGINT
    REFERENCES categories (id) ON DELETE RESTRICT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS brand_id BIGINT
    REFERENCES brands (id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS ix_products_category_id ON products (category_id);
CREATE INDEX IF NOT EXISTS ix_products_brand_id ON products (brand_id);

UPDATE products p
   SET category_id = c.id
  FROM categories c
 WHERE p.category_id IS NULL
   AND normalize_business_text(c.name) = normalize_business_text(p.category);

UPDATE products p
   SET brand_id = b.id
  FROM brands b
 WHERE p.brand_id IS NULL
   AND p.brand IS NOT NULL
   AND normalize_business_text(b.name) = normalize_business_text(p.brand);


-- =====================================================================
-- 5. NORMALIZACIÓN DE CLIENTES Y PRODUCTOS
--
-- La aplicación normaliza en el backend, como exige el bloque. Estos
-- triggers son la red de seguridad: garantizan que ningún camino (un
-- script, una carga masiva, psql) deje datos sin normalizar.
--
-- QUÉ SE NORMALIZA: todo dato de negocio escrito libremente por el usuario.
-- En clientes: nombre, dirección, referencia, municipio, departamento y
-- notas. En productos: nombre, categoría, marca y descripción.
--
-- QUÉ NO, porque tienen reglas propias: el correo (minúsculas), el nombre
-- de usuario, la contraseña, el teléfono, el DPI y cualquier código técnico
-- de rol, permiso o identificador interno. Ver utils/normalize.js.
-- =====================================================================
-- ---------------------------------------------------------------------
-- Municipio y departamento del cliente.
--
-- La dirección venía como un único bloque de texto. Separarlos permite
-- agrupar y filtrar la cartera por zona, y es la base sobre la que después
-- se puede colgar la geolocalización que ya prevé el esquema de 001
-- (`latitude` / `longitude`). Ambos son opcionales: no se inventa el
-- municipio de los clientes que ya existen.
-- ---------------------------------------------------------------------
ALTER TABLE customers ADD COLUMN IF NOT EXISTS municipality VARCHAR(80);
ALTER TABLE customers ADD COLUMN IF NOT EXISTS department   VARCHAR(80);

CREATE INDEX IF NOT EXISTS ix_customers_municipality ON customers (municipality);
CREATE INDEX IF NOT EXISTS ix_customers_department   ON customers (department);

CREATE OR REPLACE FUNCTION customers_normalize() RETURNS trigger
    LANGUAGE plpgsql
AS $$
BEGIN
    NEW.full_name    := normalize_business_text(NEW.full_name);
    NEW.address      := normalize_business_text(NEW.address);
    -- Los opcionales que quedan en blanco se guardan como NULL, no como ''.
    NEW.address_ref  := NULLIF(normalize_business_text(NEW.address_ref), '');
    NEW.municipality := NULLIF(normalize_business_text(NEW.municipality), '');
    NEW.department   := NULLIF(normalize_business_text(NEW.department), '');
    NEW.notes        := NULLIF(normalize_business_text(NEW.notes), '');
    NEW.email        := normalize_email(NEW.email);
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_customers_normalize ON customers;
CREATE TRIGGER trg_customers_normalize
    BEFORE INSERT OR UPDATE ON customers
    FOR EACH ROW EXECUTE FUNCTION customers_normalize();

/**
 * Productos: además de normalizar, sincroniza el texto con la entidad.
 * Si el producto declara `category_id`, la columna `category` pasa a ser
 * un reflejo del nombre de esa categoría. Así nunca se contradicen.
 * Si no lo declara, al menos el texto queda normalizado.
 *
 * No crea categorías ni marcas por su cuenta: dar de alta una taxonomía
 * es una decisión del administrador, no un efecto colateral de guardar un
 * producto.
 */
-- ---------------------------------------------------------------------
-- Modelo del producto.
--
-- El catálogo tenía código, nombre, categoría y marca, pero no modelo, y
-- en electrodomésticos el modelo es justo lo que distingue dos productos
-- de la misma marca. Opcional: no se inventa el modelo de lo ya cargado.
-- ---------------------------------------------------------------------
ALTER TABLE products ADD COLUMN IF NOT EXISTS model VARCHAR(80);

CREATE INDEX IF NOT EXISTS ix_products_model ON products (normalize_business_text(model));

CREATE OR REPLACE FUNCTION products_normalize() RETURNS trigger
    LANGUAGE plpgsql
AS $$
DECLARE
    v_name text;
BEGIN
    NEW.code        := upper(btrim(NEW.code));
    NEW.name        := normalize_business_text(NEW.name);
    NEW.brand       := NULLIF(normalize_business_text(NEW.brand), '');
    NEW.model       := NULLIF(normalize_business_text(NEW.model), '');
    NEW.description := NULLIF(normalize_business_text(NEW.description), '');

    IF NEW.category_id IS NOT NULL THEN
        SELECT c.name INTO v_name FROM categories c WHERE c.id = NEW.category_id;
        NEW.category := v_name;
    ELSE
        NEW.category := normalize_business_text(NEW.category);
    END IF;

    IF NEW.brand_id IS NOT NULL THEN
        SELECT b.name INTO v_name FROM brands b WHERE b.id = NEW.brand_id;
        NEW.brand := v_name;
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_products_normalize ON products;
CREATE TRIGGER trg_products_normalize
    BEFORE INSERT OR UPDATE ON products
    FOR EACH ROW EXECUTE FUNCTION products_normalize();

-- ---------------------------------------------------------------------
-- Backfill de los datos existentes.
-- El UPDATE dispara el trigger, que hace la normalización; la condición
-- evita reescribir filas que ya están normalizadas (y que la migración sea
-- idempotente sin trabajo inútil).
-- ---------------------------------------------------------------------
UPDATE customers
   SET full_name = full_name
 WHERE full_name    IS DISTINCT FROM normalize_business_text(full_name)
    OR address      IS DISTINCT FROM normalize_business_text(address)
    OR address_ref  IS DISTINCT FROM NULLIF(normalize_business_text(address_ref), '')
    OR municipality IS DISTINCT FROM NULLIF(normalize_business_text(municipality), '')
    OR department   IS DISTINCT FROM NULLIF(normalize_business_text(department), '')
    OR notes        IS DISTINCT FROM NULLIF(normalize_business_text(notes), '')
    OR email        IS DISTINCT FROM normalize_email(email);

UPDATE products
   SET name = name
 WHERE name        IS DISTINCT FROM normalize_business_text(name)
    OR category    IS DISTINCT FROM normalize_business_text(category)
    OR brand       IS DISTINCT FROM NULLIF(normalize_business_text(brand), '')
    OR model       IS DISTINCT FROM NULLIF(normalize_business_text(model), '')
    OR description IS DISTINCT FROM NULLIF(normalize_business_text(description), '')
    OR code        IS DISTINCT FROM upper(btrim(code));

-- Índices sobre la forma canónica. Los de 001 (`lower(...)`) se conservan:
-- esta migración no borra nada.
CREATE INDEX IF NOT EXISTS ix_customers_name_norm
    ON customers (normalize_business_text(full_name));
CREATE INDEX IF NOT EXISTS ix_products_name_norm
    ON products (normalize_business_text(name));


-- =====================================================================
-- 6. INVENTARIO POR SUCURSAL
--
-- ESTRATEGIA DE COMPATIBILIDAD — leer antes de tocar nada.
--
-- Hoy TODO cambio de existencias pasa por `Product.adjustStock`, que
-- escribe `products.stock` y SIEMPRE deja una fila en `stock_movements`.
-- Esa fila es la espina dorsal: se le añade `branch_id` y un trigger la
-- aplica al inventario de la sucursal correspondiente.
--
-- Consecuencias buscadas:
--   * El flujo de ventas NO se modifica. Ni una línea.
--   * `products.stock` sigue siendo lo que la venta consulta y descuenta.
--   * `inventory` queda como el desglose por sucursal, y se cumple la
--     invariante   products.stock = SUM(inventory.quantity)   por producto.
--   * El sentido es único (movimiento -> inventario): no hay dos triggers
--     escribiéndose mutuamente ni riesgo de recursión.
--
-- LÍMITE CONOCIDO DE ESTA FASE: mientras la venta no declare sucursal
-- (bloque posterior), todo movimiento sin sucursal se imputa a la sucursal
-- predeterminada. Por eso no se deben trasladar existencias fuera de ella
-- todavía: una venta intentaría descontar de una sucursal sin saldo. El
-- trigger corta ese caso con un mensaje explícito en lugar de dejar
-- inventario negativo.
-- =====================================================================
CREATE TABLE IF NOT EXISTS inventory (
    id         BIGSERIAL   PRIMARY KEY,
    product_id BIGINT      NOT NULL REFERENCES products (id) ON DELETE RESTRICT,
    branch_id  BIGINT      NOT NULL REFERENCES branches (id) ON DELETE RESTRICT,
    quantity   INTEGER     NOT NULL DEFAULT 0 CHECK (quantity >= 0),
    min_stock  INTEGER     NOT NULL DEFAULT 0 CHECK (min_stock >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT ux_inventory_product_branch UNIQUE (product_id, branch_id)
);

CREATE INDEX IF NOT EXISTS ix_inventory_branch ON inventory (branch_id);

DROP TRIGGER IF EXISTS trg_inventory_updated ON inventory;
CREATE TRIGGER trg_inventory_updated
    BEFORE UPDATE ON inventory FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Sucursal en el movimiento de inventario.
ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS branch_id BIGINT
    REFERENCES branches (id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS ix_stock_movements_branch ON stock_movements (branch_id, created_at DESC);

-- Los movimientos históricos se imputan a la sucursal predeterminada: es
-- donde estaba físicamente la mercadería cuando solo había un local.
UPDATE stock_movements
   SET branch_id = (SELECT id FROM branches WHERE is_default)
 WHERE branch_id IS NULL;

/**
 * Un movimiento sin sucursal se imputa a la predeterminada.
 * Esto es lo que permite que el código actual de ventas y de ajuste siga
 * funcionando sin cambios: no sabe de sucursales, y no necesita saber.
 */
CREATE OR REPLACE FUNCTION stock_movements_default_branch() RETURNS trigger
    LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.branch_id IS NULL THEN
        SELECT id INTO NEW.branch_id FROM branches WHERE is_default;
        IF NEW.branch_id IS NULL THEN
            RAISE EXCEPTION 'No hay sucursal predeterminada: no se puede imputar el movimiento de inventario'
                USING ERRCODE = 'foreign_key_violation';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_stock_movements_branch ON stock_movements;
CREATE TRIGGER trg_stock_movements_branch
    BEFORE INSERT ON stock_movements
    FOR EACH ROW EXECUTE FUNCTION stock_movements_default_branch();

-- El trigger BEFORE rellena la columna antes de que se valide NOT NULL,
-- así que ahora es seguro exigirla.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_name = 'stock_movements' AND column_name = 'branch_id'
           AND is_nullable = 'YES'
    ) THEN
        ALTER TABLE stock_movements ALTER COLUMN branch_id SET NOT NULL;
    END IF;
END $$;

-- ---------------------------------------------------------------------
-- Siembra del inventario: las existencias actuales viven, por definición,
-- en la sucursal predeterminada. No se inventa ningún reparto.
-- ---------------------------------------------------------------------
INSERT INTO inventory (product_id, branch_id, quantity, min_stock)
SELECT p.id, b.id, p.stock, p.min_stock
  FROM products p
 CROSS JOIN branches b
 WHERE b.is_default
ON CONFLICT (product_id, branch_id) DO NOTHING;

/**
 * Aplica cada movimiento al inventario de su sucursal.
 *
 * El signo se deduce del tipo, igual que lo escribe hoy la aplicación:
 * `quantity` siempre es positivo y el tipo dice si suma o resta. El tipo
 * 'ajuste' solo se emite con delta cero, por eso no mueve nada.
 */
CREATE OR REPLACE FUNCTION stock_movements_apply_to_inventory() RETURNS trigger
    LANGUAGE plpgsql
AS $$
DECLARE
    v_delta   integer;
    v_current integer;
    v_branch  text;
    v_product text;
BEGIN
    v_delta := CASE NEW.movement
                   WHEN 'entrada' THEN  NEW.quantity
                   WHEN 'salida'  THEN -NEW.quantity
                   ELSE 0
               END;

    -- Garantiza que exista la fila del par producto/sucursal.
    INSERT INTO inventory (product_id, branch_id, quantity)
    VALUES (NEW.product_id, NEW.branch_id, 0)
    ON CONFLICT (product_id, branch_id) DO NOTHING;

    IF v_delta = 0 THEN
        RETURN NULL;
    END IF;

    -- Bloquea la fila: dos ventas simultáneas del mismo producto no pueden
    -- leer la misma existencia y dejarla negativa.
    SELECT quantity INTO v_current
      FROM inventory
     WHERE product_id = NEW.product_id AND branch_id = NEW.branch_id
       FOR UPDATE;

    IF v_current + v_delta < 0 THEN
        SELECT name INTO v_branch  FROM branches WHERE id = NEW.branch_id;
        SELECT name INTO v_product FROM products WHERE id = NEW.product_id;
        RAISE EXCEPTION
            'El movimiento dejaría el inventario de "%" en la sucursal % en % unidades. Disponible: %.',
            v_product, v_branch, v_current + v_delta, v_current
            USING ERRCODE = 'check_violation';
    END IF;

    UPDATE inventory
       SET quantity = v_current + v_delta
     WHERE product_id = NEW.product_id AND branch_id = NEW.branch_id;

    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_stock_movements_inventory ON stock_movements;
CREATE TRIGGER trg_stock_movements_inventory
    AFTER INSERT ON stock_movements
    FOR EACH ROW EXECUTE FUNCTION stock_movements_apply_to_inventory();


-- =====================================================================
-- 7. HISTÓRICO DE COSTOS
--
-- Responde a "¿cuánto costaba este producto en tal fecha y quién lo
-- cambió?". NO altera el costo de las ventas: `sale_items.unit_cost` ya
-- congela el costo aplicado en el momento de la venta y esta tabla no lo
-- toca. Ninguna venta se recalcula nunca con el costo actual.
--
-- Igual que la bitácora (RN-0006), es de solo-añadir: una vez escrita, una
-- fila no se modifica ni se borra.
-- =====================================================================
CREATE TABLE IF NOT EXISTS product_cost_history (
    id            BIGSERIAL   PRIMARY KEY,
    product_id    BIGINT      NOT NULL REFERENCES products (id) ON DELETE RESTRICT,
    cost          NUMERIC(12, 2) NOT NULL CHECK (cost >= 0),
    previous_cost NUMERIC(12, 2) CHECK (previous_cost >= 0),
    reason        VARCHAR(40) NOT NULL DEFAULT 'actualizacion'
                  CHECK (reason IN ('inicial', 'actualizacion', 'correccion')),
    notes         TEXT,
    changed_by    BIGINT      REFERENCES users (id) ON DELETE SET NULL,
    changed_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ix_cost_history_product
    ON product_cost_history (product_id, changed_at DESC, id DESC);

CREATE OR REPLACE FUNCTION cost_history_is_append_only() RETURNS trigger
    LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'El histórico de costos no se modifica ni se elimina (RN-0006)'
        USING ERRCODE = 'restrict_violation';
END;
$$;

DROP TRIGGER IF EXISTS trg_cost_history_immutable ON product_cost_history;
CREATE TRIGGER trg_cost_history_immutable
    BEFORE UPDATE OR DELETE ON product_cost_history
    FOR EACH ROW EXECUTE FUNCTION cost_history_is_append_only();

-- Punto de partida: el costo actual de cada producto, atribuido a quien lo
-- dio de alta y fechado en su alta. No se inventan cambios intermedios que
-- nadie registró.
INSERT INTO product_cost_history (product_id, cost, previous_cost, reason, notes, changed_by, changed_at)
SELECT p.id, p.cost, NULL, 'inicial',
       'Costo vigente al implantar el histórico (migración 004).',
       p.created_by, p.created_at
  FROM products p
 WHERE NOT EXISTS (SELECT 1 FROM product_cost_history h WHERE h.product_id = p.id);


-- =====================================================================
-- 8. VISTAS
-- =====================================================================

-- Existencias por producto y sucursal, con el estado de reposición.
CREATE OR REPLACE VIEW v_inventory AS
SELECT i.id,
       i.product_id,
       p.code                AS product_code,
       p.name                AS product_name,
       p.category,
       p.brand,
       p.is_active           AS product_active,
       i.branch_id,
       b.code                AS branch_code,
       b.name                AS branch_name,
       b.is_active           AS branch_active,
       i.quantity,
       i.min_stock,
       (i.quantity <= i.min_stock) AS needs_restock,
       i.updated_at
FROM inventory i
JOIN products p ON p.id = i.product_id
JOIN branches b ON b.id = i.branch_id;

-- Comprobación de la invariante de compatibilidad. Si algún producto
-- aparece aquí, el desglose por sucursal y `products.stock` se separaron.
CREATE OR REPLACE VIEW v_inventory_mismatch AS
SELECT p.id AS product_id,
       p.code,
       p.name,
       p.stock                                   AS product_stock,
       COALESCE(SUM(i.quantity), 0)::int         AS inventory_total,
       p.stock - COALESCE(SUM(i.quantity), 0)::int AS difference
FROM products p
LEFT JOIN inventory i ON i.product_id = p.id
GROUP BY p.id, p.code, p.name, p.stock
HAVING p.stock <> COALESCE(SUM(i.quantity), 0)::int;

-- Histórico de costos legible.
CREATE OR REPLACE VIEW v_product_cost_history AS
SELECT h.id,
       h.product_id,
       p.code       AS product_code,
       p.name       AS product_name,
       h.cost,
       h.previous_cost,
       (h.cost - COALESCE(h.previous_cost, h.cost))::numeric(12, 2) AS variation,
       h.reason,
       h.notes,
       h.changed_by,
       u.username   AS changed_by_username,
       h.changed_at
FROM product_cost_history h
JOIN products p ON p.id = h.product_id
LEFT JOIN users u ON u.id = h.changed_by;

-- Catálogo navegable: CATEGORÍA -> MARCA -> productos.
CREATE OR REPLACE VIEW v_catalog_tree AS
SELECT c.id            AS category_id,
       c.name          AS category_name,
       b.id            AS brand_id,
       b.name          AS brand_name,
       COUNT(p.id)::int AS products,
       COUNT(p.id) FILTER (WHERE p.is_active)::int AS active_products
FROM products p
LEFT JOIN categories c ON c.id = p.category_id
LEFT JOIN brands b     ON b.id = p.brand_id
GROUP BY c.id, c.name, b.id, b.name;


-- =====================================================================
-- 9. PERMISOS (aditivos: no se toca ninguno del bloque 1)
--
-- Se añaden SOLO los que la aplicación comprueba de verdad en este bloque.
-- La consulta de categorías y marcas NO lleva permiso propio: es parte de
-- navegar el catálogo y ya está cubierta por `products.view`; crear uno
-- nuevo dejaría una casilla que no protege nada.
--
-- El histórico de costos tampoco estrena permiso: es el mismo secreto que
-- ya protege `products.cost.view` (RN-0001).
-- =====================================================================
INSERT INTO permissions (code, module, name, description) VALUES
    ('branches.view',      'sucursales', 'Consultar sucursales',          NULL),
    ('branches.manage',    'sucursales', 'Administrar sucursales',        'Crear, modificar, activar y desactivar.'),
    ('branches.assign',    'sucursales', 'Asignar la sucursal de un usuario', 'Complementa users.manage.'),

    ('inventory.view',     'inventario', 'Consultar el inventario de TODAS las sucursales', NULL),
    ('inventory.view.own', 'inventario', 'Operar con el inventario de la propia sucursal',
                           'El stock operativo es el de la sucursal del usuario. La existencia de las demás se consulta solo como información.'),
    ('inventory.manage',   'inventario', 'Ajustar el inventario',
                           'Entradas, salidas y correcciones sobre cualquier sucursal.'),

    ('categories.manage',  'productos',  'Administrar categorías',        'La consulta va con products.view.'),
    ('brands.manage',      'productos',  'Administrar marcas',            'La consulta va con products.view.'),

    -- Catálogo de créditos. La aplicación TODAVÍA NO comprueba estos tres
    -- permisos: el flujo de crédito pertenece a un bloque posterior. Se
    -- registran ahora, por indicación del propietario, para que la matriz
    -- de roles quede montada; por eso la descripción lo dice en voz alta y
    -- no se marca como concedido nada que la aplicación deje pasar hoy.
    ('credits.view',       'creditos',   'Consultar créditos',
                           'RESERVADO: el módulo de créditos llega en un bloque posterior.'),
    ('credits.verify',     'creditos',   'Registrar verificaciones de crédito',
                           'RESERVADO. Verificar NO es decidir: no aprueba ni rechaza.'),
    ('credits.decide',     'creditos',   'Aprobar o rechazar créditos',
                           'RESERVADO. Exclusivo de Administración y Gerencia.')
ON CONFLICT (code) DO UPDATE
    SET module = EXCLUDED.module,
        name = EXCLUDED.name,
        description = EXCLUDED.description;

-- El administrador conserva acceso total: recibe todo permiso nuevo.
INSERT INTO role_permissions (role_code, permission_code)
SELECT 'admin', code FROM permissions
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------
-- VENTAS: opera con el inventario de SU sucursal, y solo consulta el de
-- las demás. No recibe `inventory.manage`: no ajusta existencias, ni
-- propias ni ajenas.
-- ---------------------------------------------------------------------
INSERT INTO role_permissions (role_code, permission_code)
SELECT 'vendedor', code FROM permissions WHERE code IN ('inventory.view.own')
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------
-- GERENCIA (decisión del propietario, 2026-09-11): panel, consulta y
-- decisión de créditos, y consulta de costos e histórico de costos.
--
-- Esto AMPLÍA lo que el bloque 1 le había dado (solo `dashboard.view`).
-- `products.view` entra porque sin poder listar el catálogo no hay dónde
-- consultar un costo. Sigue SIN clientes, ventas, pagos ni cobranza.
-- ---------------------------------------------------------------------
INSERT INTO role_permissions (role_code, permission_code)
SELECT 'gerencia', code FROM permissions WHERE code IN (
    'products.view',
    'products.cost.view',
    'credits.view',
    'credits.decide'
)
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------
-- VERIFICADOR: verifica, NO decide. Recibe `credits.view` y
-- `credits.verify`, y explícitamente NO `credits.decide`.
-- ---------------------------------------------------------------------
INSERT INTO role_permissions (role_code, permission_code)
SELECT 'verificador', code FROM permissions WHERE code IN (
    'credits.view',
    'credits.verify'
)
ON CONFLICT DO NOTHING;

-- Salvaguarda: la capacidad de decidir un crédito es de Administración y
-- Gerencia. Si una migración anterior, un script o un descuido se la
-- hubiera dado a otro rol, aquí se retira.
DELETE FROM role_permissions
 WHERE permission_code = 'credits.decide'
   AND role_code NOT IN ('admin', 'gerencia');

-- Cobranza no recibe permisos nuevos en esta migración.


-- =====================================================================
-- 10. COMENTARIOS DE ESQUEMA
-- =====================================================================
COMMENT ON TABLE branches IS 'Sucursales / locales del negocio.';
COMMENT ON TABLE inventory IS 'Existencias por producto y sucursal. Se alimenta de stock_movements mediante trigger; products.stock es su total.';
COMMENT ON TABLE categories IS 'Categorías de producto. Únicas por nombre normalizado.';
COMMENT ON TABLE brands IS 'Marcas de producto. Únicas por nombre normalizado.';
COMMENT ON TABLE product_cost_history IS 'Histórico de costos. Solo-añadir (RN-0006). No afecta al costo congelado en sale_items.';
COMMENT ON COLUMN products.stock IS 'Existencia total del producto. Debe coincidir con SUM(inventory.quantity); ver v_inventory_mismatch.';
