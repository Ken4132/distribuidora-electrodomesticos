/**
 * BLOQUE 4.0 — fundación del sistema de pagos.
 *
 *   npm run test:payments-base
 *
 * Esta prueba es ESTRUCTURAL: comprueba que la base de datos ya sostiene las
 * reglas cerradas del bloque 4 antes de escribir los servicios. La batería
 * funcional de FIFO, depósitos y recibos pertenece a 4.1 / 4.2 / 4.3.
 *
 * Trabaja directamente contra PostgreSQL (no contra la API) a propósito: lo
 * que se está verificando es que las reglas se sostienen aunque alguien
 * escriba SQL a mano, que es la única garantía real.
 *
 * NO crea usuarios ni datos de negocio permanentes: todo ocurre dentro de
 * transacciones que se deshacen al terminar.
 */
import { pool, closePool } from '../config/db.js';
import { config } from '../config/env.js';

let passed = 0;
let failed = 0;
const c = { ok: '\x1b[32m', bad: '\x1b[31m', dim: '\x1b[2m', off: '\x1b[0m' };

function check(name, condition, extra = '') {
    if (condition) {
        passed += 1;
        console.log(`  ${c.ok}PASA${c.off}  ${name}`);
    } else {
        failed += 1;
        console.log(`  ${c.bad}FALLA${c.off} ${name} ${c.dim}${extra}${c.off}`);
    }
}

/** Ejecuta SQL esperando que falle; devuelve el error (o null si pasó). */
async function fails(client, sql, params = []) {
    await client.query('SAVEPOINT sp');
    try {
        await client.query(sql, params);
        await client.query('ROLLBACK TO SAVEPOINT sp');
        return null;
    } catch (error) {
        await client.query('ROLLBACK TO SAVEPOINT sp');
        return error;
    }
}

const exists = async (client, sql, params = []) => (await client.query(sql, params)).rows[0];

