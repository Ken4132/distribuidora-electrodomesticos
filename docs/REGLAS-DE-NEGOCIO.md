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

> **Alcance (bloque 3.1).** R1 describe las reglas **históricas del módulo de
> ventas** (`sales`), que siguen gobernando las ventas existentes y no se
> reinterpretan. Las **solicitudes de crédito nuevas** usan las reglas
> vigentes de la sección 9 (4 cuotas +40 %, etc.). Unificar el módulo de
> ventas con las reglas vigentes es parte del bloque 3.3.

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

### P1 — Se aplican a la cuota más antigua ✅ DEFINIDA (bloque 4)

Todo pago se asigna automáticamente a la cuota pendiente más antigua, y si
sobra dinero continúa con la siguiente. **No se puede elegir a qué cuota
aplicar un pago.**

Cada asignación queda registrada en `payment_allocations`, así que siempre se
sabe qué parte de cada pago cubrió qué cuota.

### P2 — Pago anticipado permitido, sin descuento ✅ DEFINIDA (bloque 4)

Se puede pagar antes del vencimiento. El pago anticipado:

- **no** reduce el número de cuotas,
- **no** da descuento por pronto pago,
- simplemente adelanta el llenado de las cuotas siguientes.

Un cliente que paga todo el primer día queda con la venta `pagada`, con el
mismo total que si hubiera pagado en 8 meses.

### P3 — Pago parcial permitido ✅ DEFINIDA (bloque 4)

Se acepta cualquier monto mayor a cero, aunque sea menor a la cuota. La cuota
queda `parcial` (o `vencida` si ya pasó su fecha) con el saldo restante.

No hay monto mínimo de abono.

### P4 — Sobrepago prohibido ✅ DEFINIDA (bloque 4)

Un pago mayor al saldo pendiente **se rechaza** con un error claro. No se
generan saldos a favor ni anticipos para futuras compras.

El formulario limita el monto y ofrece dos atajos: "cuota completa" y
"saldar todo".

### P5 — Venta completamente pagada ✅ DEFINIDA (bloque 4)

Cuando lo pagado cubre el total:

- la venta pasa a `pagada`,
- desaparece de cuentas por cobrar,
- **no admite más pagos** (error 409),
- se emite el evento `sale.paid` para n8n.

### P6 — Métodos de pago ✅ DEFINIDA (2026-09-18)

Los métodos **operativos** son cinco:

**efectivo · transferencia · depósito · remesa · tarjeta**

`cheque` y `otro` se retiraron de la operación: el cheque prácticamente no se
usa y "otro" era un comodín innecesario. Un pago **nuevo** con cualquiera de
los dos se rechaza en el validador, en el servicio y en la base de datos
(`trg_payments_method_operativo`).

Los pagos **ya registrados** con esos métodos se conservan intactos: se leen,
se consultan, se cobran y se anulan igual que siempre, conservando su método
original. No se convierten ni se reinterpretan, y la restricción de la base
los sigue admitiendo para que ninguna fila guardada deje de ser válida.

Se puede anotar una referencia (número de boleta o correlativo) y
observaciones; cuándo es obligatoria lo define PG9.

### P7 — Anulación de pago (solo admin) ✅ DEFINIDA (bloque 4, ver §13 PG3)

Un pago se puede anular y el saldo vuelve a subir. El pago queda en el
historial marcado como `anulado`, con su motivo, y **sus asignaciones a cuotas
se conservan**: las vistas solo suman los pagos en estado `aplicado`, así que
el saldo sube sin destruir la trazabilidad de a qué cuota fue cada quetzal.

Desde el bloque 4 solo se anula el **último pago aplicado** de la venta
(§13 PG3), y la fecha real del pago tiene límites propios (§13 PG1).

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

### V4 — Anulación de venta ✅ DEFINIDA (2026-09-17, ver CV6 y §12 V4b)

Solo el rol `admin` puede anular, solo si la venta **no tiene pagos aplicados**
(si los tiene, primero se anulan los pagos), y hay que escribir un motivo. El stock
vuelve a la sucursal de la que salió. Nada se borra.

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

### U1 — Cinco perfiles ✅ DEFINIDA (tesis, Tabla 6)

Sustituye a la versión anterior de esta regla, que asumía dos roles. Los
perfiles son los cinco actores con acceso al sistema de la Tabla 6:

| Rol | Nombre | Alcance | Evidencia |
| --- | ------ | ------- | --------- |
| `admin` | Administrador | Todo | Tabla 6; actor único de CUP-05; RN-0004 |
| `vendedor` | Ventas | Clientes, catálogo (sin costos), ventas, y **cobranza de su propia cartera** | Tabla 6; CUP-01; §1.6.3 |
| `cobrador` | Cobrador | Consulta de clientes y ventas, **cobranza completa** | Tabla 6; CUP-03; §1.6.3 |
| ~~`verificador`~~ | ~~Verificador~~ | **Eliminado en la migración 006** (decisión del propietario): la verificación es una función del Cobrador (`credits.verify`). Sus usuarios pasaron a `cobrador` sin perder historial | Tabla 6; CUP-02 pasos 4-5 |
| `gerencia` | Gerencia | Solo el panel de inicio. Los reportes llegan con REQ-0013 | Tabla 6; CUP-04 |

El sexto actor de la Tabla 6, **Cliente**, no es un rol del sistema: la propia
tabla lo describe como actor externo que *"no accede directamente al sistema"*.

Desde la migración `003` los roles y sus permisos **son datos, no código**:
viven en las tablas `roles`, `permissions` y `role_permissions`, y el
administrador los cambia desde la pantalla de usuarios sin tocar el sistema
(REQ-0011). El cambio surte efecto de inmediato, sin reiniciar.

Sobre el §1.6.3, que menciona *"tres perfiles principales"*: no contradice a
la Tabla 6. Dice **principales**, no únicos, y describe los tres del trabajo
diario. Verificador y Gerencia aparecen como actores en CUP-02 y CUP-04, y la
Tabla 6 les asigna módulos de acceso, a diferencia de Cliente.

> **Pendiente en la tesis.** La Tabla 6 atribuye a Gerencia *"autoriza
> créditos especiales"*, pero RN-0004 da la aprobación a la administración,
> CUP-02 no lista a Gerencia como actor y CUP-04 es de solo consulta. Mientras
> no exista evidencia de ese proceso, Gerencia es un perfil de consulta y
> supervisión. Queda documentado para corregirlo en el documento.

### U6 — El vendedor cobra su propia cartera ⚠️ ASUMIDA

**Procede de la operación real de la empresa, no del documento.** La tesis
sitúa el registro de pagos en el Cobrador y el Administrador en cinco lugares
(Tabla 6, §1.6.3, Figura 7, CUP-03 y §4.2.3), y al Vendedor le da únicamente
*"consulta del estado de las cuentas por cobrar asociadas a sus operaciones"*.
El propietario del proyecto confirmó que en la práctica el vendedor también
cobra a los clientes a quienes vendió a crédito. **Hay que reflejarlo en el
documento** (§1.6.3, Tabla 6 y CUP-03).

Se implementa con permisos de alcance:

| Permiso | Qué permite |
| ------- | ----------- |
| `payments.create` | Cobrar cualquier venta |
| `payments.create.own` | Cobrar **solo ventas a crédito** cuyo `created_by` sea el propio usuario |
| `receivables.view` | Consultar la cartera completa |
| `receivables.view.own` | Consultar **solo los créditos propios** |

Reglas de aplicación:

1. **El permiso global implica al propio.** Quien tiene los dos se comporta
   como global. `.own` es un subconjunto estricto: nunca amplía nada.
2. **Cartera propia = ventas a crédito con `sales.created_by` igual al
   usuario.** Las ventas de contado quedan fuera del alcance propio.
3. **Una venta con `created_by` nulo no es de nadie.** Ocurre si se elimina la
   cuenta que la registró (`ON DELETE SET NULL`); solo la cobra quien tenga el
   permiso global.
4. **La comprobación es del servidor y va dentro de la transacción**, sobre la
   misma fila que ya queda bloqueada con `FOR UPDATE`. Ocultar el botón en la
   interfaz es comodidad, no protección.
5. **Cobrar una venta ajena devuelve 403** con un mensaje claro y deja entrada
   en la bitácora con `result = 'denegado'`.
