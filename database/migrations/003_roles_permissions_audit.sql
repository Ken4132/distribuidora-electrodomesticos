-- =====================================================================
-- 003_roles_permissions_audit.sql
--
-- Control de acceso administrable y bitácora de auditoría.
--
-- Cubre de la tesis:
--   REQ-0010  Gestión de usuarios
--   REQ-0011  Gestión de roles y permisos
--   REQ-0016  Bitácora y auditoría
--   RN-0001   Solo el administrador puede ver y modificar los costos
--   RN-0002   Los vendedores solo ven los precios de venta autorizados
--   RN-0006   Nadie puede eliminar información histórica
--   RN-0007   La bitácora registra las operaciones críticas
--   RN-0008   Cada usuario accede solo a los módulos autorizados
--   RNQ-0010  Trazabilidad de las acciones de los usuarios
--
-- Qué NO hace esta migración:
--   * No borra ni renombra nada de 001 ni de 002.
--   * No cambia la columna `users.role`: sigue siendo el código del rol y
--     sigue viajando igual en el token. Lo único que cambia es que deja de
--     estar clavada en un CHECK y pasa a ser una llave foránea contra una
--     tabla de roles administrable, que es lo que pide REQ-0011.
-- =====================================================================

-- ---------------------------------------------------------------------
-- ROLES
-- `code` es la llave natural: es el valor que ya viaja en users.role y en
-- el token de sesión. Usarlo como llave primaria evita tener que reescribir
-- la autenticación y el frontend para cambiar de rol fijo a rol administrable.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS roles (
    code        VARCHAR(20)  PRIMARY KEY,
    name        VARCHAR(60)  NOT NULL,
    description TEXT,
    -- Un rol de sistema no se puede eliminar desde la aplicación: sin
    -- administrador nadie podría volver a entrar.
    is_system   BOOLEAN      NOT NULL DEFAULT FALSE,
    is_active   BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),

    CONSTRAINT roles_code_format CHECK (code ~ '^[a-z][a-z0-9_]{1,19}$')
);

DROP TRIGGER IF EXISTS trg_roles_updated ON roles;
CREATE TRIGGER trg_roles_updated
    BEFORE UPDATE ON roles
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Los cinco actores con acceso al sistema según la Tabla 6 de la tesis.
-- El sexto actor, Cliente, NO se crea como rol: la propia Tabla 6 lo describe
-- como "actor externo que no accede directamente al sistema".
INSERT INTO roles (code, name, description, is_system) VALUES
    ('admin',       'Administrador', 'Acceso total: configuración, usuarios, productos, créditos, cobranza y reportes.', TRUE),
    ('vendedor',    'Ventas',        'Registra clientes y ventas, y cobra los créditos de su propia cartera.', TRUE),
    ('cobrador',    'Cobrador',      'Registra pagos, consulta la cartera completa y da seguimiento a los clientes.', TRUE),
    ('verificador', 'Verificador',   'Registra el resultado de las visitas domiciliarias y laborales de las solicitudes de crédito.', TRUE),
    ('gerencia',    'Gerencia',      'Consulta indicadores y reportes. Perfil de supervisión, sin operación.', TRUE)
ON CONFLICT (code) DO NOTHING;

-- ---------------------------------------------------------------------
-- PERMISOS
-- Catálogo fijo de acciones que la aplicación sabe proteger. No se crean
-- desde la interfaz: un permiso nuevo implica código nuevo que lo respete.
-- Lo que sí es administrable es qué rol tiene cuáles.
--
-- Aquí SOLO se siembran los permisos que la aplicación respeta hoy. Los de
-- funcionalidades que aún no existen (verificación y aprobación de créditos,
-- reportes, configuración, gestión de cobranza) entran con su bloque. Sembrar
-- un permiso que nadie comprueba dejaría una casilla marcable en la pantalla
-- de roles que no protege nada, y el administrador creería haber concedido
-- un acceso que el sistema ignora.
--
-- Los permisos terminados en `.own` limitan la acción a la cartera propia del
-- usuario. Ver la sección de alcance en docs/REGLAS-DE-NEGOCIO.md (regla U6).
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS permissions (
    code        VARCHAR(60)  PRIMARY KEY,
    module      VARCHAR(30)  NOT NULL,
    name        VARCHAR(120) NOT NULL,
    description TEXT
);