async function main() {
    console.log('\n=== Bloque 4.0: fundación del sistema de pagos ===\n');

    // ESTADO DE PARTIDA.
    //
    // La base real es ACUMULATIVA: los datos de la operación y de las suites
    // anteriores siguen ahí y deben seguir. Esta prueba no puede exigir que
    // esté vacía; lo único que le corresponde exigir es que ELLA no la cambie.
    // Se mide antes y después, y se compara.
    const { rows: [antes] } = await pool.query(
        `SELECT (SELECT COUNT(*) FROM deposits)::int         AS depositos,
                (SELECT COUNT(*) FROM deposit_payments)::int  AS depositos_pagos,
                (SELECT COUNT(*) FROM deposit_events)::int    AS depositos_eventos,
                (SELECT COUNT(*) FROM payment_receipts)::int  AS recibos,
                (SELECT COUNT(*) FROM payments)::int          AS pagos,
                (SELECT COUNT(*) FROM sales)::int             AS ventas,
                (SELECT COUNT(*) FROM customers)::int         AS clientes`);

    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        // ------------------------------------------------ 1. ESTRUCTURA
        console.log('[1] Estructura creada por la migración 013');

        const tablas = await client.query(
            `SELECT table_name FROM information_schema.tables
              WHERE table_name IN ('deposits','deposit_payments','deposit_events',
                                   'payment_voucher_events','payment_receipts')`
        );
        check('Existen las cinco tablas nuevas del bloque 4',
            tablas.rows.length === 5, tablas.rows.map((r) => r.table_name).join(', '));

        const voucher = await exists(client,
            `SELECT is_nullable, column_default FROM information_schema.columns
              WHERE table_name = 'payments' AND column_name = 'voucher_status'`);
        check('`payments.voucher_status` existe, es NULL y NO tiene valor por defecto',
            voucher?.is_nullable === 'YES' && voucher?.column_default === null,
            JSON.stringify(voucher));

        // Lo que hay que comprobar es que la vista EXISTE y se puede leer con
        // esta misma conexión. Exigir que devuelva cero filas era medir el
        // estado global de la base, no la migración: contra una base real y
        // acumulativa ahí ya hay depósitos de la operación, y debe haberlos.
        const vistaDefinida = await exists(client,
            `SELECT COUNT(*)::int AS n FROM pg_views WHERE viewname = 'v_deposits'`);
        const vista = await exists(client, `SELECT COUNT(*)::int AS n FROM v_deposits`);
        check('La vista de conciliación v_deposits existe y es consultable con esta conexión',
            vistaDefinida?.n === 1 && Number.isInteger(vista?.n) && vista.n >= 0,
            JSON.stringify({ definida: vistaDefinida?.n, filas_visibles: vista?.n }));

        const indices = await client.query(
            `SELECT indexname FROM pg_indexes
              WHERE indexname IN ('ix_payments_sale_aplicado','ix_payments_created_by',
                                  'ix_payments_voucher_status','ix_deposits_branch_status',
                                  'ix_deposit_events_deposit','ix_payment_voucher_events_payment')`
        );
        check('Están los índices que necesitarán las consultas del bloque 4',
            indices.rows.length === 6, indices.rows.map((r) => r.indexname).join(', '));

        // ------------------------------------------------ 2. DATOS DE APOYO
        // Cliente, producto, venta y cuotas mínimos, dentro de la transacción.
        // La sucursal y el usuario se crean DENTRO de la transacción cuando la
        // base está recién migrada: así la prueba no depende de `seed` ni deja
        // nada detrás (todo se deshace con el ROLLBACK final).
        const stamp = Date.now().toString().slice(-9);
        const { rows: [branch] } = await client.query(
            `WITH existente AS (SELECT id FROM branches ORDER BY id LIMIT 1),
                  nueva AS (
                      INSERT INTO branches (code, name)
                      SELECT 'PB4' || $1, 'SUCURSAL PRUEBA BLOQUE 4'
                       WHERE NOT EXISTS (SELECT 1 FROM existente)
                      RETURNING id
                  )
             SELECT id FROM existente UNION ALL SELECT id FROM nueva`,
            [stamp.slice(-4)]
        );
        const { rows: [user] } = await client.query(
            `WITH existente AS (SELECT id FROM users ORDER BY id LIMIT 1),
                  nuevo AS (
                      INSERT INTO users (username, full_name, password_hash, role)
                      SELECT 'prueba_b4_' || $1, 'USUARIO PRUEBA BLOQUE 4', 'x', 'admin'
                       WHERE NOT EXISTS (SELECT 1 FROM existente)
                      RETURNING id
                  )
             SELECT id FROM existente UNION ALL SELECT id FROM nuevo`,
            [stamp]
        );
        // Desde la migración 017 quien registra un depósito NO puede validarlo,
        // así que esta suite necesita un segundo usuario para la validación.
        const { rows: [revisor] } = await client.query(
            `INSERT INTO users (username, full_name, password_hash, role)
             VALUES ('prueba_b4_rev_' || $1, 'REVISOR PRUEBA BLOQUE 4', 'x', 'admin')
             RETURNING id`,
            [stamp]
        );
        const { rows: [customer] } = await client.query(
            `INSERT INTO customers (dpi, full_name, phone, address)
             VALUES ($1, 'CLIENTE PRUEBA BLOQUE 4', '55550000', 'DIRECCION DE PRUEBA') RETURNING id`,
            [`4${stamp}000`.slice(0, 13)]
        );
        const { rows: [sale] } = await client.query(
            `INSERT INTO sales (customer_id, sale_date, payment_mode, installments_count, subtotal, total, created_by, branch_id)
             VALUES ($1, app_today() - 10, 'contado', 1, 1000, 1000, $2, $3) RETURNING id, sale_date`,
            [customer.id, user.id, branch.id]
        );
        await client.query(
            `INSERT INTO installments (sale_id, number, due_date, amount) VALUES ($1, 1, app_today(), 1000)`,
            [sale.id]
        );
        const nuevoPago = async (amount, date = 'app_today()') => {
            const { rows } = await client.query(
                `INSERT INTO payments (sale_id, customer_id, payment_date, amount, method, created_by)
                 VALUES ($1, $2, ${date}, $3, 'efectivo', $4) RETURNING id`,
                [sale.id, customer.id, amount, user.id]
            );
            return rows[0].id;
        };

        // ------------------------------------------------ 3. FECHA ECONÓMICA
        console.log('\n[2] Fecha real del pago (reglas A9, A11, A12)');

        const futura = await fails(client,
            `INSERT INTO payments (sale_id, customer_id, payment_date, amount, created_by)
             VALUES ($1, $2, app_today() + 1, 100, $3)`, [sale.id, customer.id, user.id]);
        check('Una fecha de pago FUTURA se rechaza',
            futura?.constraint === 'payments_date_not_future', futura?.message);

        const antesDeLaVenta = await fails(client,
            `INSERT INTO payments (sale_id, customer_id, payment_date, amount, created_by)
             VALUES ($1, $2, app_today() - 30, 100, $3)`, [sale.id, customer.id, user.id]);
        check('Una fecha anterior a la fecha de la venta se rechaza',
            antesDeLaVenta?.constraint === 'payments_date_after_sale', antesDeLaVenta?.message);

        const atrasado = await nuevoPago(100, 'app_today() - 5');
        // La comparación se hace en la ZONA OPERATIVA, no con la zona de la
        // sesión: `created_at` es un instante y `created_at::date` cambia de
        // día según con qué zona se lea, así que compararlo sin fijarla haría
        // que la prueba dependiera de la hora a la que se ejecuta.
        const { rows: [fechas] } = await client.query(
            `SELECT to_char(payment_date, 'YYYY-MM-DD')                          AS fecha_real,
                    to_char(created_at AT TIME ZONE $2, 'YYYY-MM-DD HH24:MI:SS') AS registro,
                    (created_at AT TIME ZONE $2)::date - payment_date            AS dias,
                    created_at > (payment_date + 1)::timestamptz                 AS registro_posterior,
                    payment_date >= $3::date                                     AS posterior_a_la_venta
               FROM payments WHERE id = $1`,
            [atrasado, config.timezone, sale.sale_date]);
        check('Una fecha real ANTERIOR al registro sí se acepta y se guardan las dos por separado',
            fechas.dias === 5 && fechas.registro_posterior === true,
            `${fechas.fecha_real} (real) vs ${fechas.registro} (registro) = ${fechas.dias} días`);
        check('La fecha real aceptada es posterior o igual a la de la venta',
            fechas.posterior_a_la_venta === true, `${fechas.fecha_real} vs venta ${sale.sale_date}`);

        // ------------------------------------------------ 4. INMUTABILIDAD
        console.log('\n[3] El historial de pagos es inmutable (regla D)');

        const borrarPago = await fails(client, 'DELETE FROM payments WHERE id = $1', [atrasado]);
        check('Un pago NO se puede borrar físicamente',
            borrarPago?.code === '23001', borrarPago?.message);

        await client.query(
            `INSERT INTO payment_allocations (payment_id, installment_id, amount)
             SELECT $1, id, 100 FROM installments WHERE sale_id = $2 AND number = 1`, [atrasado, sale.id]);
        const tocarAlloc = await fails(client,
            'UPDATE payment_allocations SET amount = 1 WHERE payment_id = $1', [atrasado]);
        check('La distribución FIFO de un pago no se puede modificar',
            tocarAlloc?.code === '23001', tocarAlloc?.message);
        const borrarAlloc = await fails(client,
            'DELETE FROM payment_allocations WHERE payment_id = $1', [atrasado]);
        check('La distribución FIFO de un pago no se puede borrar',
            borrarAlloc?.code === '23001', borrarAlloc?.message);

        // ------------------------------------------------ 5. ORDEN DE ANULACIÓN
        console.log('\n[4] La anulación sigue el orden inverso al de aplicación');

        const segundo = await nuevoPago(200);
        const intermedio = await fails(client,
            `UPDATE payments SET status = 'anulado', voided_at = now(), void_reason = 'prueba'
              WHERE id = $1`, [atrasado]);
        check('No se puede anular un pago intermedio dejando otro posterior aplicado',
            intermedio?.code === '23001' && /último pago aplicado/i.test(intermedio?.message ?? ''),
            intermedio?.message);

        await client.query(
            `UPDATE payments SET status = 'anulado', voided_at = now(), void_reason = 'prueba' WHERE id = $1`,
            [segundo]);
        const ahoraSi = await client.query(
            `UPDATE payments SET status = 'anulado', voided_at = now(), void_reason = 'prueba'
              WHERE id = $1 RETURNING id`, [atrasado]);
        check('Anulado el posterior, el anterior ya se puede anular', ahoraSi.rows.length === 1);
        const { rows: [conservados] } = await client.query(
            'SELECT COUNT(*)::int AS n FROM payment_allocations WHERE payment_id = $1', [atrasado]);
        check('La anulación conserva la distribución original (no se borra nada)', conservados.n === 1);

        // ------------------------------------------------ 6. COMPROBANTE
        console.log('\n[5] Estado documental del comprobante, separado del económico');

        const tercero = await nuevoPago(300);
        const estadoInvalido = await fails(client,
            `UPDATE payments SET voucher_status = 'INVENTADO' WHERE id = $1`, [tercero]);
        check('Solo se admiten los cuatro estados documentales definidos',
            estadoInvalido?.code === '23514', estadoInvalido?.message);

        await client.query(`UPDATE payments SET voucher_status = 'PENDIENTE_DE_BOLETA' WHERE id = $1`, [tercero]);
        const { rows: [documental] } = await client.query(
            'SELECT status, voucher_status FROM payments WHERE id = $1', [tercero]);
        check('Un pago aplicado puede estar PENDIENTE_DE_BOLETA a la vez (ejes independientes)',
            documental.status === 'aplicado' && documental.voucher_status === 'PENDIENTE_DE_BOLETA',
            JSON.stringify(documental));

        // REGLA PG4: los pagos anteriores al bloque 4 conservan voucher_status
        // NULL ("anterior al control documental"). La columna nace sin DEFAULT
        // justamente para eso.
        //
        // Contar TODOS los pagos de la base con estado documental no comprueba
        // esa regla: desde 4.1 la API se lo asigna a cada pago nuevo, que es el
        // comportamiento correcto. Hay que distinguir por FECHA, y el corte
        // exacto es el momento en que se aplicó la migración 013 en ESTA base.
        const { rows: [propios] } = await client.query(
            `SELECT COUNT(*)::int AS n FROM payments
              WHERE sale_id = $1 AND voucher_status IS NOT NULL AND id <> $2`,
            [sale.id, tercero]);
        check('Un pago nacido por SQL no recibe estado documental: solo lo tiene al que se lo pusimos',
            propios.n === 0, `${propios.n} pagos de la venta de prueba con estado documental`);

        const { rows: [previos] } = await client.query(
            `WITH corte AS (
                 SELECT applied_at FROM schema_migrations WHERE filename = '013_payments_foundation.sql'
             )
             SELECT (SELECT applied_at FROM corte) AS corte,
                    (SELECT COUNT(*)::int FROM payments p, corte
                      WHERE p.voucher_status IS NOT NULL
                        AND p.created_at < corte.applied_at) AS n`);
        check('Los pagos ANTERIORES al bloque 4 no se reinterpretan: siguen con voucher_status NULL',
            previos.corte !== null && previos.n === 0,
            previos.corte === null
                ? 'no está registrada la migración 013 en schema_migrations'
                : `${previos.n} pagos anteriores al ${previos.corte} con estado documental`);

        await client.query(
            `INSERT INTO payment_voucher_events (payment_id, from_status, to_status, action, actor_id, comment)
             VALUES ($1, NULL, 'PENDIENTE_DE_BOLETA', 'REGISTRADO', $2, 'alta del pago')`, [tercero, user.id]);
        const eventoInmutable = await fails(client,
            `UPDATE payment_voucher_events SET comment = 'otro' WHERE payment_id = $1`, [tercero]);
        check('El historial del comprobante es de solo inserción',
            eventoInmutable?.code === '23001', eventoInmutable?.message);

        // ------------------------------------------------ 7. DEPÓSITOS
        console.log('\n[6] Depósitos: agrupación, conciliación y trazabilidad');

        const { rows: [deposito] } = await client.query(
            `INSERT INTO deposits (branch_id, declared_amount, reference, bank, created_by, notes)
             VALUES ($1, 300, 'BOL-0001', 'BANCO DE PRUEBA', $2, 'deposito de prueba') RETURNING id, status`,
            [branch.id, user.id]);
        check('Un depósito nace REVISADO', deposito.status === 'REVISADO', deposito.status);

        const estadoRaro = await fails(client,
            `UPDATE deposits SET status = 'RECHAZADO' WHERE id = $1`, [deposito.id]);
        check('No existen más estados que REVISADO y VALIDADO',
            estadoRaro?.code === '23514', estadoRaro?.message);

        await client.query(
            `INSERT INTO deposit_payments (deposit_id, payment_id, added_by) VALUES ($1, $2, $3)`,
            [deposito.id, tercero, user.id]);
        const dosVeces = await fails(client,
            `INSERT INTO deposit_payments (deposit_id, payment_id, added_by) VALUES ($1, $2, $3)`,
            [deposito.id, tercero, user.id]);
        check('Un mismo pago no se puede incluir dos veces', dosVeces?.code === '23505', dosVeces?.message);

        const { rows: [otroDeposito] } = await client.query(
            `INSERT INTO deposits (branch_id, declared_amount, created_by) VALUES ($1, 50, $2) RETURNING id`,
            [branch.id, user.id]);
        const enDos = await fails(client,
            `INSERT INTO deposit_payments (deposit_id, payment_id, added_by) VALUES ($1, $2, $3)`,
            [otroDeposito.id, tercero, user.id]);
        check('Un pago no puede pertenecer a dos depósitos', enDos?.code === '23505', enDos?.message);

        const { rows: [conciliado] } = await client.query(
            'SELECT expected_amount, applied_amount, declared_amount, difference, has_difference, payments_count FROM v_deposits WHERE id = $1',
            [deposito.id]);
        check('La conciliación cuadra cuando lo declarado coincide con lo cobrado',
            conciliado.payments_count === 1 && conciliado.expected_amount === '300.00' &&
                conciliado.difference === '0.00' && conciliado.has_difference === false,
            JSON.stringify(conciliado));

        // Diferencia declarada: se permite registrar y se ve, no se revierte nada.
        await client.query(`UPDATE deposits SET declared_amount = 250 WHERE id = $1`, [deposito.id]);
        const { rows: [conDiferencia] } = await client.query(
            'SELECT difference, has_difference FROM v_deposits WHERE id = $1', [deposito.id]);
        const { rows: [pagoIntacto] } = await client.query(
            'SELECT status, amount FROM payments WHERE id = $1', [tercero]);
        check('Una diferencia se registra y se ve, sin revertir el pago',
            conDiferencia.has_difference === true && conDiferencia.difference === '-50.00' &&
                pagoIntacto.status === 'aplicado' && pagoIntacto.amount === '300.00',
            JSON.stringify({ ...conDiferencia, pago: pagoIntacto }));

        // Trazabilidad: creación, observación, explicación, validación, rechazo.
        for (const [evento, comentario] of [
            ['CREADO', 'deposito registrado'],
            ['OBSERVADO', 'el monto no cuadra'],
            ['EXPLICADO', 'falto una boleta'],
            ['RECHAZADO', 'se rechaza mientras se aclara'],
        ]) {
            await client.query(
                `INSERT INTO deposit_events (deposit_id, event, from_status, to_status, actor_id, comment)
                 VALUES ($1, $2, 'REVISADO', 'REVISADO', $3, $4)`,
                [deposito.id, evento, user.id, comentario]);
        }
        const { rows: [trazabilidad] } = await client.query(
            'SELECT last_event, status FROM v_deposits WHERE id = $1', [deposito.id]);
        check('Observación, explicación y rechazo son eventos del historial, no estados',
            trazabilidad.last_event === 'RECHAZADO' && trazabilidad.status === 'REVISADO',
            JSON.stringify(trazabilidad));

        const eventoBorrado = await fails(client, 'DELETE FROM deposit_events WHERE deposit_id = $1', [deposito.id]);
        check('El historial del depósito no se puede borrar ni editar',
            eventoBorrado?.code === '23001', eventoBorrado?.message);

        // Validación: estado terminal.
        const validarSinUsuario = await fails(client,
            `UPDATE deposits SET status = 'VALIDADO' WHERE id = $1`, [deposito.id]);
        check('No se puede validar sin dejar quién validó y cuándo',
            validarSinUsuario?.code === '23514', validarSinUsuario?.message);

        const autovalidar = await fails(client,
            `UPDATE deposits SET status = 'VALIDADO', validated_by = $2, validated_at = now() WHERE id = $1`,
            [deposito.id, user.id]);
        check('Quien registra un depósito no puede validarlo (separación de funciones)',
            autovalidar?.code === '23514', autovalidar?.message);

        await client.query(
            `UPDATE deposits SET status = 'VALIDADO', validated_by = $2, validated_at = now() WHERE id = $1`,
            [deposito.id, revisor.id]);
        const volverAtras = await fails(client,
            `UPDATE deposits SET status = 'REVISADO', validated_by = NULL, validated_at = NULL WHERE id = $1`,
            [deposito.id]);
        check('Un depósito validado no vuelve a revisión',
            volverAtras?.code === '23001', volverAtras?.message);
        const cambiarMonto = await fails(client,
            `UPDATE deposits SET declared_amount = 999 WHERE id = $1`, [deposito.id]);
        check('El monto de un depósito validado ya no se modifica',
            cambiarMonto?.code === '23001', cambiarMonto?.message);

        // Anular un pago ya depositado: permitido, y el depósito NO lo oculta.
        const anulado = await client.query(
            `UPDATE payments SET status = 'anulado', voided_at = now(), void_reason = 'prueba de conciliacion'
              WHERE id = $1 RETURNING id`, [tercero]);
        const { rows: [trasAnular] } = await client.query(
            'SELECT payments_count, expected_amount, voided_amount, applied_amount, difference FROM v_deposits WHERE id = $1',
            [deposito.id]);
        check('Un pago depositado se puede anular y el depósito lo sigue listando',
            anulado.rows.length === 1 && trasAnular.payments_count === 1 &&
                trasAnular.expected_amount === '300.00' && trasAnular.voided_amount === '300.00' &&
                trasAnular.applied_amount === '0.00',
            JSON.stringify(trasAnular));

        // ------------------------------------------------ 8. RECIBO
        console.log('\n[7] Recibo inmutable (estructura preparada, sin generador)');

        const { rows: [vacia] } = await client.query('SELECT COUNT(*)::int AS n FROM payment_receipts');
        check('La tabla de recibos sigue sin recibos emitidos por la aplicación: 4.0 no los emite',
            vacia.n === antes.recibos, `${vacia.n} recibos (había ${antes.recibos} al empezar)`);

        await client.query(
            `INSERT INTO payment_receipts
                 (payment_id, receipt_number, customer_id, sale_id, branch_id, issued_by,
                  payment_date, method, amount, balance_before, balance_after, allocations, snapshot)
             VALUES ($1, 'R-000001', $2, $3, $4, $5, app_today(), 'efectivo', 300, 1000, 700,
                     '[{"cuota":1,"monto":"300.00"}]'::jsonb, '{"cliente":"CLIENTE PRUEBA BLOQUE 4"}'::jsonb)`,
            [tercero, customer.id, sale.id, branch.id, user.id]);
        const reciboEditado = await fails(client,
            `UPDATE payment_receipts SET amount = 1 WHERE payment_id = $1`, [tercero]);
        check('Un recibo emitido no se puede editar', reciboEditado?.code === '23001', reciboEditado?.message);
        const reciboBorrado = await fails(client,
            `DELETE FROM payment_receipts WHERE payment_id = $1`, [tercero]);
        check('Un recibo emitido no se puede borrar', reciboBorrado?.code === '23001', reciboBorrado?.message);
        const dosRecibos = await fails(client,
            `INSERT INTO payment_receipts
                 (payment_id, receipt_number, customer_id, sale_id, payment_date, method, amount, balance_before, balance_after)
             VALUES ($1, 'R-000002', $2, $3, app_today(), 'efectivo', 300, 1000, 700)`,
            [tercero, customer.id, sale.id]);
        check('Un pago no puede tener dos recibos', dosRecibos?.code === '23505', dosRecibos?.message);

        // ------------------------------------------------ 9. SIN EFECTOS
        await client.query('ROLLBACK');
        const { rows: [despues] } = await pool.query(
            `SELECT (SELECT COUNT(*) FROM deposits)::int         AS depositos,
                    (SELECT COUNT(*) FROM deposit_payments)::int  AS depositos_pagos,
                    (SELECT COUNT(*) FROM deposit_events)::int    AS depositos_eventos,
                    (SELECT COUNT(*) FROM payment_receipts)::int  AS recibos,
                    (SELECT COUNT(*) FROM payments)::int          AS pagos,
                    (SELECT COUNT(*) FROM sales)::int             AS ventas,
                    (SELECT COUNT(*) FROM customers)::int         AS clientes`);
        console.log('\n[8] La prueba no deja rastro');
        const igual = Object.keys(antes).every((k) => antes[k] === despues[k]);
        check('Nada de lo anterior quedó guardado: la prueba deja la base exactamente como estaba',
            igual, `antes ${JSON.stringify(antes)} / después ${JSON.stringify(despues)}`);
    } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
    } finally {
        client.release();
    }

    console.log(`\n=== Resultado: ${c.ok}${passed} correctas${c.off}, ${failed ? c.bad : ''}${failed} fallidas${c.off} ===\n`);
}

main()
    .catch((error) => {
        failed += 1;
        console.error(`\n${c.bad}Error ejecutando la prueba:${c.off}`, error.message);
    })
    .finally(async () => {
        await closePool();
        process.exit(failed === 0 ? 0 : 1);
    });
