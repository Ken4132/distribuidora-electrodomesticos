-- =====================================================================
-- 021 — PROVEEDORES (bloque 6.1: fundamento de COMPRAS)
--
-- Primera pieza del módulo de compras: el CATÁLOGO DE PROVEEDORES.
--
-- Aquí NO entran compras, renglones de compra, cuentas por pagar ni pagos
-- a proveedor. Eso es de bloques posteriores. Lo único que se construye es
-- la entidad maestra de la que esas tablas colgarán después.
--
-- DECISIONES QUE SE TOMAN AQUÍ Y POR QUÉ:
--
--   * El proveedor NO tiene `branch_id`. Se le compra desde la empresa, no
--     desde un local: el mismo proveedor surte a todas las sucursales. La
--     sucursal es un dato de la COMPRA, no del proveedor, y ahí es donde
--     aparecerá cuando llegue el bloque de compras.
--
--   * El NIT es único ENTRE PROVEEDORES ACTIVOS, no en toda la tabla. Un
--     proveedor dado de baja conserva su NIT y su historial; si más
--     adelante se vuelve a trabajar con él, se REACTIVA el registro
--     existente en lugar de duplicarlo. Por eso el índice es parcial.
--
--   * NO se elimina físicamente ningún proveedor: un trigger lo impide.
--     Las compras que se registren después apuntarán a este renglón, y
--     borrarlo dejaría historial financiero sin origen.
--
--   * NO se crea ningún permiso nuevo. Ver la sección 5.
--
-- ADITIVA y RE-EJECUTABLE. No modifica ninguna tabla existente.
-- =====================================================================


-- =====================================================================
-- 1. TABLA
--
-- Obligatorios solo NIT y razón social: son la identidad del proveedor y
-- lo que sostiene la regla de unicidad. El resto son datos de contacto que
-- pueden completarse después; exigirlos sería inventar una regla que el
-- propietario no ha definido.
-- =====================================================================
CREATE TABLE IF NOT EXISTS suppliers (
    id            BIGSERIAL    PRIMARY KEY,
    nit           VARCHAR(20)  NOT NULL,
    business_name VARCHAR(150) NOT NULL,
    contact_name  VARCHAR(150),
    phone         VARCHAR(20),
    phone_alt     VARCHAR(20),
    email         VARCHAR(150),
    address       VARCHAR(500),
    municipality  VARCHAR(80),
    department    VARCHAR(80),
    notes         TEXT,
    is_active     BOOLEAN      NOT NULL DEFAULT TRUE,
    created_by    BIGINT       REFERENCES users (id) ON DELETE SET NULL,
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),

    -- Forma del NIT guatemalteco YA NORMALIZADO (sin guiones ni espacios):
    -- dígitos y, opcionalmente, una K final como dígito verificador.
    --
    -- NO se comprueba el dígito verificador: esa cuenta no está definida
    -- como regla del proyecto y calcularla aquí podría rechazar NITs
    -- reales. Se valida la FORMA, no la aritmética.
    CONSTRAINT suppliers_nit_format CHECK (nit ~ '^[0-9]{1,14}[0-9K]$'),
    CONSTRAINT suppliers_business_name_present CHECK (btrim(business_name) <> '')
);

COMMENT ON TABLE suppliers IS
    'Catálogo de proveedores. Sin sucursal: se le compra desde la empresa. Baja lógica (is_active); nunca se elimina.';
COMMENT ON COLUMN suppliers.nit IS
    'NIT normalizado (mayúsculas, sin guiones ni espacios). Único entre proveedores ACTIVOS.';
COMMENT ON COLUMN suppliers.created_by IS
    'Usuario que dio de alta al proveedor. ON DELETE SET NULL: el alta se conserva aunque el usuario deje de existir.';


-- =====================================================================
-- 2. UNICIDAD DEL NIT ENTRE ACTIVOS
--
-- Índice PARCIAL, deliberadamente:
--
--   * dos proveedores ACTIVOS no pueden compartir NIT;
--   * un proveedor inactivo conserva el suyo y no estorba;
--   * volver a trabajar con un proveedor dado de baja se resuelve
--     REACTIVÁNDOLO (PATCH /suppliers/:id/active), no creando un duplicado
--     que partiría en dos su historial de compras.
--
-- La comprobación equivalente del servicio es para dar un mensaje claro;
-- la garantía real contra la condición de carrera es este índice.
-- =====================================================================
CREATE UNIQUE INDEX IF NOT EXISTS ux_suppliers_nit_active
    ON suppliers (nit) WHERE is_active;

-- Búsqueda por razón social y por contacto, sobre la forma normalizada:
-- es la misma que se guarda, así que el índice sirve para el LIKE anclado
-- y la consulta encuentra el registro se escriba como se escriba.
CREATE INDEX IF NOT EXISTS ix_suppliers_business_name
    ON suppliers (normalize_business_text(business_name));