6. **El alcance no llega a la anulación.** `payments.void` sigue siendo
   exclusivo del administrador, también sobre la cartera propia: cobrar y
   corregir un cobro son cosas distintas.
7. **No existe reasignación de cartera.** La cartera se deriva de quién
   registró la venta; no hay traspaso.

### U3 — El costo solo lo ve el administrador ✅ DEFINIDA (RN-0001, RN-0002)

El campo `cost` de los productos y el `unit_cost` del detalle de venta **no
salen del servidor** hacia quien no tenga el permiso `products.cost.view`. No
se envían en cero ni vacíos: se eliminan de la respuesta. Tampoco viajan los
porcentajes 30/50/70, porque publicar el porcentaje junto al precio de venta
equivale a publicar el costo.

### U4 — Todo queda en la bitácora ✅ DEFINIDA (REQ-0016, RN-0007)

Se registran los inicios de sesión (correctos y fallidos), los accesos
denegados y las altas, cambios y bajas de clientes, productos, ventas, pagos,
usuarios y roles. La bitácora **no se puede modificar ni borrar**: un
disparador de la base de datos rechaza cualquier `UPDATE` o `DELETE`
(RN-0006). No se registran contraseñas ni hashes.

### U5 — El sistema nunca se queda sin administrador ⚠️ ASUMIDA

No se puede desactivar la propia cuenta, ni cambiarse el propio rol, ni dejar
sin permisos de administración al rol `admin`, ni quitar el último
administrador activo. La tesis no lo dice; es una salvaguarda para que el
sistema no quede inutilizable.

### U2 — Sesión de 8 horas ⚠️ ASUMIDA

El token expira a las 8 horas (configurable con `JWT_EXPIRES_IN`). Al expirar
hay que volver a entrar.

---

## 8. Fundación empresarial (bloque 2A)

### N1 — Forma canónica de los datos de negocio ✅ DEFINIDA (bloque 2A)

Todo dato textual **identificable o buscable** se guarda en una sola forma:

```
MAYÚSCULAS + SIN TILDES + ESPACIOS COLAPSADOS + SIN EXTREMOS

'   José   López Álvarez  '  ->  'JOSE LOPEZ ALVAREZ'
```

Se aplica a: nombre, dirección y referencia del cliente; nombre, categoría y
marca del producto; nombre de categoría, de marca y de sucursal.

La normalización se hace en el **backend** (`utils/normalize.js`) y la base de
datos la repite en un disparador (`normalize_business_text()`), de modo que
ningún camino —un script, una carga masiva, psql— deja datos sin normalizar.
Las dos implementaciones se comprueban carácter por carácter con
`npm run test:normalize`.

### N2 — La Ñ se conserva ✅ DEFINIDA (criterio lingüístico)

En español la eñe es una letra propia, no un diacrítico. `PEÑA` y `PENA` son
apellidos distintos y no deben colapsar. Se quitan tildes y diéresis; la eñe
se queda.

### N3 — Alcance: todo dato de negocio escrito por el usuario ✅ DEFINIDA (bloque 2A)

Se normaliza **todo** lo que el usuario escribe como dato de negocio.

En clientes: nombre completo, dirección, referencia de dirección,
**municipio**, **departamento** y **notas**.

En productos: nombre, categoría, marca, **modelo** y **descripción**.

En sucursales, categorías y marcas: el nombre.

### N3b — Qué NO se normaliza así, porque tiene regla propia ✅ DEFINIDA

| Dato | Regla |
| --- | --- |
| Correo | **minúsculas**, sin espacios. Nunca mayúsculas. |
| Teléfono | solo dígitos con `+502` opcional; el formato que ya usaba el proyecto |
| DPI | solo los 13 dígitos |
| Nombre de usuario | la lógica existente; no se toca |
| Contraseñas y tokens | nunca se transforman |
| Códigos de rol, de permiso y demás identificadores técnicos | nunca se transforman |
| Nombre completo de una **cuenta de usuario** | se guarda literal: se copia a la bitácora y debe leerse como lo escribió el administrador |
| Textos que trae el propio sistema | conservan su ortografía normal: no son datos escritos libremente por el usuario |

### N4 — Categorías y marcas sin duplicados por formato ✅ DEFINIDA (bloque 2A)

`Cama`, `CAMA` y `cama` son **una** categoría; `Facenco`, `FACENCO` y
`facenco` son **una** marca. La unicidad se define sobre la forma normalizada
mediante un índice único, así que la base de datos lo impide aunque la
aplicación fallara.

Desactivar una categoría o una marca **no** desvincula los productos
(RN-0006): solo deja de ofrecerse para asignaciones nuevas.

### S1 — Sucursales ✅ DEFINIDA (bloque 2A)

El modelo admite N sucursales desde el primer día. La instalación arranca con
una sola, `PRINCIPAL`, creada por la migración 004 como ancla de
compatibilidad; el administrador debe renombrarla con el nombre real del
local.

Existe siempre **exactamente una sucursal predeterminada** (índice único
parcial). Su papel no es decorativo: es a la que se imputa toda operación que
no declara sucursal. No se puede desactivar, y una sucursal con existencias o
con usuarios activos asignados tampoco.

### S2 — Usuario y sucursal ⚠️ ASUMIDA

`users.branch_id` es **opcional**: administración y gerencia pueden no
pertenecer a ningún local. La migración **no asigna** sucursal a los usuarios
existentes: inventar a qué local pertenece cada quien sería inventar
información de la empresa. El administrador los asigna desde Usuarios.

La pertenencia a sucursal **no** cambia ningún permiso ni alcance en este
bloque. Los roles y el alcance `.own` del bloque 1 siguen exactamente igual.

### I1 — Inventario por sucursal ✅ DEFINIDA (bloque 2A)

Las existencias se desglosan por producto y sucursal en `inventory`, y se
cumple siempre la invariante

```
products.stock  =  SUM(inventory.quantity)  por producto
```

verificable con la vista `v_inventory_mismatch` y con
`GET /api/inventory/mismatches`.

El único camino para cambiar existencias es insertar en `stock_movements`: un
disparador aplica el movimiento al inventario de su sucursal. No existe forma
de mover stock sin dejar rastro, y por eso las dos cifras no pueden
separarse.

### I2 — Límite conocido de esta fase ⚠️ IMPORTANTE

La venta **todavía no declara sucursal**: descuenta de la predeterminada. Por
tanto, trasladar existencias a otra sucursal deja esa mercadería fuera del
alcance del registro de ventas hasta que se implemente la venta por sucursal.
La aplicación avisa explícitamente al hacer un ajuste sobre una sucursal que
no es la predeterminada, y el disparador rechaza con un mensaje claro
cualquier salida que dejaría negativo el inventario de una sucursal.

### CO1 — Histórico de costos ✅ DEFINIDA (bloque 2A)

Cada alta y cada cambio de costo deja una fila en `product_cost_history` con
el costo nuevo, el anterior, el motivo, el momento y el usuario responsable.
La tabla es de **solo añadir**: un disparador rechaza `UPDATE` y `DELETE`
(RN-0006), igual que la bitácora.

El histórico **no** afecta a las ventas: `sale_items.unit_cost` congela el
costo aplicado el día de la venta y ninguna venta se recalcula nunca con el
costo actual.

Se consulta con el permiso `products.cost.view`, el mismo que protege el
costo actual (RN-0001): es el mismo secreto, solo que a lo largo del tiempo.

### I3 — El vendedor opera solo con el inventario de su sucursal ✅ DEFINIDA (bloque 2A)

Regla de negocio definitiva del propietario (2026-09-11).

El vendedor **puede**: consultar el stock de su sucursal; operar únicamente
con él; y consultar, **a título informativo**, cuántas unidades hay en otras
sucursales.

El vendedor **no puede**: modificar inventario de ninguna sucursal —tampoco
la suya—, trasladar, reservar, ni vender con existencias ajenas.

Se implementa con el mismo par de permisos que ya usa la cobranza:

```
inventory.view       -> el inventario de todas las sucursales
inventory.view.own   -> solo el de la sucursal del usuario
inventory.manage     -> ajustar existencias (no tiene variante propia)
```

