-- =====================================================================
-- 015_payment_methods.sql
-- MÉTODOS DE PAGO OPERATIVOS (decisión del propietario, 2026-09-18)
--
-- Los métodos con los que se opera de verdad son cinco:
--
--     EFECTIVO · TRANSFERENCIA · DEPOSITO · REMESA · TARJETA
--
-- CHEQUE y OTRO dejan de ofrecerse: el cheque prácticamente no se usa y
-- "otro" era un comodín que no aporta. REMESA entra como método explícito
-- porque la operación necesita distinguirla.
--
-- COMPATIBILIDAD CON LO YA REGISTRADO — esto es lo importante:
--
--   * `method` NO es un tipo enum, es un CHECK, así que basta con ampliarlo.
--     El CHECK nuevo admite EXACTAMENTE lo mismo que antes MÁS 'remesa': es
--     un superconjunto, de modo que ningún pago ya guardado deja de ser
--     válido y la validación de la restricción pasa sin tocar una sola fila.
--   * Si en la base real existen pagos con 'cheque' u 'otro', se quedan como
--     están: se leen, se consultan, se cobran y se anulan igual que siempre.
--     No se convierten, no se reinterpretan y no se borran.
--   * Lo que se cierra es el REGISTRO DE PAGOS NUEVOS con esos dos métodos,
--     y se cierra también en la base para que no dependa solo del servicio.
--
-- SOLO ADITIVA Y RE-EJECUTABLE.
-- =====================================================================


-- =====================================================================
-- 1. EL CATÁLOGO ADMITE 'remesa' (y conserva los históricos)
-- =====================================================================
ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_method_check;
ALTER TABLE payments
    ADD CONSTRAINT payments_method_check
    CHECK (method IN (
        -- Operativos
        'efectivo', 'transferencia', 'deposito', 'remesa', 'tarjeta',
        -- Históricos: se conservan para los pagos ya registrados.
        'cheque', 'otro'
    ));

COMMENT ON COLUMN payments.method IS
    'Método de pago. Operativos: efectivo, transferencia, deposito, remesa, tarjeta. cheque y otro solo existen en pagos históricos: no se admiten en registros nuevos (trg_payments_method_operativo).';


-- =====================================================================
-- 2. NINGÚN PAGO NUEVO CON UN MÉTODO RETIRADO
--
-- Un CHECK no distingue entre una fila vieja y una nueva, así que la regla
-- va en un trigger BEFORE INSERT: solo mira lo que se está registrando
-- ahora. Los UPDATE quedan fuera a propósito, para que un pago histórico
-- por cheque se pueda seguir anulando con normalidad.
-- =====================================================================
CREATE OR REPLACE FUNCTION payments_method_is_operational() RETURNS trigger
    LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.method IN ('cheque', 'otro') THEN
        RAISE EXCEPTION
            'El método "%" ya no se usa para pagos nuevos. Métodos operativos: efectivo, transferencia, deposito, remesa, tarjeta.',
            NEW.method
            USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_payments_method_operativo ON payments;
CREATE TRIGGER trg_payments_method_operativo
    BEFORE INSERT ON payments
    FOR EACH ROW EXECUTE FUNCTION payments_method_is_operational();

-- =====================================================================
-- FIN 015
-- =====================================================================
