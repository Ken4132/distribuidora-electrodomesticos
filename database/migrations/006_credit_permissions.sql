-- =====================================================================
-- 006_credit_permissions.sql
-- BLOQUE 3: permisos y transición del rol Verificador
--
-- Decisión de negocio:
--   La verificación de créditos deja de ser un rol independiente.
--   El Cobrador realiza la verificación mediante `credits.verify`.
--
-- Transición:
--   verificador -> cobrador
--
-- Además:
--   * Se agrega `credits.create`.
--   * Vendedor puede crear solicitudes.
--   * Cobrador puede consultar y verificar.
--   * Administración y Gerencia pueden decidir.
--   * El rol `verificador` se elimina después de migrar sus usuarios.
--
-- La migración es transaccional mediante migrate.js.
-- =====================================================================


-- =====================================================================
-- 1. NUEVO PERMISO: CREAR SOLICITUDES
-- =====================================================================

INSERT INTO permissions (
    code,
    module,
    name,
    description
)
VALUES (
    'credits.create',
    'creditos',
    'Crear solicitudes de crédito',
    'Registrar una nueva solicitud de crédito para evaluación.'
)
ON CONFLICT (code) DO UPDATE
SET
    module = EXCLUDED.module,
    name = EXCLUDED.name,
    description = EXCLUDED.description;


-- =====================================================================
-- 2. ADMINISTRACIÓN
--
-- Admin recibe todos los permisos mediante la política existente.
-- Se agrega explícitamente por idempotencia y claridad.
-- =====================================================================

INSERT INTO role_permissions (
    role_code,
    permission_code
)
VALUES
    ('admin', 'credits.view'),
    ('admin', 'credits.create'),
    ('admin', 'credits.verify'),
    ('admin', 'credits.decide')
ON CONFLICT DO NOTHING;


-- =====================================================================
-- 3. VENDEDOR
--
-- Puede crear solicitudes y consultar créditos.
-- No puede verificar ni decidir.
-- =====================================================================

INSERT INTO role_permissions (
    role_code,
    permission_code
)
VALUES
    ('vendedor', 'credits.view'),
    ('vendedor', 'credits.create')
ON CONFLICT DO NOTHING;


-- =====================================================================
-- 4. COBRADOR
--
-- La verificación pasa a ser responsabilidad del Cobrador.
-- =====================================================================

INSERT INTO role_permissions (
    role_code,
    permission_code
)
VALUES
    ('cobrador', 'credits.view'),
    ('cobrador', 'credits.verify')
ON CONFLICT DO NOTHING;


-- =====================================================================
-- 5. GERENCIA
--
-- Gerencia consulta y decide.
-- No crea solicitudes ni realiza verificaciones.
-- =====================================================================

INSERT INTO role_permissions (
    role_code,
    permission_code
)
VALUES
    ('gerencia', 'credits.view'),
    ('gerencia', 'credits.decide')
ON CONFLICT DO NOTHING;


-- =====================================================================
-- 6. MIGRAR USUARIOS DEL ROL VERIFICADOR
--
-- No se eliminan usuarios.
-- Se conserva:
--   * id
--   * username
--   * nombre
--   * historial
--   * auditoría
--   * estado de la cuenta
--
-- Solamente cambia su rol operativo a `cobrador`.
-- =====================================================================

UPDATE users
SET role = 'cobrador'
WHERE role = 'verificador';


-- =====================================================================
-- 7. ELIMINAR ASIGNACIONES DEL ROL VERIFICADOR
-- =====================================================================

DELETE FROM role_permissions
WHERE role_code = 'verificador';


-- =====================================================================
-- 8. ELIMINAR EL ROL VERIFICADOR
--
-- En este punto ya no existen usuarios asociados a este rol.
-- =====================================================================

DELETE FROM roles
WHERE code = 'verificador';


-- =====================================================================
-- 9. SALVAGUARDAS
--
-- Ningún rol distinto de Admin/Gerencia puede decidir.
-- =====================================================================

DELETE FROM role_permissions
WHERE permission_code = 'credits.decide'
  AND role_code NOT IN ('admin', 'gerencia');


-- Ningún rol distinto de Admin/Vendedor puede crear solicitudes.
DELETE FROM role_permissions
WHERE permission_code = 'credits.create'
  AND role_code NOT IN ('admin', 'vendedor');


-- Ningún rol distinto de Admin/Cobrador puede verificar.
DELETE FROM role_permissions
WHERE permission_code = 'credits.verify'
  AND role_code NOT IN ('admin', 'cobrador');


-- =====================================================================
-- FIN 006
-- =====================================================================