CREATE INDEX IF NOT EXISTS ix_suppliers_active
    ON suppliers (is_active);


-- =====================================================================
-- 3. NORMALIZACIÓN (defensa en profundidad)
--
-- El validador de la API ya normaliza. El trigger existe porque un script,
-- una carga masiva o un psql no pasan por el validador, y un proveedor
-- guardado sin normalizar sería invisible para la búsqueda.
--
-- Se normaliza el texto de negocio (MAYÚSCULAS, sin tildes, Ñ conservada).
-- El correo va a minúsculas, NUNCA a mayúsculas. El NIT y los teléfonos
-- tienen reglas propias: se limpian de separadores, no se les quitan
-- tildes ni se les aplica normalize_business_text.
-- =====================================================================
CREATE OR REPLACE FUNCTION suppliers_normalize() RETURNS trigger
    LANGUAGE plpgsql
AS $$
BEGIN
    NEW.nit           := upper(regexp_replace(COALESCE(NEW.nit, ''), '[^0-9A-Za-z]', '', 'g'));
    NEW.business_name := normalize_business_text(NEW.business_name);
    -- Los opcionales en blanco se guardan como NULL, no como ''.
    NEW.contact_name  := NULLIF(normalize_business_text(NEW.contact_name), '');
    NEW.address       := NULLIF(normalize_business_text(NEW.address), '');
    NEW.municipality  := NULLIF(normalize_business_text(NEW.municipality), '');
    NEW.department    := NULLIF(normalize_business_text(NEW.department), '');
    NEW.notes         := NULLIF(normalize_business_text(NEW.notes), '');
    NEW.email         := normalize_email(NEW.email);
    NEW.phone         := NULLIF(regexp_replace(COALESCE(NEW.phone, ''),     '[\s()-]', '', 'g'), '');
    NEW.phone_alt     := NULLIF(regexp_replace(COALESCE(NEW.phone_alt, ''), '[\s()-]', '', 'g'), '');
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_suppliers_normalize ON suppliers;
CREATE TRIGGER trg_suppliers_normalize
    BEFORE INSERT OR UPDATE ON suppliers
    FOR EACH ROW EXECUTE FUNCTION suppliers_normalize();

DROP TRIGGER IF EXISTS trg_suppliers_updated ON suppliers;
CREATE TRIGGER trg_suppliers_updated
    BEFORE UPDATE ON suppliers
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- =====================================================================
-- 4. NO SE BORRA UN PROVEEDOR
--
-- Misma doctrina que el resto del sistema (clientes, productos, sucursales
-- y los reportes de cobranza): baja LÓGICA. Aquí además pesa que las
-- compras y las cuentas por pagar del bloque siguiente colgarán de esta
-- tabla; borrar un renglón dejaría historial financiero sin origen.
--
-- El trigger está en la base, no solo en el servicio: si únicamente lo
-- impidiera Express, un DELETE por psql se lo saltaría.
-- =====================================================================
CREATE OR REPLACE FUNCTION suppliers_no_delete() RETURNS trigger
    LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'Un proveedor no se elimina: se desactiva (is_active = FALSE)'
        USING ERRCODE = 'restrict_violation';
END;
$$;

DROP TRIGGER IF EXISTS trg_suppliers_no_delete ON suppliers;
CREATE TRIGGER trg_suppliers_no_delete
    BEFORE DELETE ON suppliers
    FOR EACH ROW EXECUTE FUNCTION suppliers_no_delete();


-- =====================================================================
-- 5. PERMISOS — NO SE CREA NINGUNO
--
-- El proyecto ya dejó escrita su doctrina en la migración 004, sobre
-- categorías y marcas: "crear uno nuevo dejaría una casilla que no protege
-- nada". Un permiso solo se justifica cuando protege un secreto o una
-- audiencia distinta de los que ya existen.
--
-- El proveedor no estrena ni una cosa ni la otra:
--
--   * quien administra proveedores es exactamente quien hoy registra la
--     entrada de mercadería —el movimiento de existencias cuyo motivo ya se
--     llama "compra a proveedor"—, y eso es `inventory.manage`
--     ("Entradas, salidas y correcciones sobre cualquier sucursal");
--   * quien consulta el catálogo de proveedores es quien ya puede consultar
--     el inventario completo: `inventory.view`.
--
-- Por eso el módulo se apoya en esos dos permisos existentes:
--
--     LECTURA    inventory.view  O  inventory.manage
--     ESCRITURA  inventory.manage
--
-- Hoy ambos los tiene únicamente el administrador, que es el alcance
-- correcto para el MVP. Si al llegar las compras y las cuentas por pagar
-- hiciera falta abrirlo a otro rol sin darle el ajuste de existencias,
-- entonces sí habrá un secreto propio que proteger y ahí se justificará un
-- permiso `suppliers.*`. Antes, no.
-- =====================================================================