CREATE INDEX IF NOT EXISTS ix_permissions_module ON permissions (module);

INSERT INTO permissions (code, module, name, description) VALUES
    ('dashboard.view',      'dashboard',     'Ver el resumen operativo',        'Acceso a la pantalla de inicio.'),

    ('customers.view',      'clientes',      'Consultar clientes',              'Ver el listado y el expediente del cliente.'),
    ('customers.create',    'clientes',      'Registrar clientes',              NULL),
    ('customers.update',    'clientes',      'Modificar clientes',              NULL),
    ('customers.status',    'clientes',      'Activar o desactivar clientes',   NULL),

    ('products.view',       'productos',     'Consultar productos',             'Ver el catálogo y los precios de venta.'),
    ('products.create',     'productos',     'Registrar productos',             'Implica definir el costo.'),
    ('products.update',     'productos',     'Modificar productos',             'Implica modificar el costo.'),
    ('products.status',     'productos',     'Activar o desactivar productos',  NULL),
    ('products.stock',      'productos',     'Ajustar inventario',              NULL),
    ('products.cost.view',  'productos',     'Ver los costos',                  'RN-0001: reservado al administrador.'),

    ('sales.view',          'ventas',        'Consultar ventas',                NULL),
    ('sales.create',        'ventas',        'Registrar ventas',                NULL),
    ('sales.cancel',        'ventas',        'Anular ventas',                   NULL),

    ('payments.view',       'pagos',         'Consultar pagos',                 NULL),
    ('payments.create',     'pagos',         'Registrar pagos',                 'Sobre cualquier venta.'),
    ('payments.create.own', 'pagos',         'Cobrar la cartera propia',        'Solo ventas A CRÉDITO registradas por el propio usuario.'),
    ('payments.void',       'pagos',         'Anular pagos',                    NULL),

    ('receivables.view',    'cobranza',      'Consultar la cartera completa',   'Cuentas por cobrar y cuotas vencidas de toda la empresa.'),
    ('receivables.view.own','cobranza',      'Consultar la cartera propia',     'Solo ventas A CRÉDITO registradas por el propio usuario.'),

    ('users.view',          'seguridad',     'Consultar usuarios',              NULL),
    ('users.manage',        'seguridad',     'Administrar usuarios',            'Crear, modificar, activar y desactivar.'),
    ('roles.view',          'seguridad',     'Consultar roles y permisos',      NULL),
    ('roles.manage',        'seguridad',     'Administrar roles y permisos',    NULL),
    ('audit.view',          'seguridad',     'Consultar la bitácora',           'RN-0007: reservado al administrador.'),

    ('integrations.manage', 'integraciones', 'Administrar el puente con n8n',   NULL)
ON CONFLICT (code) DO UPDATE
    SET module = EXCLUDED.module,
        name = EXCLUDED.name,
        description = EXCLUDED.description;

-- ---------------------------------------------------------------------
-- ROL <-> PERMISO
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS role_permissions (
    role_code       VARCHAR(20) NOT NULL REFERENCES roles (code) ON DELETE CASCADE ON UPDATE CASCADE,
    permission_code VARCHAR(60) NOT NULL REFERENCES permissions (code) ON DELETE CASCADE ON UPDATE CASCADE,
    PRIMARY KEY (role_code, permission_code)
);

CREATE INDEX IF NOT EXISTS ix_role_permissions_role ON role_permissions (role_code);

-- Administrador: todo, incluidos los costos (RN-0001) y la bitácora (RN-0007).
INSERT INTO role_permissions (role_code, permission_code)
SELECT 'admin', code FROM permissions
ON CONFLICT DO NOTHING;