La sucursal del usuario se lee **de la base de datos en cada petición**, no
del token: si el administrador lo reasigna, el cambio vale en la siguiente
petición y no cuando caduque la sesión.

A un usuario de alcance propio se le **impone** su sucursal: mande lo que
mande en `branch_id`, la consulta se resuelve sobre la suya y la respuesta
incluye un aviso. Consultar la disponibilidad de otras sucursales va por una
ruta distinta que marca fila por fila cuáles unidades son operativas para él
y cuáles solo informativas.

**Límite de esta fase:** la venta todavía no descuenta de la sucursal del
vendedor —eso es el bloque siguiente—. Hoy descuenta de la predeterminada.

### PE1 — Permisos nuevos ✅ DEFINIDA (bloque 2A)

| Permiso | Quién lo tiene |
| --- | --- |
| `branches.view`, `branches.manage`, `branches.assign` | Administrador |
| `inventory.view`, `inventory.manage` | Administrador |
| `inventory.view.own` | Administrador, **Ventas** |
| `categories.manage`, `brands.manage` | Administrador |
| `credits.view` | Administrador, Gerencia *(actualizado en 006/007: significa **todas** las solicitudes)* |
| `credits.verify` | Administrador, **Cobrador** *(006: antes Verificador)* |
| `credits.decide` | Administrador, **Gerencia** — y nadie más |

**Decisión cerrada (2026-09-11):** Cobros y Verificación **no tienen acceso
al módulo de Inventario ni al de Sucursales**, y Gerencia tampoco entra al de
Inventario: consulta Productos, Catálogo, costo actual e histórico de costos,
pero no administra existencias.

Todo lo que cuelga de `/api/inventory` exige `inventory.view`,
`inventory.view.own` o `inventory.manage`, **sin excepciones**; y todo lo que
cuelga de `/api/branches` exige `branches.view` o `branches.manage`. La
consulta informativa de disponibilidad vive en `GET /api/products/:id/inventory`,
bajo `products.view`, porque es información del catálogo y no del módulo de
inventario.

Los tres de créditos son **catálogo reservado**: la aplicación todavía no los
comprueba porque el módulo de créditos llega en un bloque posterior. Se
registran ahora para que la matriz de roles quede montada, y su descripción
lo dice en voz alta en la pantalla de Roles y permisos.

Consultar categorías y marcas no lleva permiso propio: es parte de navegar el
catálogo y va con `products.view`, que el vendedor ya tenía.

### PE2 — Gerencia ✅ DEFINIDA (decisión del propietario, 2026-09-11)

Gerencia consulta el panel, **consulta y decide créditos**, y **consulta el
costo de los productos y su histórico**. Esto amplía lo que el bloque 1 le
había dado (solo `dashboard.view`); `products.view` entra porque sin poder
listar el catálogo no hay dónde consultar un costo.

Gerencia **no** recibe permisos administrativos por ser Gerencia: sigue sin
clientes, ventas, pagos, cobranza, usuarios, roles ni inventario.

El **Cobrador** verifica pero **no decide** (desde 006; antes lo hacía el
rol Verificador, eliminado): tiene `credits.verify` y explícitamente no
`credits.decide`. La migración incluye una salvaguarda que
retira `credits.decide` de cualquier rol que no sea Administrador o
Gerencia.

### PE3 — Flujo de crédito, preparado conceptualmente ⏳ BLOQUE POSTERIOR

El ciclo que tendrá que soportar el bloque de créditos es:

```
Solicitud -> Verificación -> Evaluación -> Decisión -> Aprobado / Rechazado
```

y los tres permisos ya registrados lo cubren:

| Etapa | Permiso | Quién |
| --- | --- | --- |
| Solicitud y consulta | `credits.create`, `credits.view*` | Ver sección 9 (bloque 3.1) |
| Verificación | `credits.verify` | Administración, **Cobrador** |
| Evaluación y decisión | `credits.decide` | **Administración y Gerencia, nadie más** |

Ventas no interviene en la decisión, y el Cobrador no decide: verifica.

*Nota histórica:* en el bloque 2A no había tablas ni endpoints de crédito.
El estado actual está en la sección 9.

---

## 9. Créditos (bloque 3.1)

### CR1 — Reglas comerciales vigentes para operaciones nuevas ✅ DEFINIDA

| Tipo | Plazo | Recargo sobre costo |
| --- | --- | --- |
| Contado | 1 | +30 % |
| PREDEFINIDO | 4 / 5 / 6 / 10 / 12 | +40 / +50 / +60 / +80 / +100 % |
| ESPECIAL | 6 / 7 / 8 / 9 / 10 / 11 / 12 | +60 / +65 / +70 / +75 / +80 / +90 / +100 % |
| ESPECIAL | más de 12 | +100 % y 10 puntos más por cada cuota adicional (13 → +110, 18 → +160, 24 → +220) |

Viven en `backend/src/utils/creditPricing.js`. **No** reutilizan las reglas
históricas de `utils/pricing.js` (+50 % en 4 pagos, +70 % en 8).

- Un plan PREDEFINIDO de `product_financing_plans` debe tener exactamente el
  porcentaje de la regla. La base de datos lo impide desde 007
  (`product_financing_plans_predefined_rule`, `NOT VALID`: no revalida ni
  borra planes anteriores). Si existiera un plan histórico fuera de regla, se
  conserva, aparece en `v_financing_plans_out_of_rule` y el backend lo rechaza
  (409) para solicitudes nuevas.
- ESPECIAL no requiere plan: el precio mínimo es el de la fórmula.
- Redondeo al centavo con el medio centavo hacia arriba (igual que R2).

### CR2 — Precio unitario, cantidad y línea ✅ DEFINIDA (2026-09-16)

`proposed_price` es **precio unitario**. Total de la línea = precio unitario ×
cantidad. El precio mínimo también es unitario. La cuota de cada línea es
(total de la línea ÷ cuotas), sin enganche.

### CR3 — Enganche de la solicitud ✅ DEFINIDA (2026-09-16)

El enganche **propuesto** pertenece al total de la solicitud y está **incluido**
dentro del precio financiado; no se suma encima. No es un pago, no toca saldo,
caja ni cuotas. Financiado = total − enganche. Cuota consolidada =
financiado ÷ cuotas, **solo** si todas las líneas tienen el mismo plazo.

✅ DEFINIDA (confirmada 2026-09-16): el enganche debe ser **estrictamente menor**
que el total de la solicitud; igual o mayor se rechaza con 422.

### CR3b — Mínimos efectivos ✅ DEFINIDA (2026-09-16, tras revisión)

- **Precio mínimo PREDEFINIDO:** `product_financing_plans.minimum_price` no puede
  ser menor que costo × (1 + porcentaje vigente). Ej.: costo Q1000 +40 % = Q1400;
  Q1400 o más es válido, Q1399.99 se rechaza. Lo impone el trigger
  `trg_product_financing_plans_minimum` (008) **solo en configuraciones nuevas o
  al modificar precio, plazo, porcentaje o producto**; los planes existentes no se
  revalidan ni se reescriben (se listan en `v_financing_plans_below_minimum`).
  Si el costo sube después, la solicitud usa MAX(matemático con el costo actual,
  configurado).
- **Cuota mínima efectiva de la línea:** MAX(round(precio mínimo × cantidad ÷
  cuotas), `minimum_installment` del plan × cantidad). `minimum_installment` se
  interpreta **por unidad**, igual que `minimum_price`. En ESPECIAL no hay plan:
  vale la matemática.
- Se congelan el mínimo efectivo (`minimum_*_snapshot`) y lo configurado
  (`configured_minimum_*_snapshot`). Las solicitudes anteriores no se recalculan.
- Una línea con cuota por debajo de la cuota mínima efectiva queda marcada
  `requires_installment_exception`; `requires_exception` = precio **o** cuota.
- Confirmado (2026-09-16): `minimum_installment` es **por unidad**; ante una subida
  de costo el plan **no** se bloquea y se usa el mayor de los dos mínimos.
- Confirmado (2026-09-16): en solicitudes históricas estas marcas son solo
  **informativas y calculadas** en las vistas con las reglas actuales; no se
  modifica ni recalcula ningún dato almacenado.

### CR4 — Excepción de precio por línea ✅ DEFINIDA (2026-09-16)

