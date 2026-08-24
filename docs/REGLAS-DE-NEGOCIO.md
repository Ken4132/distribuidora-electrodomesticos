# Reglas de negocio implementadas

Este documento es la referencia de lo que el sistema hace **hoy**.

Cada regla lleva una marca:

| Marca | Significado |
| ----- | ----------- |
| ✅ **DEFINIDA** | La estableció el propietario del negocio. No se cambia sin su autorización. |
| ⚠️ **ASUMIDA** | No estaba definida. Se eligió un criterio razonable para poder avanzar. **Pendiente de validar.** |

Las reglas ⚠️ están agrupadas al final en una lista de verificación para
revisarlas una por una.

---

## 1. Precios

### R1 — Márgenes por modalidad ✅ DEFINIDA

| Modalidad | Precio de venta | Pagos |
| --------- | --------------- | ----- |
| Contado | costo × 1.30 (costo + 30 %) | 1 |
| Crédito 4 pagos | costo × 1.50 (costo + 50 %) | 4 |
| Crédito 8 pagos | costo × 1.70 (costo + 70 %) | 8 |

**Dónde vive la regla.** En dos lugares, y una prueba verifica que coincidan:

1. **Base de datos** — `products.price_cash`, `price_credit_4` y
   `price_credit_8` son columnas `GENERATED ALWAYS AS ... STORED`
   (`database/migrations/001_init.sql`). Es imposible guardar un precio que no
   respete la regla, ni siquiera escribiendo SQL a mano.
2. **Backend** — `backend/src/utils/pricing.js`, que además publica las reglas
   en `GET /api/sales/payment-modes`.

El **frontend no repite los porcentajes**: los pide a la API. Así la interfaz
no puede quedar desincronizada de la base de datos.

La prueba `[8] Consistencia de la regla de precios entre capas`
(`npm run test:flow`) verifica, para las tres modalidades, que el porcentaje
declarado por la API, el precio calculado por la base de datos y el precio que
realmente se aplica en una venta sean el mismo número.

### R2 — Redondeo ⚠️ ASUMIDA

El precio se redondea a **2 decimales**, con el medio centavo hacia arriba
(`ROUND(cost * 1.30, 2)`). Ejemplo: costo Q777.77 → contado Q1,011.10.

No se redondea a valores "comerciales" (Q999, Q1,000). Si en la práctica
redondeas los precios a la baja o a números cerrados, hay que decidirlo:
hoy el precio sale exacto de la fórmula.

### R3 — Sin precio manual ⚠️ ASUMIDA

No se puede escribir un precio de venta a mano; siempre se deriva del costo.
Si necesitas ofertas, promociones o un precio especial para un cliente, hoy
**no existe** esa posibilidad.

### R4 — El precio se congela en la venta ⚠️ ASUMIDA

Al registrar una venta se guarda el precio unitario, el costo unitario, el
código y el nombre del producto en `sale_items`. Si mañana sube el costo del
producto, las ventas viejas conservan sus cifras originales.

### R5 — Sin impuestos ni descuentos separados ⚠️ ASUMIDA

`subtotal` = `total`. No hay línea de IVA, ni descuentos, ni gastos de envío.
Se asume que el precio ya es el precio final al público.

---

## 2. Fechas y vencimientos

### F1 — Fecha de la venta ⚠️ ASUMIDA

Por defecto es **hoy** en zona `America/Guatemala`, pero el formulario permite
cambiarla (por ejemplo para registrar una venta de ayer). No se valida que la
fecha sea pasada o futura.

### F2 — Contado: una cuota el mismo día ⚠️ ASUMIDA

Una venta de contado **también genera una cuota**, con vencimiento el mismo día
de la venta. Se hizo así para que contado y crédito compartan el mismo
mecanismo de saldo, estado de cuenta y cobranza.

Consecuencia visible: una venta de contado que no se pagó el mismo día aparece
como **vencida** al día siguiente. Si prefieres que el contado no entre a
cobranza, hay que cambiarlo.

### F3 — Primera cuota de crédito: un mes después ⚠️ ASUMIDA

La primera cuota vence **un mes después de la fecha de venta**, no a los 30 días
exactos ni el día 1 del mes siguiente.

Ejemplo: venta del 15/03/2026 → primera cuota el 15/04/2026.

**Esta es la suposición más importante de validar.** Alternativas habituales:
primera cuota a los 15 días, primera cuota el día fijo de cada mes (los 5, los
30), o enganche el día de la venta y primera cuota al mes.

### F4 — Periodicidad mensual ⚠️ ASUMIDA

Las cuotas siguientes vencen cada mes, el mismo día. Un crédito de 8 pagos se
extiende 8 meses.

Si en la práctica cobras quincenal o semanal, hay que parametrizarlo.

### F5 — Meses cortos: último día del mes ⚠️ ASUMIDA

Si el día de la venta no existe en el mes de vencimiento, se usa el último día
de ese mes.

Ejemplo — venta del **31/01/2026**, crédito de 4 pagos:

| Cuota | Vence | Motivo |
| ----- | ----- | ------ |
| 1 | 28/02/2026 | febrero no tiene 31 |
| 2 | 31/03/2026 | vuelve al día 31 |
| 3 | 30/04/2026 | abril no tiene 31 |
| 4 | 31/05/2026 | vuelve al día 31 |

Cada vencimiento se calcula **desde la fecha de venta**, no encadenando el
anterior. Así el día de cobro no se va corriendo hacia atrás mes a mes.
Verificado en la prueba `[9]`.

### F6 — Una cuota vence al final del día ⚠️ ASUMIDA

Una cuota se considera vencida a partir del **día siguiente** a su fecha de
vencimiento. El día del vencimiento todavía está "al día".

El cálculo usa la fecha de Guatemala (`app_today()`), no la del servidor, para
que una cuota no aparezca vencida seis horas antes de tiempo.

### F7 — Formato de las fechas ✅ DEFINIDA (criterio técnico)

Las fechas de negocio (venta, pago, vencimiento) se guardan como `DATE`, sin
hora ni zona: lo que se guarda es exactamente lo que ve el usuario. Las marcas
de tiempo técnicas (`created_at`) se guardan como `TIMESTAMPTZ` en UTC.

### F8 — Sin enganche / prima ⚠️ ASUMIDA

No existe el concepto de enganche. El total se reparte completo entre las
cuotas. Si cobras prima inicial, hay que agregarla.

---

## 3. Cuotas

### C1 — Reparto en partes iguales ⚠️ ASUMIDA

El total se divide entre el número de cuotas. Los centavos que sobran se suman
a la **última** cuota, de modo que la suma de las cuotas sea exactamente el
total (nunca un centavo de más ni de menos).

Ejemplo: total Q1,000.00 en 3 cuotas → Q333.33 + Q333.33 + Q333.34.

### C2 — Sin intereses por mora ⚠️ ASUMIDA

Una cuota vencida no genera recargo. El monto adeudado no crece con el atraso.

### C3 — Estados de cuota y su precedencia ⚠️ ASUMIDA

| Estado | Cuándo |
| ------ | ------ |
| `pagada` | Lo pagado cubre el monto de la cuota |
| `vencida` | No está pagada y la fecha de vencimiento ya pasó |
| `parcial` | No está pagada, no ha vencido, y tiene algún abono |
| `pendiente` | No está pagada, no ha vencido, sin abonos |

**La precedencia importa:** una cuota vencida con abono parcial se reporta
`vencida`, no `parcial` — para cobranza, el atraso pesa más que el abono. El
monto abonado sigue visible en la columna "Pagado".

### C4 — Estados de la cuenta de una venta ⚠️ ASUMIDA

| Estado | Cuándo |
| ------ | ------ |
| `anulada` | La venta fue anulada |
| `pagada` | Lo pagado cubre el total |
| `vencida` | Tiene al menos una cuota vencida |
| `al_dia` | Tiene algún pago y ninguna cuota vencida |
| `pendiente` | Sin pagos y sin cuotas vencidas |

---

## 4. Pagos

### P1 — Se aplican a la cuota más antigua ⚠️ ASUMIDA

Todo pago se asigna automáticamente a la cuota pendiente más antigua, y si
sobra dinero continúa con la siguiente. **No se puede elegir a qué cuota
aplicar un pago.**

Cada asignación queda registrada en `payment_allocations`, así que siempre se
sabe qué parte de cada pago cubrió qué cuota.

### P2 — Pago anticipado permitido, sin descuento ⚠️ ASUMIDA

Se puede pagar antes del vencimiento. El pago anticipado:

- **no** reduce el número de cuotas,
- **no** da descuento por pronto pago,
- simplemente adelanta el llenado de las cuotas siguientes.

Un cliente que paga todo el primer día queda con la venta `pagada`, con el
mismo total que si hubiera pagado en 8 meses.

### P3 — Pago parcial permitido ⚠️ ASUMIDA

Se acepta cualquier monto mayor a cero, aunque sea menor a la cuota. La cuota
queda `parcial` (o `vencida` si ya pasó su fecha) con el saldo restante.

No hay monto mínimo de abono.

### P4 — Sobrepago prohibido ⚠️ ASUMIDA

Un pago mayor al saldo pendiente **se rechaza** con un error claro. No se
generan saldos a favor ni anticipos para futuras compras.

El formulario limita el monto y ofrece dos atajos: "cuota completa" y
"saldar todo".

### P5 — Venta completamente pagada ⚠️ ASUMIDA

Cuando lo pagado cubre el total:

- la venta pasa a `pagada`,
- desaparece de cuentas por cobrar,
- **no admite más pagos** (error 409),
- se emite el evento `sale.paid` para n8n.

### P6 — Métodos de pago ⚠️ ASUMIDA

Efectivo, transferencia, depósito, tarjeta, cheque y otro. Se puede anotar una
referencia (número de boleta) y observaciones.

### P7 — Anulación de pago (solo admin) ⚠️ ASUMIDA