-- Ventas (Tabla 6: Clientes, Ventas, Productos; §1.6.3).
-- Sobre el catálogo solo consulta: dar de alta o editar un producto obliga a
-- escribir el costo, y el costo está reservado al administrador (RN-0001 y
-- RN-0002).
-- Cobra ÚNICAMENTE su propia cartera: los permisos `.own` en lugar de los
-- globales. `payments.view` sí es global, en coherencia con `sales.view`.
INSERT INTO role_permissions (role_code, permission_code)
SELECT 'vendedor', code FROM permissions WHERE code IN (
    'dashboard.view',
    'customers.view', 'customers.create', 'customers.update', 'customers.status',
    'products.view',
    'sales.view', 'sales.create',
    'payments.view', 'payments.create.own',
    'receivables.view.own'
)
ON CONFLICT DO NOTHING;

-- Cobrador (Tabla 6: Cobros, Créditos; CUP-03; §1.6.3): consulta clientes
-- pendientes, registra abonos de CUALQUIER venta, verifica cuotas vencidas y
-- da seguimiento. No registra ventas ni modifica el catálogo.
INSERT INTO role_permissions (role_code, permission_code)
SELECT 'cobrador', code FROM permissions WHERE code IN (
    'dashboard.view',
    'customers.view',
    'sales.view',
    'payments.view', 'payments.create',
    'receivables.view'
)
ON CONFLICT DO NOTHING;

-- Verificador (Tabla 6: Verificaciones; CUP-02 pasos 4 y 5).
-- Necesita ver al cliente y la operación para poder verificarlos. Sus
-- permisos propios (`credits.verify`) llegan con el bloque 2, cuando exista
-- el ciclo de vida del crédito. No aprueba: RN-0004 reserva la aprobación a
-- la administración.
INSERT INTO role_permissions (role_code, permission_code)
SELECT 'verificador', code FROM permissions WHERE code IN (
    'dashboard.view',
    'customers.view',
    'sales.view'
)
ON CONFLICT DO NOTHING;

-- Gerencia (Tabla 6: Reportes, Dashboard; CUP-04, "sin modificar los
-- registros transaccionales").
-- En este bloque solo el panel de inicio. Los permisos de reportes se
-- incorporan al implementar REQ-0013.
INSERT INTO role_permissions (role_code, permission_code)
SELECT 'gerencia', code FROM permissions WHERE code IN (
    'dashboard.view'
)
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------
-- users.role: de CHECK fijo a llave foránea administrable.
-- El CHECK de 001 solo admitía 'admin' y 'vendedor'; con él no se puede
-- crear el rol de cobrador que exige el alcance de la tesis.
-- ---------------------------------------------------------------------
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'users_role_fkey'
    ) THEN
        ALTER TABLE users
            ADD CONSTRAINT users_role_fkey
            FOREIGN KEY (role) REFERENCES roles (code) ON UPDATE CASCADE;
    END IF;
END $$;

-- Datos de contacto del usuario para la administración de cuentas (REQ-0010).
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone VARCHAR(20);
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS deactivated_at TIMESTAMPTZ;

-- =====================================================================
-- BITÁCORA DE AUDITORÍA (REQ-0016, RN-0007, RNQ-0010)
--
-- Se guarda el usuario Y una copia de su nombre y rol en el momento del
-- hecho: si mañana el usuario se renombra o cambia de rol, la bitácora debe
-- seguir diciendo quién era cuando ocurrió la operación.
-- =====================================================================
CREATE TABLE IF NOT EXISTS audit_log (
    id          BIGSERIAL   PRIMARY KEY,
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    user_id     BIGINT      REFERENCES users (id) ON DELETE SET NULL,
    username    VARCHAR(50),
    user_role   VARCHAR(20),

    action      VARCHAR(60) NOT NULL,       -- login.success, payment.create, ...
    module      VARCHAR(30),
    entity      VARCHAR(40),                -- customer | product | sale | payment | user | role
    entity_id   BIGINT,

    summary     TEXT        NOT NULL,       -- frase legible para la pantalla
    details     JSONB,                      -- datos de apoyo, sin información sensible

    result      VARCHAR(20) NOT NULL DEFAULT 'ok'
                CHECK (result IN ('ok', 'denegado', 'error')),

    ip          VARCHAR(60),
    user_agent  TEXT
);