Vender por debajo del mínimo se **permite registrar**, pero la línea queda
marcada `requires_price_exception` (derivado, no almacenado) y la solicitud
también. La autorización se dará por línea dentro de la única decisión de
Administración o Gerencia (bloque 3.2).

### CR5 — Alcance de consulta ✅ DEFINIDA (2026-09-16)

| Rol | Permiso | Ve |
| --- | --- | --- |
| Vendedor | `credits.view.own` | Solo las solicitudes que creó (en cualquier estado) |
| Cobrador | `credits.view.branch` | Las de **su sucursal** en `SOLICITADO` o `EN_VERIFICACION` |
| Gerencia, Administrador | `credits.view` | Todas |

El filtro va en el SQL. Una solicitud fuera de alcance responde **404** (no se
confirma que exista). La sucursal del usuario se lee de la base de datos,
nunca del token ni del request. No hay asignaciones manuales de cartera.

⚠️ ASUMIDA: "disponible para verificación" = `SOLICITADO` o `EN_VERIFICACION`.

### CR6 — Datos del cliente en la solicitud ✅ DEFINIDA

Nombre, DPI, teléfonos, correo y dirección se copian **de la ficha**. Municipio
y departamento también salen de la ficha cuando existen; el valor del
formulario solo se usa si la ficha no los tiene. Los textos declarados en la
solicitud (vivienda, empleo, referencias, fiador) se normalizan con N1; los
teléfonos y el DPI del fiador solo se limpian. Un trigger `BEFORE INSERT`
(007) aplica la misma normalización como red de seguridad; nunca reescribe
solicitudes existentes.

### CR7 — Doble envío ✅ DEFINIDA (criterio técnico)

La cabecera opcional `Idempotency-Key` evita que un mismo envío se registre
dos veces: repetir la clave devuelve la solicitud ya creada (200,
`replayed: true`); reutilizarla con datos distintos responde 409. La clave es
por usuario.

⏳ PENDIENTE DE DISEÑO: impedir **por regla comercial** que un cliente tenga
dos solicitudes abiertas (o iguales) no está definido y no se implementó.

### CR8 — Errores HTTP ✅ DEFINIDA (criterio técnico)

Datos inválidos 422 · cliente o producto inexistente 400 · cliente, producto,
sucursal, plan o plazo no válidos 422 · plan fuera de regla o clave reutilizada
409 · fuera de alcance o inexistente 404 · sin permiso 403 · sin sesión 401.
Ninguno produce 500.

---

## 10. Flujo de la solicitud (bloque 3.2)

Decisiones definitivas del propietario (2026-09-16). Migración `009_credit_workflow.sql`.

### CF1 — Estados y transiciones ✅ DEFINIDA

`SOLICITADO → EN_VERIFICACION → EN_EVALUACION → APROBADO → VENTA_CONCRETADA → ACTIVO`,
más `RECHAZADO` y `CANCELADO`. Un disparador de base de datos
(`credit_applications_guard_status`) impide cualquier otra transición, aunque se
intente fuera de la API. Cada cambio queda en `credit_application_status_history`.

- La **primera verificación** pasa la solicitud a `EN_VERIFICACION`.
- El Cobrador **concluye** la verificación (`FAVORABLE` o `DESFAVORABLE`) y la
  solicitud pasa a `EN_EVALUACION`. `NECESITA_REVISION` la deja en verificación.
- Puede haber varias verificaciones; todas se conservan (no se editan ni borran).

### CF2 — Decisión ✅ DEFINIDA

- Solo Administración o Gerencia (`credits.decide`), y solo con la verificación
  concluida. Una sola decisión por solicitud; el rechazo es definitivo y exige razón.
- Antes de decidir pueden **modificar** precio, plazo, tipo de plan y enganche.
  Cada cambio guarda valor anterior, nuevo, usuario, fecha y comentario
  (`credit_application_changes`). El mínimo se recalcula con el plan elegido.
- Una línea bajo el mínimo (precio o cuota) solo se aprueba con **autorización
  explícita por línea con motivo**, dentro de la misma decisión
  (`credit_decision_exceptions`: mínimo, propuesto, diferencia, usuario, sucursal, motivo).

### CF2b — Modificación después de la aprobación ✅ DEFINIDA (2026-09-17, ampliada en §12 CF6)

Administración o Gerencia pueden modificar precio, plazo, tipo de plan y enganche
de una solicitud **APROBADA** (hasta concretar la venta). La aprobación **no se
pierde**, no vuelve a `EN_EVALUACION` y no requiere otra decisión: la modificación
y la decisión son eventos independientes. Cada cambio conserva valor anterior,
nuevo, usuario, fecha/hora y comentario, y queda en la bitácora.

Si la modificación deja una línea bajo el mínimo sin una autorización que cubra sus
condiciones nuevas, la misma operación exige autorizarla con motivo. Se guarda
como excepción de origen `MODIFICACION` ligada a la decisión existente (migración
`011_credit_post_approval_changes.sql`). Al concretar, toda línea bajo el mínimo
debe tener una autorización vigente para sus condiciones actuales.

### CF3 — Cancelación ✅ DEFINIDA

- Antes de la decisión: el vendedor que la registró o Administración.
- Aprobada (no vence): solo Administración. Siempre con motivo.

### CF4 — Reconfirmación del cliente existente ✅ DEFINIDA

Si el cliente ya tiene solicitudes o ventas, debe existir una reconfirmación de
sus datos **posterior a su última operación** antes de registrar otra solicitud
(`customer_confirmations`, con foto de los datos y campos cambiados). La API
responde 422 con `reason: CUSTOMER_RECONFIRMATION_REQUIRED`.

### CF5 — Crédito excepcional a precio de contado ✅ DEFINIDA

Mismo flujo con `credit_type = EXCEPCIONAL_CONTADO`: precio público de contado,
enganche Q0, una sola cuota. Administración o Gerencia deciden directamente
(sin verificación obligatoria ⚠️ interpretación de "decisión directa").

---

## 11. Venta concretada desde la solicitud (bloque 3.3)

Migración `010_credit_sales.sql`.

### CV1 — Concreción en una sola operación ✅ DEFINIDA

`APROBADO → VENTA_CONCRETADA → ACTIVO` en la misma transacción: crea la venta
(`payment_mode = 'credito'`, ligada a `credit_application_id`), descuenta
inventario, genera cuotas, registra el enganche real y activa el crédito.
La pueden hacer el vendedor que registró la solicitud, Administración o Gerencia.

### CV2 — Enganche real ✅ DEFINIDA

- Puede ser menor al aprobado (nunca mayor) y siempre menor al total.
- Si es mayor a Q0 se registra como **pago** a la fecha de la venta y se aplica
  FIFO a las cuotas. No existe "cuota 0". Con Q0 no se registra pago.

### CV3 — Cuotas consolidadas ✅ DEFINIDA

Cada línea divide su total entre su plazo (centavos sobrantes en su última
cuota) y se suman por mes. Ejemplo: 12 × Q650 + 6 × Q550 → meses 1–6 = Q1,200,
meses 7–12 = Q650. La primera vence un mes después de la venta, mismo día;
en meses cortos, el último día.

### CV4 — Precios e inventario ✅ DEFINIDA

- Precios congelados de la solicitud aprobada.
- Se descuenta de la sucursal de la solicitud; si no alcanza se bloquea (422 con
  el detalle por producto). Nunca se toma de otra sucursal.

### CV5 — Crédito excepcional ✅ DEFINIDA

Una cuota por el total, vence el mismo día del mes siguiente. La vista
`v_exceptional_credit_control` marca `requires_regularization` cuando tiene saldo
y más de 60 días desde la activación. ⏳ El proceso de regularización queda pendiente.

### CV6 — Anulación de venta ✅ DEFINIDA (2026-09-17)

Aplica a toda venta, incluidas las concretadas desde una solicitud.

- **Sin pagos aplicados:** se anula y el stock vuelve a la sucursal de la que salió
  cada producto en esa venta (movimiento de entrada `anulacion_venta`).
- **Con pagos:** primero se anulan los pagos (Administración); después la venta.
- Nada se borra: la venta queda `anulada`, los pagos `anulado` con motivo y sus
  aplicaciones a cuotas se conservan (las vistas solo suman pagos aplicados).
  Cuotas y líneas se conservan. Todo queda en la bitácora y en `sale.cancelled`.

