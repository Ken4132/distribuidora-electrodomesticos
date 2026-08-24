# Distribuidora de electrodomésticos — Sistema de gestión

Sistema web para la operación comercial de la distribuidora: clientes,
productos, ventas al contado y a crédito, cuotas, pagos y estado de cuenta,
con un puente de eventos preparado para automatizaciones en n8n.

**Estado:** núcleo operativo funcional y probado.
Flujo completo disponible: Cliente → Producto → Venta → Cuotas → Pago → Saldo → Inventario.

Las reglas de negocio (incluidas las que se asumieron y están pendientes de
validar) están en **[`docs/REGLAS-DE-NEGOCIO.md`](docs/REGLAS-DE-NEGOCIO.md)**.

---

## Requisitos

| Software | Versión mínima | Cómo comprobarlo |
| -------- | -------------- | ---------------- |
| Node.js  | 20             | `node -v`        |
| npm      | 10             | `npm -v`         |
| PostgreSQL | 14           | `psql --version` |

En Windows: instalador oficial de [Node.js](https://nodejs.org) y de
[PostgreSQL](https://www.postgresql.org/download/windows/). Durante la
instalación de PostgreSQL anota la contraseña del usuario `postgres`: hace falta
en el paso 2.

---

## Instalación paso a paso

### 1. Obtener el código

```bash
git clone https://github.com/Ken4132/distribuidora-electrodomesticos.git
cd distribuidora-electrodomesticos
```

### 2. Crear la base de datos

```bash
psql -U postgres -c "CREATE DATABASE distribuidora;"
```

Si `psql` no está en el PATH de Windows, usa **pgAdmin** → clic derecho en
*Databases* → *Create* → *Database…* → nombre `distribuidora`.

### 3. Configurar el backend

```bash
cd backend
cp .env.example .env          # Windows CMD:  copy .env.example .env
```

Abre `backend/.env` y ajusta **tres** valores:

```ini
DATABASE_URL=postgresql://postgres:TU_CONTRASEÑA@localhost:5432/distribuidora
JWT_SECRET=<pega aquí una cadena aleatoria larga>
SEED_ADMIN_PASSWORD=<la contraseña con la que vas a entrar>
```

Para generar el `JWT_SECRET`:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

> Si tu contraseña de PostgreSQL tiene caracteres como `@`, `:`, `/` o `#`,
> usa la **opción B** de `.env.example` (`PGHOST`, `PGUSER`, `PGPASSWORD`…)
> en vez de `DATABASE_URL`, y comenta esa línea.

### 4. Instalar, migrar y sembrar

```bash
npm install
npm run db:setup      # equivale a: npm run migrate && npm run seed
npm run dev           # API en http://localhost:4000/api
```

Deberías ver:

```
[db] Conexión establecida
[api] Escuchando en http://localhost:4000/api  (entorno: development)
[n8n] Despacho de eventos: inactivo (solo outbox)
```

Comprobación rápida: abre <http://localhost:4000/api/health> en el navegador.

### 5. Levantar el frontend

En **otra terminal**, desde la raíz del proyecto:

```bash
cd frontend
cp .env.example .env          # Windows CMD:  copy .env.example .env
npm install
npm run dev                   # aplicación en http://localhost:5173
```

En desarrollo no hay que configurar CORS: Vite hace proxy de `/api` hacia el
backend.

### 6. Entrar

Abre <http://localhost:5173>, usuario `admin` y la contraseña que pusiste en
`SEED_ADMIN_PASSWORD`.

---

## Comprobar que todo funciona

Con el backend levantado:

```bash
cd backend
npm run test:flow
```

Recorre el flujo completo contra la API real (94 verificaciones, incluidos
casos de error, aritmética de precios y cuotas, y consistencia de las reglas
entre capas). Debe terminar en `0 fallidas`.

Prueba en navegador (opcional, con backend **y** frontend levantados):

```bash
cd frontend
npm install --no-save playwright
npx playwright install chromium
npm run test:e2e
```

Recorre la interfaz como una persona (24 verificaciones) y deja capturas en
`frontend/tests/shots/`.

---

## Scripts

### backend

| Comando | Qué hace |
| ------- | -------- |
| `npm run dev` | Levanta la API con recarga automática |
| `npm start` | Levanta la API (producción) |
| `npm run migrate` | Aplica las migraciones pendientes de `database/migrations` |
| `npm run seed` | Crea el administrador y datos de demostración (idempotente) |
| `npm run db:setup` | `migrate` + `seed` |
| `npm run db:reset` | **Borra el esquema completo.** Bloqueado en producción |
| `npm run test:flow` | Prueba de humo del flujo completo (requiere la API levantada) |

### frontend

| Comando | Qué hace |
| ------- | -------- |
| `npm run dev` | Servidor de desarrollo con proxy a la API |
| `npm run build` | Compila a `frontend/dist/` |
| `npm run preview` | Sirve el build compilado |
| `npm run test:e2e` | Prueba en navegador (requiere Playwright, ver arriba) |

`migrate` y `seed` se pueden ejecutar varias veces sin efectos secundarios:
`migrate` salta lo ya aplicado y `seed` no duplica ni pisa el usuario existente.

---

## Estructura del proyecto

```
distribuidora-electrodomesticos/
├── README.md
├── .gitignore
├── docs/
│   └── REGLAS-DE-NEGOCIO.md      reglas definidas y reglas asumidas
├── database/
│   ├── migrations/
│   │   └── 001_init.sql          esquema completo + vistas derivadas
│   └── seeds/                    reservado para cargas de datos en SQL
├── backend/
│   ├── .env.example              plantilla de configuración (sin secretos)
│   ├── package.json
│   └── src/
│       ├── server.js             arranque y apagado ordenado
│       ├── app.js                Express, CORS, helmet, rate limit
│       ├── config/               env.js · db.js (pool y transacciones)
│       ├── routes/               definición de endpoints
│       ├── controllers/          entrada/salida HTTP
│       ├── services/             lógica de negocio y transacciones
│       ├── models/               acceso a datos (SQL parametrizado)
│       ├── validators/           esquemas Zod
│       ├── middleware/           auth · validate · errorHandler
│       ├── utils/                money · pricing · dates · AppError
│       └── scripts/              migrate · seed · reset · smoke-test
└── frontend/
    ├── .env.example
    ├── index.html
    ├── vite.config.js
    ├── package.json
    ├── tests/
    │   └── e2e.mjs               recorrido en navegador
    └── src/
        ├── main.jsx · App.jsx    arranque y rutas
        ├── styles.css
        ├── pages/                Login · Dashboard · Customers ·
        │                         CustomerDetail · Products · NewSale ·
        │                         Sales · SaleDetail · Receivables
        ├── components/           Layout · ProtectedRoute · ui
        ├── context/              AuthContext · ToastContext
        ├── hooks/                useDebounce · usePaymentModes
        ├── services/             api.js (cliente HTTP)
        └── utils/                format.js
```

---

## Modelo de datos

```
customers ──< sales ──< sale_items >── products
                │                          │
                │                          └──< stock_movements
                ├──< installments ──< payment_allocations >── payments
                └──< payments

users        (autenticación)
integration_events   (outbox de eventos hacia n8n)
```

Vistas derivadas (no almacenan nada, se calculan al consultarlas):

- `v_installments` — pagado, saldo y estado de cada cuota.
- `v_sales` — total, pagado, saldo, cuotas pagadas/pendientes/vencidas,
  próximo vencimiento y estado de la cuenta.
- `v_customer_accounts` — estado de cuenta consolidado por cliente.

**No existe ningún campo de "saldo" almacenado.** El saldo se deriva siempre de
los pagos, y cada pago queda asignado a cuotas concretas en
`payment_allocations`. Así no hay forma de que un saldo quede desincronizado.

---

## API

Todos los endpoints cuelgan de `/api` y requieren
`Authorization: Bearer <token>`, salvo `/api/health` y `/api/auth/login`.

| Método | Ruta | Descripción |
| ------ | ---- | ----------- |
| GET | `/health` | Estado de la API y de la base de datos |
| POST | `/auth/login` | Inicio de sesión |
| GET | `/auth/me` | Usuario de la sesión |
| POST | `/auth/users` | Crear usuario (admin) |
| GET | `/dashboard` | Resumen operativo |
| GET | `/customers` | Listado con búsqueda y paginación |
| POST | `/customers` | Crear cliente |
| GET | `/customers/:id` | Ficha con estado de cuenta |
| GET | `/customers/:id/account` | Solo el estado de cuenta |
| PUT | `/customers/:id` | Editar |
| PATCH | `/customers/:id/status` | Activar / desactivar |
| GET | `/products` | Listado con búsqueda, categoría y stock bajo |
| POST | `/products` | Crear producto |
| GET | `/products/:id` | Detalle |
| GET | `/products/categories` | Categorías existentes |
| GET | `/products/price-preview?cost=` | Precios que resultarían de un costo |
| PUT | `/products/:id` | Editar (el stock no se toca aquí) |
| PATCH | `/products/:id/status` | Activar / desactivar |
| POST | `/products/:id/stock` | Ajuste de inventario con motivo |
| GET | `/products/:id/stock-movements` | Historial de inventario |
| GET | `/sales/payment-modes` | Reglas comerciales vigentes |
| POST | `/sales/quote` | Calcular total y cuotas **sin guardar** |
| POST | `/sales` | Registrar venta |
| GET | `/sales` | Listado con filtros |
| GET | `/sales/:id` | Venta con productos, cuotas y pagos |
| PATCH | `/sales/:id/cancel` | Anular (admin) |
| GET | `/payments/methods` | Métodos de pago |
| GET | `/payments/receivables` | Cuentas por cobrar |
| GET | `/payments` | Historial de pagos |
| POST | `/payments` | Registrar pago |
| GET | `/payments/:id` | Detalle de un pago |
| PATCH | `/payments/:id/void` | Anular pago (admin) |

Respuesta correcta: `{ "ok": true, "data": … }`
Respuesta de error: `{ "ok": false, "error": { "code", "message", "details" } }`

---

## Integración con n8n (siguiente etapa, aún no activa)

La aplicación **no depende de n8n**. Primero persiste la información y después
registra el evento en `integration_events`, dentro de la misma transacción
(patrón *outbox*). El envío al webhook ocurre después del commit; si n8n está
caído el evento queda pendiente y registrar un cliente, una venta o un pago
nunca falla.

Eventos que ya se emiten: `customer.created`, `customer.updated`,
`sale.created`, `sale.paid`, `sale.cancelled`, `payment.created`.

Diseñados y pendientes del proceso que los dispare: `installment.upcoming`,
`installment.overdue`.

Para activar el envío, en `backend/.env`:

```ini
N8N_WEBHOOK_URL=https://tu-n8n/webhook/distribuidora
N8N_WEBHOOK_SECRET=<secreto compartido>
N8N_DISPATCH_ENABLED=true
```

Las credenciales de n8n viven **solo** en variables de entorno del backend.
Nunca en el frontend ni en el repositorio.

---

## Seguridad

- Contraseñas con bcrypt; nunca se guardan en claro.
- JWT con expiración; rutas protegidas por middleware y por rol.
- Rate limit global y uno más estricto en el login.
- Todo el SQL es parametrizado: no se concatenan valores en las consultas.
- Validación estricta con Zod; los campos no declarados se descartan, así el
  cliente no puede inyectar columnas que no le corresponden.
- CORS restringido a los orígenes de `CORS_ORIGINS`.
- Cabeceras de seguridad con helmet.
- Los errores internos se registran en el servidor y no se exponen al cliente.
- `.env` está en `.gitignore`; el repositorio solo contiene `.env.example` con
  valores de ejemplo.

Antes de usar el sistema con datos reales: cambia `SEED_ADMIN_PASSWORD`,
genera un `JWT_SECRET` propio y no reutilices las credenciales de ejemplo.

---

## Problemas frecuentes

| Síntoma | Causa y solución |
| ------- | ---------------- |
| `[db] No se pudo conectar a PostgreSQL` | `DATABASE_URL` mal escrita, servicio de PostgreSQL apagado, o la base `distribuidora` no existe. |
| `password authentication failed` | Contraseña incorrecta, o tiene caracteres especiales: usa `PGHOST`/`PGUSER`/`PGPASSWORD` en vez de `DATABASE_URL`. |
| `relation "customers" does not exist` | Falta ejecutar `npm run db:setup`. |
| `Usuario o contraseña incorrectos` en el login | El seed corrió con otra contraseña. Cambia `SEED_ADMIN_PASSWORD` y vuelve a correr `npm run seed` (no pisa el usuario existente: bórralo primero o usa `npm run db:reset`). |
| La página carga pero todo falla con error de conexión | El backend no está levantado, o `VITE_API_TARGET` no coincide con el `PORT` del backend. |
| El puerto 4000 o 5173 está ocupado | Cambia `PORT` en `backend/.env` y `VITE_API_TARGET` / `VITE_PORT` en `frontend/.env`. |
| Las fechas salen un día corridas | Revisa `APP_TIMEZONE`. Al cambiarla hay que actualizar también `app_today()` con una migración. |
| `Demasiados intentos. Espera unos minutos.` | Protección contra fuerza bruta: 10 intentos de login cada 10 minutos. Espera, o reinicia el backend (el contador vive en memoria). Aparece sobre todo al repetir la prueba de navegador varias veces seguidas. |

---

## Siguiente etapa (todavía no implementada)

1. Proceso programado que emita `installment.upcoming` e `installment.overdue`,
   y despachador del outbox con reintentos.
2. Primera automatización real en n8n a partir de `payment.created`.
3. Reportes y estado de cuenta imprimible.
4. Despliegue: PostgreSQL gestionado + backend + build del frontend.