Un pago se puede anular; sus asignaciones se eliminan y el saldo vuelve a
subir. El pago queda visible en el historial marcado como anulado, no se borra.

---

## 5. Ventas e inventario

### V1 — Varios productos por venta ✅ DEFINIDA

Una venta puede llevar varios productos con cantidades distintas. Si se agrega
dos veces el mismo producto, las líneas se consolidan en una sola.

### V2 — Una sola modalidad de pago por venta ⚠️ ASUMIDA

La modalidad (contado / 4 pagos / 8 pagos) aplica a la venta completa, no por
producto. No se puede llevar un producto de contado y otro a crédito en el
mismo documento.

### V3 — No se vende sin stock ⚠️ ASUMIDA

Si la cantidad solicitada supera el stock, la venta se rechaza. No existen
ventas sobre pedido ni stock negativo.

El descuento de stock ocurre dentro de la misma transacción de la venta, con
bloqueo de la fila del producto: dos vendedores simultáneos no pueden vender la
misma última unidad.

### V4 — Anulación de venta ⚠️ ASUMIDA

Solo el rol `admin` puede anular, solo si la venta **no tiene pagos**, y hay
que escribir un motivo. Al anular se devuelve el stock. La venta no se borra.

### V5 — Movimientos de inventario ⚠️ ASUMIDA

Todo cambio de stock (venta, anulación, compra a proveedor, merma, devolución,
conteo físico) queda en `stock_movements` con motivo, cantidad, stock
resultante y usuario.

El stock no se puede editar directamente desde el formulario del producto: solo
mediante un ajuste con motivo.

---

## 6. Clientes

### CL1 — DPI obligatorio y único ✅ DEFINIDA

13 dígitos, sin repetirse. Se acepta escribirlo con espacios o guiones y se
normaliza. La unicidad la garantiza un índice único en la base de datos, no
solo la validación de la aplicación.

### CL2 — Teléfono de Guatemala ⚠️ ASUMIDA

8 dígitos que empiezan con 2, 3, 4, 5, 6 o 7; se admite el prefijo +502. Se
guarda normalizado, sin guiones ni espacios.

Un cliente extranjero o un número de otro país **hoy no se puede registrar**.

### CL3 — Datos obligatorios ⚠️ ASUMIDA

DPI, nombre completo, teléfono y dirección. El correo, el teléfono alterno, el
punto de referencia y las observaciones son opcionales.

### CL4 — Baja lógica, nunca borrado ⚠️ ASUMIDA

Un cliente se desactiva, no se elimina, para no perder el historial. **No se
puede desactivar un cliente con saldo pendiente.** A un cliente inactivo no se
le puede vender hasta reactivarlo.

### CL5 — Geolocalización preparada, no usada ⚠️ ASUMIDA

Las columnas `latitude` y `longitude` existen y la API las acepta, pero la
interfaz todavía no tiene mapa. Está listo para integrarlo después.

---

## 7. Usuarios y acceso

### U1 — Dos roles ⚠️ ASUMIDA

| Rol | Puede |
| --- | ----- |
| `vendedor` | Todo el flujo operativo: clientes, productos, ventas, pagos |
| `admin` | Lo anterior + anular ventas, anular pagos y crear usuarios |

### U2 — Sesión de 8 horas ⚠️ ASUMIDA

El token expira a las 8 horas (configurable con `JWT_EXPIRES_IN`). Al expirar
hay que volver a entrar.

---

## Lista de verificación

Para revisar en la validación local. Marca lo que coincide con la operación
real y señala lo que hay que cambiar.

| # | Regla asumida | ¿Correcta? |
| - | ------------- | ---------- |
| F3 | La primera cuota vence **un mes** después de la venta | |
| F4 | Las cuotas son **mensuales** | |
| F5 | Si el día no existe en el mes, se cobra el **último día del mes** | |
| F2 | El contado genera una cuota que vence **el mismo día** | |
| F8 | **No** se cobra enganche ni prima | |
| C1 | Los centavos sobrantes van a la **última** cuota | |
| C2 | **No** se cobra mora ni recargo por atraso | |
| C3 | Una cuota vencida con abono se muestra **vencida** | |
| P1 | Los pagos se aplican a la cuota **más antigua**, sin poder elegir | |
| P2 | El pago anticipado **no** da descuento ni reduce cuotas | |
| P3 | Se acepta **cualquier** abono parcial, sin mínimo | |
| P4 | El sobrepago se **rechaza** (no hay saldo a favor) | |
| R2 | El precio sale exacto de la fórmula, **sin** redondeo comercial | |
| R3 | **No** se puede poner un precio manual ni hacer descuentos | |
| R5 | El precio **ya incluye** todo (sin línea de IVA) | |
| V2 | Una venta tiene **una sola** modalidad de pago | |
| V3 | **No** se puede vender sin stock | |
| V4 | Solo se anula una venta **sin pagos**, y solo el admin | |
| CL2 | El teléfono debe ser **guatemalteco de 8 dígitos** | |
| CL4 | **No** se puede desactivar un cliente con saldo | |
| U2 | La sesión dura **8 horas** | |