### CV7 — Puntos abiertos ✅ CERRADOS EN §12 (2026-09-17)

- `POST /sales` todavía permite `credito_4` / `credito_8` directos (módulo anterior).
- Al anular la venta de una solicitud, la solicitud conserva su estado `ACTIVO`
  (la pantalla indica que la venta fue anulada); no hay un estado definido para ese caso.
- La fecha de concreción es la fecha del día.

---

---

## 12. Corrección final del bloque 3.2 / 3.3 ✅ DEFINIDA (2026-09-17)

Migración `012_credit_final_review.sql`. Sustituye lo que en CF2b y CV7 quedaba
abierto.

### CF6 — Modificación después de la aprobación y última revisión ✅ DEFINIDA

Una solicitud APROBADA se puede modificar hasta que se concrete la venta. **No
existe el estado `APROBADO_CON_CAMBIOS`**: la solicitud sigue en `APROBADO` y
conserva su única decisión. Lo que cambia es una bandera,
`credit_applications.requires_final_review`.

| Quién modifica | Permiso | Efecto |
| --- | --- | --- |
| Administración o Gerencia | `credits.decide` | Sigue APROBADO. La modificación **se considera aprobada de inmediato**: no hay segunda decisión, ni verificación nueva, ni revisión pendiente. |
| El vendedor que la registró | `credits.modify.own` | Sigue APROBADO, pero `requires_final_review = true`: **la aprobación anterior ya no basta**. No vuelve a verificación. Cobranza no participa. |

Se puede modificar **precio, plazo, tipo de plan, enganche, productos y
cantidades**. Cada cambio guarda valor anterior, nuevo, usuario, fecha/hora y
motivo en `credit_application_changes`, y el motivo (`comment`) es **obligatorio**
cuando la solicitud ya está aprobada.

**Qué impide concretar.** Mientras `requires_final_review = true`:

- `POST /credit-applications/:id/concretize` responde **409** con
  `reason: FINAL_REVIEW_REQUIRED`, para cualquier usuario;
- el trigger `trg_sales_credit_origin` (012) impide el `INSERT` en `sales`
  aunque se intente por SQL directo.

**La última revisión** (`POST /credit-applications/:id/final-review`, permiso
`credits.review.final`, solo Administración y Gerencia) **no es una segunda
decisión**: no crea otra `credit_decision`.

| Resultado | Efecto |
| --- | --- |
| `CONFIRMADO` | `requires_final_review = false`: ya se puede concretar. Toda línea bajo el mínimo debe autorizarse aquí, con motivo. |
| `RECHAZADO` | La bandera sigue encendida y la venta sigue bloqueada. Exige razón. Administración o Gerencia pueden entonces corregir ellos mismos las condiciones (su modificación confirma) o cancelar la solicitud. |

Cada revisión queda en `credit_final_reviews` (solo inserción) con usuario,
fecha/hora, resultado, comentario y quién dejó la solicitud pendiente. Si
Administración o Gerencia modifican una solicitud que estaba pendiente de
revisión, esa intervención la resuelve y se registra como `CONFIRMADO`: la
bandera nunca se apaga en silencio.

### CF7 — Productos y cantidades de la solicitud ✅ DEFINIDA

- Se pueden **agregar** líneas nuevas y **cambiar la cantidad** de las existentes.
- Una línea **nunca se borra**: se retira con `is_void = true` y conserva
  `voided_at` y `voided_by`. La fila se queda en el expediente, visible, y deja
  de contar en total, cuota, mínimos y excepciones. El `DELETE` físico está
  prohibido por trigger, y una línea retirada no se reactiva ni se edita.
- Retirar exige **motivo** (mínimo 5 caracteres) y la solicitud debe conservar
  al menos una línea vigente.
- Al modificar se recalculan con las reglas y el costo vigentes: total, precio
  mínimo, cuota, mínimos configurados y snapshots. El enganche se revalida
  contra el total nuevo.
- Una línea que queda bajo el mínimo exige **autorización explícita con motivo**,
  ligada a la decisión existente con `source = 'MODIFICACION'`. Al concretar se
  vuelve a comprobar que las condiciones actuales coincidan exactamente con las
  autorizadas (mínimo, propuesto y cuotas): si no, la venta se bloquea.

### PE4 — Permisos adicionales por usuario ✅ DEFINIDA

El rol sigue siendo la base. `user_permissions` concede (`GRANT`) o retira
(`REVOKE`) un permiso a **un usuario concreto**, sin crear roles nuevos:

```text
permiso efectivo = permisos del rol + GRANT del usuario - REVOKE del usuario
```

Caso de uso: un **Cobrador con capacidades de Vendedor**. Un cobrador normal no
vende ni concreta; con `sales.create` concedido registra ventas, y con
`credits.concretize.own` concreta **sus propias** solicitudes. No se crea el rol
`cobrador_vendedor`.

- Lo administra solo Administración (`users.permissions`).
- El cambio surte efecto **de inmediato**, sin reiniciar ni volver a entrar.
- Cada concesión, revocación o retiro queda en `user_permission_changes` (solo
  inserción) con quién, qué permiso, a qué usuario, cuándo y por qué, además de
  la bitácora.

### V4b / CV6b — Anulación de venta ✅ DEFINIDA (sustituye a V4)

```text
VENTA ACTIVA → motivo obligatorio → solo Administración o Gerencia
             → reversión económica → devolución de stock → ANULADA
```

- **Quién:** Administración o Gerencia (`sales.cancel`). Gerencia recibe además
  `sales.view` para poder supervisar, revisar, concretar, anular y auditar.
  La anulación de **pagos** sigue siendo exclusiva de Administración.
- **Motivo obligatorio** (mínimo 5 caracteres).
- **Sin pagos aplicados:** se anula y el stock vuelve a la sucursal de la que
  salió cada producto en esa venta (entrada `anulacion_venta`), nunca a otra.
- **Con pagos:** responde **409** con `reason: PAYMENTS_MUST_BE_VOIDED_FIRST`.
  Primero se anulan los pagos por su proceso formal y auditado; después la venta.
  El **enganche** de un crédito es un pago más: se revierte igual, el saldo
  vuelve a subir y el pago queda `anulado` con su motivo.
- **Nada se borra:** venta, cuotas, líneas, pagos y aplicaciones a cuotas se
  conservan. Las vistas solo suman pagos aplicados.
- **Concurrencia:** la venta se bloquea con `FOR UPDATE` antes de comprobar
  nada, y registrar un pago bloquea esa misma fila. Un pago no puede colarse
  entre la comprobación y la anulación: o entra antes (y la anulación falla con
  409) o espera y encuentra la venta anulada (422).
- **Registro** en `sale_cancellations` (solo inserción): usuario, fecha/hora,
  motivo, venta, solicitud relacionada, total, pagos revertidos y su importe,
  enganche revertido y stock restituido por producto y sucursal.

### CV8 — La solicitud después de anular su venta ✅ DEFINIDA

La solicitud pasa al estado **`VENTA_ANULADA`**, que es **terminal**:

- sale de la cartera activa (`v_customer_accounts` y cobranza ya filtraban por
  venta activa) y del control de regularización del crédito excepcional
  (`v_exceptional_credit_control` excluye las ventas anuladas);
- conserva **todo** su historial: decisión, verificaciones, excepciones,
  modificaciones, revisiones finales y estados;
- **no se reutiliza** para crear otra venta: concretar responde 409 y el índice
  único `ux_credit_applications_sale` lo impide;
- si el cliente vuelve a solicitar crédito se registra una **solicitud nueva**,
  que puede consultar el historial de la anterior en la evaluación.

### V5b — Ventas nuevas a crédito ✅ DEFINIDA (cierra CV7)

Toda venta a crédito **nueva** nace de una solicitud APROBADA y se registra al
concretarla, con `payment_mode = 'credito'` y `credit_application_id`.

`POST /sales` solo admite **`contado`**. `credito_4` y `credito_8` se conservan
**únicamente para las ventas históricas**: se leen, se cobran, se anulan y se
consultan igual que siempre, y sus reglas de precio (+50 % / +70 %) no se
reinterpretan; lo único que ya no se puede es registrar una venta nueva con
ellas. La protección está en tres capas: validador, servicio y base de datos
(`trg_sales_credit_origin`). El formulario de venta tampoco las ofrece.

