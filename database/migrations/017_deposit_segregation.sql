-- =====================================================================
-- 017 — SEPARACIÓN DE FUNCIONES EN LA VALIDACIÓN DEL DEPÓSITO (bloque 4.2)
--
-- Decisión del propietario (2026-09-18):
--
--     QUIEN CREA UN DEPÓSITO NO PUEDE VALIDAR ESE MISMO DEPÓSITO.
--
-- La validación la hace OTRO usuario con `deposits.review`. Vale igual si lo
-- registró el cobrador que si lo registró administración: que alguien tenga
-- los dos permisos no le autoriza a cerrar su propio movimiento de caja.
--
-- No crea estados, ni roles, ni permisos: el flujo sigue siendo
-- REVISADO -> VALIDADO y los permisos son los de la migración 016.
--
-- Va en la base y no solo en el servicio porque es una regla de control
-- interno: si únicamente la impusiera la aplicación, se saltaría con un
-- UPDATE directo.
--
-- Se declara NOT VALID a propósito: la restricción se aplica a TODA
-- inserción y actualización a partir de ahora, pero no obliga a revalidar
-- filas históricas. No se reinterpreta ni se modifica ningún depósito ya
-- existente.
--
-- Migración ADITIVA y RE-EJECUTABLE. No borra datos.
-- =====================================================================

ALTER TABLE deposits DROP CONSTRAINT IF EXISTS deposits_validator_is_not_creator;

ALTER TABLE deposits ADD CONSTRAINT deposits_validator_is_not_creator
    CHECK (validated_by IS NULL OR validated_by <> created_by) NOT VALID;

COMMENT ON CONSTRAINT deposits_validator_is_not_creator ON deposits IS
    'Separación de funciones: quien registra un depósito no puede validarlo. La validación corresponde a otro usuario con deposits.review.';

-- =====================================================================
-- FIN 017
-- =====================================================================
