# Distribuidora de electrodomésticos — Sistema de gestión

Sistema web para registrar la operación comercial de la distribuidora:
clientes, productos, ventas al contado y a crédito, cuotas, pagos y estado de
cuenta, con un puente de eventos preparado para automatizaciones en n8n.

**Estado actual:** núcleo operativo funcional y probado
(Clientes → Productos → Venta → Cuotas → Pagos → Saldo → Evento).

---

## Stack

| Capa           | Tecnología                                              |
| -------------- | ------------------------------------------------------- |
| Backend        | Node.js 20+ · Express · JavaScript (ESM)                 |
| Base de datos  | PostgreSQL 14+ (migraciones SQL versionadas)             |
| Validación     | Zod                                                      |
| Autenticación  | JWT (bcrypt para contraseñas)                            |
| Frontend       | React 18 · Vite · React Router                           |

```
backend/     API REST
  src/config       conexión a BD y variables de entorno
  src/routes       definición de endpoints
  src/controllers  entrada/salida HTTP
  src/services     lógica de negocio y transacciones
  src/models       acceso a datos (SQL parametrizado)
  src/validators   esquemas de validación
  src/middleware   auth, validación, manejo de errores
  src/scripts      migrate · seed · reset · smoke-test
database/
  migrations/      esquema versionado (.sql)
frontend/    aplicación React
```

---

## Puesta en marcha local

### 1. Requisitos

- Node.js 20 o superior
- PostgreSQL 14 o superior

### 2. Crear la base de datos

```sql
CREATE DATABASE distribuidora;
```

### 3. Backend

```bash
cd backend
cp .env.example .env      # en Windows:  copy .env.example .env
```

Edita `backend/.env` y ajusta al menos:

```
DATABASE_URL=postgresql://postgres:TU_PASSWORD@localhost:5432/distribuidora
JWT_SECRET=<cadena aleatoria larga>
SEED_ADMIN_PASSWORD=<tu contraseña de administrador>
```

Genera un `JWT_SECRET` con:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

Luego:

```bash
npm install
npm run migrate     # crea las tablas y vistas
npm run seed        # crea el usuario admin y datos de demostración
npm run dev         # API en http://localhost:4000/api
```

### 4. Frontend

En otra terminal:

```bash
cd frontend
npm install
npm run dev         # aplicación en http://localhost:5173
```

Vite hace proxy de `/api` hacia el backend, así que no hay que configurar CORS
en desarrollo.

### 5. Entrar

Usuario `admin` con la contraseña definida en `SEED_ADMIN_PASSWORD`
(por defecto `Admin123!` — **cámbiala antes de usar el sistema con datos reales**).

---

## Scripts útiles

| Comando                | Qué hace                                                        |
| ---------------------- | --------------------------------------------------------------- |
| `npm run migrate`      | Aplica las migraciones pendientes de `database/migrations`        |
| `npm run seed`         | Crea el administrador y datos de demostración (idempotente)       |
| `npm run db:reset`     | Borra el esquema completo (solo desarrollo)                       |
| `npm run test:flow`    | Prueba de humo del flujo completo contra la API en ejecución      |

---

## Reglas de negocio implementadas

**Precios** (aplicados por la base de datos en columnas generadas, no se pueden
desincronizar del costo):

| Modalidad         | Precio        | Cuotas |
| ----------------- | ------------- | ------ |
| Contado           | costo + 30 %  | 1      |
| Crédito 4 pagos   | costo + 50 %  | 4      |
| Crédito 8 pagos   | costo + 70 %  | 8      |

**Cuotas.** Toda venta genera cuotas, incluida la de contado (una sola, con
vencimiento el mismo día). Las de crédito vencen cada mes a partir del mes
siguiente a la venta. El reparto de centavos se ajusta en la última cuota para
que la suma de las cuotas sea exactamente el total.

**Saldos y estados.** No se guarda ningún campo de "saldo". El saldo, las cuotas
pagadas y el estado de la cuenta se derivan de los pagos en las vistas
`v_installments`, `v_sales` y `v_customer_accounts`. Cada pago queda asignado a
cuotas concretas en `payment_allocations`, de modo que siempre se sabe a qué
cuota se aplicó cada quetzal.

Estados de cuenta: `pendiente` · `al_dia` · `vencida` · `pagada` · `anulada`.

**Inventario.** El stock se descuenta dentro de la misma transacción de la venta,
con bloqueo de fila para evitar sobreventa, y cada movimiento queda registrado en
`stock_movements`.

**Fechas.** Las fechas de negocio (venta, pago, vencimiento) se guardan como
`DATE` sin hora; las marcas de tiempo técnicas como `TIMESTAMPTZ` en UTC. El
"hoy" del negocio se calcula en `America/Guatemala`.

---

## Integración con n8n

La aplicación **no depende de n8n**: primero persiste la información y después
registra el evento en la tabla `integration_events` (patrón *outbox*), dentro de
la misma transacción. El envío al webhook ocurre después del commit y de forma
asíncrona; si n8n está caído, el evento queda pendiente y se reintenta, pero
registrar un cliente, una venta o un pago nunca falla por eso.

Eventos que la aplicación ya emite:

- `customer.created`, `customer.updated`
- `sale.created`, `sale.paid`, `sale.cancelled`
- `payment.created`

Preparados en el diseño, pendientes de un proceso programado:

- `installment.upcoming`, `installment.overdue`

Para activar el envío, en `backend/.env`:

```
N8N_WEBHOOK_URL=https://tu-n8n/webhook/distribuidora
N8N_WEBHOOK_SECRET=<secreto compartido>
N8N_DISPATCH_ENABLED=true
```

Las credenciales de n8n viven **solo** en variables de entorno del backend.
Nunca en el frontend ni en el repositorio.

---

## Seguridad

- Contraseñas con bcrypt; nunca se almacenan en claro.
- JWT con expiración configurable; rutas protegidas por middleware.
- Rate limit global y específico en el login.
- Toda consulta SQL es parametrizada (sin concatenación de valores).
- Validación estricta de entradas con Zod; los campos no declarados se descartan.
- CORS restringido a los orígenes de `CORS_ORIGINS`.
- Helmet para cabeceras de seguridad.
- Los errores internos se registran en el servidor y no se exponen al cliente.
- `.env` está en `.gitignore`; el repositorio solo contiene `.env.example`.

---

## Pendiente (siguientes bloques)

1. Proceso programado que emita `installment.upcoming` / `installment.overdue`
   y despachador con reintentos del outbox.
2. Primera automatización real en n8n (recordatorio de cuota por WhatsApp/correo).
3. Reportes y estados de cuenta imprimibles.
4. Despliegue (backend + PostgreSQL gestionado + build del frontend).