---

## 13. Pagos — fundación del bloque 4.0 ✅ DEFINIDA (2026-09-18)

Migración `013_payments_foundation.sql`. Esta sección documenta la BASE: las
estructuras y las guardas que sostienen el bloque 4. Los servicios, endpoints
y pantallas llegan en 4.1 y siguientes.

### PG1 — La fecha real del pago tiene límites ✅ DEFINIDA

`payment_date` es la fecha en que el cliente pagó de verdad y `created_at` la
fecha en que se registró en el sistema. **Son dos datos distintos y los dos se
conservan.** La fecha real:

- no puede ser **futura**;
- no puede ser **anterior a la fecha de la venta**;
- sí puede ser anterior a la de registro, incluso meses (un cobro que se
  documenta tarde).

Lo impone el trigger `trg_payments_guard_date` **solo sobre pagos nuevos**: no
revalida ni corrige ninguno de los ya registrados.

### PG2 — El historial de pagos es inmutable ✅ DEFINIDA

Un pago **no se borra jamás**: se anula. La distribución a cuotas
(`payment_allocations`) tampoco se modifica ni se borra, porque es la prueba de
a qué cuota fue cada quetzal. Las tres cosas están protegidas por trigger, no
solo por el servicio.

### PG3 — La anulación va en orden inverso al de aplicación ✅ DEFINIDA

Solo se anula el **último pago aplicado** de la venta. Para anular uno anterior
hay que anular antes los posteriores, y cada anulación queda registrada con su
motivo.

El motivo es el FIFO: las cuotas se llenaron en el orden en que entraron los
pagos, así que anular uno intermedio dejaría una distribución que no
corresponde a ningún recorrido posible. "Último" es el de mayor identificador
—el orden real de aplicación—, no el de fecha más reciente, porque la fecha
puede venir atrasada a propósito (PG1).

⏳ La comprobación equivalente en el servicio, con su mensaje 409, es del
bloque 4.1. Hoy la impone la base de datos.

### PG4 — Estado del comprobante ≠ estado económico ✅ DEFINIDA

`payments.voucher_status` lleva el estado **documental**:
`PENDIENTE_DE_BOLETA`, `EN_REVISION`, `REVISADA`, `RECHAZADA`. Es independiente
del estado económico: un pago en efectivo reduce el saldo en el acto y aun así
queda pendiente de boleta hasta que llegue su respaldo.

Los pagos anteriores al bloque 4 quedan en **NULL**, que significa "anterior al
control documental". La columna no tiene valor por defecto justamente para no
convertirlos de golpe en pagos "pendientes de boleta": eso sería reinterpretar
el histórico. Cada cambio se guarda en `payment_voucher_events` (solo
inserción).

### PG5 — Depósitos ✅ DEFINIDA

Un depósito agrupa varios pagos ya registrados. **No cambia la situación
económica de nada**: el pago ya redujo el saldo cuando se registró. El depósito
es control de caja y conciliación.

| Estado | Cuándo |
| ------ | ------ |
| `REVISADO` | Lo registra quien depositó, declarando lo que llevó al banco |
| `VALIDADO` | Administración o Gerencia lo dan por bueno. **Terminal** |

La **observación**, la **explicación** del empleado y el **rechazo** no son
estados: son eventos de `deposit_events` (solo inserción, con usuario, fecha y
comentario). El depósito sigue `REVISADO` hasta que se valida.

- Un pago pertenece **como mucho a un depósito** (restricción única global).
- El monto **esperado no se almacena**: se calcula sumando los pagos incluidos
  (`v_deposits`). Almacenar un derivado invita a que se desincronice.
- Si lo declarado no coincide con lo cobrado, **se permite registrarlo**: la
  diferencia se ve en la vista y la resuelve el revisor. Una diferencia **no
  revierte ni borra ningún pago**.
- Un depósito validado no vuelve a revisión ni cambia de importe.
- Un pago ya depositado **sí se puede anular** (solo Administración). El
  depósito lo **sigue listando** y `v_deposits` muestra por separado lo
  esperado, lo anulado y lo efectivamente aplicado: la conciliación refleja la
  afectación sin alterar ni ocultar el depósito.

### PG6 — Recibo inmutable ⏳ ESTRUCTURA PREPARADA (bloque 4.2/4.3)

`payment_receipts` guarda el recibo con todo congelado: número, fecha/hora,
cliente, monto, saldo anterior, saldo nuevo, cuotas afectadas (distribución
FIFO), usuario, sucursal, método y depósito/correlativo cuando corresponda.
No se puede editar ni borrar; una corrección se hace **anulando el pago y
emitiendo otro recibo**, nunca reescribiendo el histórico.

**En 4.0 la tabla se crea vacía y nada la escribe todavía.** La emisión, la
numeración y el envío (outbox → n8n → WhatsApp) son del bloque 4.2/4.3. El
fallo de n8n o WhatsApp nunca debe deshacer el pago.

### PG8 — Doble envío al cobrar ✅ DEFINIDA (bloque 4.1)

`POST /payments` admite la cabecera opcional `Idempotency-Key`, **la misma
mecánica que las solicitudes de crédito** (CR7): repetir la clave devuelve el
pago que ya se registró (200, `replayed: true`) y reutilizarla con datos
distintos responde 409. La clave es por usuario, así que dos cobradores no se
estorban. La garantía última es el índice único `ux_payments_request`: aunque
entren dos peticiones a la vez, la base deja pasar una sola.

### PG9 — Respaldo documental al registrar ✅ DEFINIDA (bloque 4.1)

| Método | Referencia | Estado documental inicial |
| ------ | ---------- | ------------------------- |
| Efectivo | opcional | `PENDIENTE_DE_BOLETA` |
| **Remesa** | opcional | `PENDIENTE_DE_BOLETA` |
| Depósito, transferencia | **obligatoria** | `EN_REVISION` |
| Tarjeta | **obligatoria** | `EN_REVISION` |

El criterio es uno solo: si el pago llega con respaldo, entra a revisión; si
no, queda pendiente de boleta. `REVISADA` y `RECHAZADA` son el resultado de la
revisión, que es del bloque 4.2.

**Remesa** (decisión del propietario, 2026-09-18): se trata igual que el
efectivo. Es dinero que entra a caja sin respaldo bancario propio, así que
queda pendiente de boleta y la referencia es opcional. **No crea un estado
documental nuevo**: reutiliza el del efectivo.

La comprobación vive en `applyPaymentToSale`, el único punto por el que pasa
todo el dinero, así que vale igual para el cobro normal y para el enganche de
una venta a crédito. Cada registro deja su primer evento en
`payment_voucher_events`.

El estado inicial de **tarjeta** se deduce del mismo criterio: llega con
comprobante, así que entra a revisión. `cheque` y `otro` ya no aplican: no se
pueden registrar pagos nuevos con ellos.

### PG7 — Lo que queda fuera ⏳

- Permisos y endpoints de depósitos: **bloque 4.2**.
- Revisión del comprobante (`REVISADA` / `RECHAZADA`): **bloque 4.2**.
- Generación y envío de recibos: **bloque 4.2/4.3**.
- Pantallas de cobranza, depósitos y conciliación: **bloque 4.4**.

## 14. Depósitos y conciliación (bloque 4.2) ✅ DEFINIDA (2026-09-18)

Un depósito agrupa pagos **ya registrados**. No mueve dinero: el saldo de la
venta bajó cuando se registró el pago (bloque 4.1). El depósito es **control de
caja**, y por eso nada de lo que ocurra aquí toca cuotas, asignaciones FIFO ni
saldos.

### DP1 — Estados ✅ DEFINIDA

Dos, y no hay más:

| Estado | Cuándo |
| ------ | ------ |
| `REVISADO` | Nace así, al registrarlo quien depositó |
| `VALIDADO` | Administración o Gerencia lo dan por bueno. **Terminal** |

`OBSERVADO`, `EXPLICADO` y `RECHAZADO` son **eventos del historial**, no
estados: el depósito sigue `REVISADO`. Un rechazo no revierte ni saca ningún
pago. La base lo impide por `CHECK`: `UPDATE ... SET status = 'RECHAZADO'`
falla.