CREATE INDEX IF NOT EXISTS ix_audit_occurred  ON audit_log (occurred_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS ix_audit_user      ON audit_log (user_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS ix_audit_action    ON audit_log (action, occurred_at DESC);
CREATE INDEX IF NOT EXISTS ix_audit_entity    ON audit_log (entity, entity_id);

-- ---------------------------------------------------------------------
-- RN-0006: la información histórica no se elimina.
-- Una bitácora que se puede editar o borrar no sirve como evidencia. Se
-- bloquea a nivel de base de datos, no solo en la aplicación: ni siquiera
-- un UPDATE manual desde psql puede alterarla.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION audit_log_is_append_only() RETURNS trigger
    LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'La bitácora es de solo inserción: no se puede % (RN-0006).', TG_OP
        USING ERRCODE = 'restrict_violation';
END;
$$;

DROP TRIGGER IF EXISTS trg_audit_log_immutable ON audit_log;
CREATE TRIGGER trg_audit_log_immutable
    BEFORE UPDATE OR DELETE ON audit_log
    FOR EACH ROW EXECUTE FUNCTION audit_log_is_append_only();

-- ---------------------------------------------------------------------
-- Vista de consulta: resuelve el nombre completo del usuario cuando la
-- cuenta todavía existe, sin perder la copia histórica del nombre.
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW v_audit_log AS
SELECT a.id,
       a.occurred_at,
       a.user_id,
       a.username,
       COALESCE(u.full_name, a.username, 'sistema') AS user_full_name,
       a.user_role,
       COALESCE(r.name, a.user_role)                AS user_role_name,
       a.action,
       a.module,
       a.entity,
       a.entity_id,
       a.summary,
       a.details,
       a.result,
       a.ip
FROM audit_log a
LEFT JOIN users u ON u.id = a.user_id
LEFT JOIN roles r ON r.code = a.user_role;

-- =====================================================================
-- ALCANCE DE CARTERA PROPIA
--
-- El vendedor cobra los créditos que él mismo vendió. Para poder filtrar
-- por eso hace falta saber quién registró la venta, y `v_sales` (migración
-- 001) no expone `created_by`.
--
-- Se REEMPLAZA la vista añadiendo dos columnas AL FINAL. Se añaden al final
-- a propósito: CREATE OR REPLACE VIEW solo admite agregar columnas después
-- de las existentes, y así `v_customer_accounts`, que depende de esta vista,
-- sigue funcionando sin tocarla.
--
-- No se cambia ninguna columna anterior ni su orden ni su tipo.
-- =====================================================================
CREATE OR REPLACE VIEW v_sales AS
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
       END                                                 AS account_status,
       -- NUEVAS: quién registró la venta. Si la cuenta del usuario fue
       -- eliminada, created_by queda en NULL (ON DELETE SET NULL) y la venta
       -- no pertenece a la cartera de nadie.
       s.created_by,
       u.username                                          AS created_by_username
FROM sales s
JOIN customers c ON c.id = s.customer_id
LEFT JOIN users u ON u.id = s.created_by
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

-- El filtro de cartera propia recorre ventas por su autor.
CREATE INDEX IF NOT EXISTS ix_sales_created_by ON sales (created_by);

-- ---------------------------------------------------------------------
-- Vista de apoyo para la pantalla de roles: permisos por rol ya agrupados.
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW v_role_permissions AS
SELECT r.code                                             AS role_code,
       r.name                                             AS role_name,
       r.description,
       r.is_system,
       r.is_active,
       COUNT(rp.permission_code)::int                     AS permissions_count,
       COALESCE(
           ARRAY_AGG(rp.permission_code ORDER BY rp.permission_code)
               FILTER (WHERE rp.permission_code IS NOT NULL),
           '{}'
       )                                                  AS permissions,
       (SELECT COUNT(*)::int FROM users u WHERE u.role = r.code) AS users_count
FROM roles r
LEFT JOIN role_permissions rp ON rp.role_code = r.code
GROUP BY r.code, r.name, r.description, r.is_system, r.is_active;