### DP2 — Quién hace qué ✅ DEFINIDA (decisión del propietario, 2026-09-18)

| Permiso | Rol | Para qué |
| ------- | --- | -------- |
| `deposits.view` | admin, gerencia, cobrador | Consultar depósitos y conciliación |
| `deposits.create` | admin, **cobrador** | Registrar el depósito e incluir pagos |
| `deposits.review` | admin, gerencia | Observar, rechazar (evento) y validar |
| `deposits.override` | **solo admin** | Incluir un pago cuya venta no tiene sucursal |

El **vendedor no arma depósitos**: cobra su cartera (regla U6) pero no maneja
la caja. **Gerencia no los arma**: supervisa. Explicar una observación lo puede
hacer quien crea depósitos o quien los revisa; el historial guarda quién fue.

### DP2b — Separación de funciones ✅ DEFINIDA (decisión del propietario, 2026-09-18)

**Quien registra un depósito no puede validar ese mismo depósito.** La
validación la hace otro usuario con `deposits.review`.

Vale igual si lo registró el cobrador que si lo registró administración: tener
los dos permisos no autoriza a nadie a cerrar su propio movimiento de caja. El
intento responde 403 (`SELF_VALIDATION`) y deja el depósito intacto en
`REVISADO`.

No crea estados ni roles nuevos. La restricción
`deposits_validator_is_not_creator` (migración 017) lo impide también por SQL
directo.

### DP3 — Sucursal ✅ DEFINIDA

Un depósito pertenece siempre a una sucursal, y es la del usuario que lo
registra (`users.branch_id`), no la que venga en la petición: si el usuario
pide otra, se rechaza con 403. Administración no tiene sucursal asignada, así
que tiene que indicarla.

La sucursal de un **pago** es la de su **venta** (`sales.branch_id`). No se le
añade una columna de sucursal a `payments`: sería un dato derivado que se puede
desincronizar. Un pago de otra sucursal no entra al depósito, y eso lo impide
también un disparador, no solo el servicio.

**Ventas históricas sin sucursal** (anteriores a la migración 005): el pago se
rechaza. Solo **administración** (`deposits.override`) puede incluirlo, y el
historial guarda que fue una excepción y quién la autorizó.

### DP4 — Qué pago puede entrar ✅ DEFINIDA

- Tiene que existir → si no, 404.
- Tiene que estar **aplicado**: un pago **anulado no se incluye** (decisión del
  propietario, 2026-09-18). Lo que sí sigue permitido es **anular un pago que ya
  estaba depositado**.
- Un pago pertenece **como mucho a un depósito** (UNIQUE global). Dos
  inclusiones simultáneas del mismo pago: solo una gana.
- No se admite el mismo pago repetido en la misma petición.
- Un depósito **validado no admite más pagos**.

Las cinco reglas están además en la base (migraciones 013 y 016): por SQL
directo tampoco se pueden saltar.

### DP5 — Conciliación ✅ DEFINIDA

```text
MONTO ESPERADO  = suma de los pagos APLICABLES incluidos   (v_deposits.applied_amount)
MONTO DECLARADO = lo que el empleado declara haber depositado (declared_amount)
DIFERENCIA      = declarado − esperado                     (v_deposits.difference)
```

La diferencia puede ser **cero, positiva o negativa**. No se fuerza a cero, no
revierte ningún pago y **no impide validar**: quien revisa decide y su decisión
queda en el historial con su nombre.

`v_deposits` además expone `expected_amount`, que es el **bruto incluido antes
de anulaciones**, y `voided_amount`. Así se ve que un depósito nació por Q300
aunque hoy queden Q0 aplicados. El nombre `expected_amount` se conserva con el
significado que tiene desde la migración 013 para no reinterpretar lo ya
probado; el monto esperado de la conciliación es `applied_amount`.

### DP6 — Un pago depositado que se anula ✅ DEFINIDA

- **No** se saca del depósito ni se borra la relación.
- Se conserva su monto original.
- La conciliación lo refleja: `expected_amount` sigue contándolo como incluido,
  `voided_amount` lo separa y `applied_amount` baja.
- Queda un evento en el historial del depósito, que además señala el pago.
- El depósito no cambia de estado ni se oculta.

### DP7 — Inmutabilidad ✅ DEFINIDA

- Un depósito **no se elimina** nunca.
- La relación depósito↔pago no se edita ni se borra.
- El historial (`deposit_events`) es de solo inserción.
- Un depósito `VALIDADO` queda **congelado**: ni estado, ni monto, ni fecha, ni
  banco, ni referencia, ni sucursal.
- `validated_by` nunca puede coincidir con `created_by` (DP2b).
- La sucursal de un depósito que ya tiene pagos no se puede cambiar.

No existe edición destructiva ni corrección silenciosa. **Pendiente de definir:**
qué hacer con un depósito registrado por error (ver 4.3).

### DP8 — Auditoría ✅ DEFINIDA

Cada operación deja entrada en la bitácora con el usuario, la cifra y la
diferencia del momento: `deposit.create`, `deposit.payments.add`,
`deposit.observe`, `deposit.explain`, `deposit.reject`, `deposit.validate`. Los
intentos sin permiso quedan como `acceso.denegado`.

### DP9 — Lo que queda fuera ⏳

- Revisión del comprobante del pago (`REVISADA` / `RECHAZADA` en
  `payment_voucher_events`): sigue pendiente, **bloque 4.3**.
- Generación y envío de recibos (`payment_receipts`): **bloque 4.3**.
- Corrección de un depósito registrado por error: **sin definir**.
- Pantallas de cobranza, depósitos y conciliación: **bloque 4.4**.

## 15. Recibos y outbox (bloque 4.3) ✅ DEFINIDA (2026-09-18)

### RC1 — La cadena ✅ DEFINIDA

```text
PAGO  ->  RECIBO INMUTABLE  ->  EVENTO DE OUTBOX
```

Los tres se escriben en la **misma transacción**, dentro de
`applyPaymentToSale`, que es el único punto por el que pasa todo el dinero. Si
algo falla no queda ninguno de los tres: no hay recibos ni eventos huérfanos.
Vale igual para el cobro normal y para el enganche de una venta a crédito.

El recibo se emite **después** de repartir el FIFO, no antes: tiene que llevar
la distribución **real**, no una prevista.

### RC2 — El outbox es el que ya existía ✅ DEFINIDA

4.3 **no crea** una bandeja de salida nueva. `integration_events` (migraciones
001 y 002) ya es un outbox transaccional con idempotencia (`unique_key`),
reintentos con espera creciente (`next_attempt_at`) e historial por intento
(`integration_event_attempts`), y `recordEvent()` ya escribía dentro de la
transacción del pago. Crear otra habría duplicado la lógica y roto el
despachador de n8n.

Lo único que cambia es el **payload** de `payment.created`, que ahora lleva
`receipt_id`, `receipt_number`, `payment_number` y `balance_after`. El envío a
n8n sigue ocurriendo **después del commit**, de forma asíncrona: cobrar nunca
depende de que n8n esté vivo, y desde el servicio de pagos no se llama a
ninguna API externa.

### RC3 — Qué congela el recibo ✅ DEFINIDA

Número, fecha/hora de emisión, pago, venta, cliente, **sucursal de la venta**,
usuario que lo registró, fecha económica, método, monto, **saldo anterior**,
**saldo posterior** y la **distribución FIFO** (cuota, vencimiento e importe de
cada línea). En `snapshot` quedan además el correlativo del pago, el estado
documental del comprobante en ese momento y los datos del cliente.

La sucursal sale de la **venta**, no de quien cobra.

### RC4 — Numeración ✅ DEFINIDA

`R-00000001`, de una secuencia (`next_receipt_number()`). Único en toda la
base.

**Decisión consciente:** una secuencia **puede dejar huecos** (una transacción
que termina en ROLLBACK consume el número). La alternativa —un contador con
bloqueo— serializaría todos los cobros y contradiría las garantías de
concurrencia del bloque 4.1. El recibo es un documento interno de
trazabilidad, no un documento fiscal con exigencia de correlatividad.

### RC5 — Inmutabilidad y correcciones ✅ DEFINIDA

`payment_receipts` es de **solo inserción** (migración 013): no se edita ni se
borra, ni por la aplicación ni por SQL directo. Un pago tiene **como mucho un
recibo**.

Además el recibo tiene que **cuadrar**:
`balance_after = balance_before − amount` (restricción
`payment_receipts_balance_math`).

Una corrección **no reescribe el recibo**: se **anula el pago** con el
mecanismo del bloque 4.1, que no cambia. El recibo se conserva intacto —mismo
número, mismo monto, mismos saldos— y la consulta muestra al lado que su pago
quedó anulado, con motivo, fecha y responsable.

### RC6 — Depósito ✅ DEFINIDA

Cuando se emite el recibo el pago **todavía no está en ningún depósito**: se
incluye después (bloque 4.2). Por eso `deposit_id` nace NULL y **no se
inventa**. La vista `v_payment_receipts` muestra por separado
`current_deposit_number`, que es estado **vivo** del pago, no dato congelado.

### RC7 — Consulta y permisos ✅ DEFINIDA

```text
GET /api/payments/:id/receipt    payments.view
GET /api/receipts                payments.view
GET /api/receipts/:id            payments.view
```

Se usa el **mismo permiso con el que ya se consultan los pagos**: el recibo no
expone nada que el pago no exponga. **No se crea ningún permiso ni rol nuevo.**

El aislamiento por sucursal se ofrece como **filtro** (`branchId`), no como
restricción: hoy `payments.view` es global —el vendedor también lo tiene, en
coherencia con `sales.view`— y convertirlo en un permiso con alcance sería
cambiar una regla del bloque 1.

### RC8 — Los pagos anteriores ✅ DEFINIDA

Los recibos **no se emiten hacia atrás**. Un pago registrado antes de 4.3 no
tiene recibo y consultarlo responde 404 con ese motivo. No se reinterpreta ni
se completa ningún histórico.

### RC9 — Lo que queda fuera ⏳

- Evento `payment.voided` en el outbox: **no existe**. Hoy la anulación se
  rastrea por `payments.voided_*`, la bitácora y el evento del depósito.
- Generación del PDF/impresión del recibo y su envío por WhatsApp: **4.4**.
- Pantallas de recibos: **4.4**.

## 16. Cartera, morosidad y reestructuración (bloque 5) ✅ DEFINIDA (2026-09-18)

### CB1 — Nada de la mora se almacena ✅ DEFINIDA

Días de atraso, saldo vencido y tramo de morosidad se **calculan al
consultar**, a partir de `due_date` y de los pagos aplicados. No hay columnas
de "días restantes", ni estados nuevos de crédito o de cuota. Tramos:

| Tramo | Atraso de la cuota vencida más antigua con saldo |
| ----- | ------------------------------------------------ |
| `AL_DIA` | ninguna vencida |
| `1_30` | hasta 30 días |
| `31_60` | 31 a 60 |
| `61_90` | 61 a 90 |
| `MAS_90` | más de 90 |

### CB2 — Consulta y alcance ✅ DEFINIDA

Se usa el par que ya existe desde el bloque 1: `receivables.view` (toda la
empresa) y `receivables.view.own` (solo los créditos que registró el propio
usuario, regla U6). **No se crea ningún permiso de consulta.** El filtro va en
el SQL: lo que no corresponde al usuario no sale de la base. El detalle de un
crédito ajeno responde **404**, no 403, para no revelar que existe.

```text
GET /api/collections                      cartera
GET /api/collections/summary              resumen por tramo de mora
GET /api/collections/installments         cuotas
GET /api/collections/overdue              solo vencidas
GET /api/collections/customers/:id        cartera de un cliente
GET /api/collections/credits/:id          expediente: cuotas, pagos, recibos, reestructuraciones
GET /api/collections/credits/:id/restructurings
```

### CB3 — Reestructuración y regularización ✅ DEFINIDA

Permiso nuevo `credits.restructure`, **solo Administración y Gerencia**. La
autorización **es** la operación: no hay un segundo proceso de aprobación.

- **No crea una segunda deuda**: es el mismo crédito con otras condiciones.
- Las cuotas anteriores con saldo **no se borran**: se marcan `superseded_at`
  con su historial y sus asignaciones FIFO intactas, y dejan de ser deuda viva.
- Las cuotas nuevas se numeran **a continuación**, así que el FIFO no cambia:
  la más antigua sigue cobrándose primero.
- **NUEVO SALDO = NUEVO TOTAL − LO YA PAGADO.** Lo exige también la base
  (`restructuring_balance_math`). Un total menor que lo pagado se rechaza.
- `sale_restructurings` es de **solo inserción** y guarda la foto de las
  condiciones y cuotas anteriores.
- Solo se reestructuran créditos del flujo actual (`payment_mode = 'credito'`).
  Las ventas históricas `credito_4` / `credito_8` tienen el número de cuotas
  fijado por una restricción de la base y no se reinterpretan.

**Qué figura corresponde la decide el sistema, no quien la pide:**

| Situación | Figura |
| --------- | ------ |
| Crédito excepcional a precio contado con saldo y **más de 60 días** desde la venta | `REGULARIZACION` (obligatoria) |
| Cualquier otro caso | `REESTRUCTURACION` (emergencia / cambio de condiciones) |

Una **regularización** se hace a un plazo mínimo de **6 cuotas mensuales**.

### CB4 — Avisos de cobranza ✅ DEFINIDA

Se usa el **outbox que ya existe** (`integration_events`). No se crea otro y no
se llama a ninguna API externa desde Express: n8n decide canal y texto.

| Evento | Cuándo | Sugerencia de canal |
| ------ | ------ | ------------------- |
| `installment.upcoming` | 3 días antes del vencimiento (`COLLECTIONS_UPCOMING_DAYS`) | mensajería |
| `installment.overdue` | desde el día siguiente al vencimiento | mensajería |
| `installment.escalated` | **15 días** de mora (`COLLECTIONS_ESCALATE_DAYS`) | **correo** |
| `sale.restructured` | al reestructurar o regularizar | — |

Todos llevan `unique_key`: repetir el barrido **no duplica el aviso**. El aviso
de mora prolongada se emite **una sola vez** por cuota. Una cuota sustituida
por una reestructuración **deja de generar avisos**.

### CB5 — Lo que queda fuera ⏳

- Credenciales reales de WhatsApp/correo: las pone n8n, no la aplicación.
- Pantallas de cobranza y reestructuración: frontend.
- Reestructurar una venta histórica `credito_4` / `credito_8`.

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



| R2 | El precio sale exacto de la fórmula, **sin** redondeo comercial | |
| R3 | **No** se puede poner un precio manual ni hacer descuentos | |
| R5 | El precio **ya incluye** todo (sin línea de IVA) | |
| V2 | Una venta tiene **una sola** modalidad de pago | |
| V3 | **No** se puede vender sin stock | |
| V4b | Anulan Administración y Gerencia; con pagos, primero se anulan los pagos | |
| CL2 | El teléfono debe ser **guatemalteco de 8 dígitos** | |
| CL4 | **No** se puede desactivar un cliente con saldo | |
| U2 | La sesión dura **8 horas** | |
| U5 | No se puede quitar al **último administrador activo** | |
| U6 | El vendedor cobra **solo los créditos que él registró** | |
| U6 | Las ventas de **contado** NO entran en la cartera propia del vendedor | |
| N3 | `notes`, `description`, municipio y departamento se guardan **normalizados** | |
| I3 | El vendedor **no** ajusta inventario, ni siquiera el de su sucursal | |
| I3 | El vendedor **sí** puede ver cuántas unidades hay en otras sucursales | |
| PE2 | Gerencia **decide** créditos y **ve** costos; el Cobrador verifica y **no** decide | |
| CR5 | "Por verificar" = `SOLICITADO` o `EN_VERIFICACION` (alcance del Cobrador) | |
| S2 | La migración **no** asigna sucursal a los usuarios existentes | |
| I2 | Trasladar stock fuera de la predeterminada lo deja **fuera** de las ventas | |
| PE1 | Solo el **administrador** ve sucursales e inventario por sucursal | |
| CF1 | `NECESITA_REVISION` deja la solicitud en verificación | |
| CF5 | El crédito excepcional se decide **sin** verificación previa | |
| CV8 | Al anular su venta, la solicitud queda en `VENTA_ANULADA` y no se reutiliza | |
