# Integración con n8n

## La idea en una frase

El sistema **guarda primero y avisa después**. n8n nunca es requisito para
registrar un cliente, una venta o un pago.

```
Registrar pago
   │
   ├─ TRANSACCIÓN ────────────────────────────────┐
   │    pago                                       │
   │    asignación a cuotas                        │  todo o nada
   │    evento en la bandeja de salida             │
   └─ COMMIT ─────────────────────────────────────┘
        │  la operación ya está a salvo
        ▼
   Despachador  ──POST firmado──►  n8n
        │                            │
        ├─ 2xx  → enviado            ├─ notificación
        └─ error → reintento          ├─ recordatorio
                   1m · 5m · 15m      └─ lo que definas
                   1h · 6h · 24h
                   → descartado
```

Si n8n está caído, el evento se queda esperando y se reintenta solo. La venta
ya quedó registrada.

---

## Cómo llega cada evento

**Método:** `POST` al `N8N_WEBHOOK_URL` configurado.

**Cabeceras:**

| Cabecera | Contenido |
| -------- | --------- |
| `Content-Type` | `application/json` |
| `X-Event-Id` | Identificador único del evento. **Úsalo para descartar duplicados.** |
| `X-Event-Type` | `payment.created`, `sale.created`, … |
| `X-Webhook-Timestamp` | Momento del envío, en segundos Unix |
| `X-Signature-256` | `sha256=<hmac>` — ver la sección de seguridad |

**Cuerpo:**

```json
{
  "id": 42,
  "event": "payment.created",
  "aggregate": "payment",
  "aggregate_id": 17,
  "data": { "...": "depende del evento" },
  "emitted_at": "2026-08-24T02:15:33.120Z",
  "source": "distribuidora-electrodomesticos"
}
```

**Entrega "al menos una vez".** Si n8n procesa un evento pero la respuesta se
pierde en el camino, el sistema lo reintentará. Por eso n8n debe guardar los
`X-Event-Id` ya procesados y descartar los repetidos. El receptor de pruebas
(`backend/src/scripts/n8n-receiver.js`) muestra cómo.

---

## Seguridad: firma HMAC-SHA256

El secreto **nunca viaja**. Lo que viaja es una firma calculada con él.

Se firma la cadena `${timestamp}.${cuerpo_crudo}`:

```
firma = "sha256=" + HMAC_SHA256(secreto, timestamp + "." + cuerpo)
```

Esto da tres garantías:

1. **Autenticidad** — solo quien tiene el secreto puede producir esa firma.
2. **Integridad** — si alguien altera un monto en tránsito, la firma no cuadra.
3. **Frescura** — el timestamp va firmado, así que una petición capturada no
   se puede reenviar más tarde (la tolerancia recomendada es 5 minutos).

### Verificación en n8n (nodo Code, modo "Run Once for Each Item")

```javascript
const crypto = require('crypto');

const SECRET = $env.DISTRIBUIDORA_WEBHOOK_SECRET;   // el mismo N8N_WEBHOOK_SECRET
const TOLERANCE_SECONDS = 300;

const headers   = $input.item.json.headers;
const rawBody   = $input.item.json.body;            // requiere "Raw Body" en el Webhook
const timestamp = headers['x-webhook-timestamp'];
const received  = headers['x-signature-256'];

if (!timestamp || !received) {
  throw new Error('Faltan cabeceras de firma');
}

const age = Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp));
if (age > TOLERANCE_SECONDS) {
  throw new Error(`Petición fuera de tolerancia (${age}s)`);
}

const expected = 'sha256=' + crypto
  .createHmac('sha256', SECRET)
  .update(`${timestamp}.${rawBody}`, 'utf8')
  .digest('hex');

const a = Buffer.from(expected);
const b = Buffer.from(String(received));
if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
  throw new Error('Firma inválida');
}

return { json: JSON.parse(rawBody) };
```

> **Importante:** en el nodo Webhook activa la opción **Raw Body**. Si n8n
> reserializa el JSON, los espacios cambian y la firma deja de coincidir.

Comparar con `===` filtra información sobre cuántos caracteres coinciden; por
eso se usa `timingSafeEqual`.

---

## Catálogo de eventos

### `customer.created` · `customer.updated`

```json
{
  "id": 12,
  "dpi": "2589631470101",
  "full_name": "María Elena Gómez Pérez",
  "phone": "55512345",
  "created_at": "2026-08-24T01:10:22.401Z"
}
```

### `sale.created`

```json
{
  "sale_id": 8,
  "sale_number": "V-000008",
  "sale_date": "2026-08-23",
  "payment_mode": "credito_4",
  "total": "2250.00",
  "installments_count": 4,
  "customer": { "id": 3, "dpi": "1478523690102", "full_name": "Carlos Roberto Sicán López", "phone": "42019876" },
  "items": [
    { "code": "EST-004", "name": "Estufa de 4 hornillas", "quantity": 1, "unit_price": "2250.00", "line_total": "2250.00" }
  ],
  "installments": [
    { "number": 1, "due_date": "2026-09-23", "amount": "562.50" },
    { "number": 2, "due_date": "2026-10-23", "amount": "562.50" },
    { "number": 3, "due_date": "2026-11-23", "amount": "562.50" },
    { "number": 4, "due_date": "2026-12-23", "amount": "562.50" }
  ]
}
```

### `payment.created`

```json
{
  "payment_id": 5,
  "receipt_number": "P-000005",
  "sale_id": 8,
  "sale_number": "V-000008",
  "payment_date": "2026-08-23",
  "amount": "562.50",
  "method": "efectivo",
  "allocations": [ { "installment_number": 1, "amount": "562.50" } ],
  "remaining_balance": "1687.50",
  "customer": { "id": 3, "dpi": "1478523690102", "full_name": "Carlos Roberto Sicán López", "phone": "42019876" }
}
```

### `sale.paid`

Se emite en el momento en que un pago termina de saldar la venta.

```json
{
  "sale_id": 8,
  "sale_number": "V-000008",
  "total": "2250.00",
  "paid_on": "2026-12-20",
  "customer": { "id": 3, "dpi": "1478523690102", "full_name": "Carlos Roberto Sicán López", "phone": "42019876" }
}
```

### `sale.cancelled`

```json
{ "sale_id": 8, "reason": "Producto devuelto por el cliente" }
```

### `installment.upcoming`

Cuota que vence dentro de `COLLECTIONS_UPCOMING_DAYS` días (3 por defecto).
**Una sola vez por cuota**, garantizado por la clave de idempotencia.

```json
{
  "installment_id": 7,
  "installment_number": 1,
  "installments_count": 4,
  "sale_id": 8,
  "sale_number": "V-000008",
  "due_date": "2026-09-23",
  "amount": "562.50",
  "paid_amount": "0.00",
  "balance": "562.50",
  "days_to_due": 3,
  "customer": { "id": 3, "dpi": "1478523690102", "full_name": "Carlos Roberto Sicán López", "phone": "42019876", "email": null }
}
```

### `installment.overdue`

Misma forma, con `days_overdue` en lugar de `days_to_due`.

Por defecto se avisa **una sola vez** por cuota. Con
`COLLECTIONS_OVERDUE_REPEAT_DAYS=7` se genera un aviso nuevo cada 7 días de
mora, y ni uno más.

---

## Puesta en marcha

### 1. Crear el flujo en n8n

Importa `docs/n8n/distribuidora-webhook.json`. Trae el nodo Webhook, la
verificación de firma y un enrutador por tipo de evento.

### 2. Guardar el secreto en n8n

Genera uno:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Guárdalo en n8n como variable de entorno `DISTRIBUIDORA_WEBHOOK_SECRET`.
No lo escribas dentro del nodo.

### 3. Configurar el backend

En `backend/.env`:

```ini
N8N_WEBHOOK_URL=https://tu-n8n/webhook/distribuidora
N8N_WEBHOOK_SECRET=<el mismo secreto>
N8N_DISPATCH_ENABLED=true
N8N_DISPATCH_INTERVAL_MS=60000
N8N_TIMEOUT_MS=10000

COLLECTIONS_SCAN_ENABLED=true
COLLECTIONS_UPCOMING_DAYS=3
COLLECTIONS_OVERDUE_REPEAT_DAYS=0
COLLECTIONS_SCAN_INTERVAL_MS=21600000
```

Reinicia el backend. En el arranque debe aparecer:

```
[n8n] Despacho ACTIVO hacia https://tu-n8n/webhook/distribuidora cada 60s
[cobranza] Barrido activo cada 6h (aviso 3 día(s) antes del vencimiento)
```

### 4. Comprobar

Entra al sistema como administrador y abre **Integraciones**. Ahí ves el
estado del puente, cuántos eventos salieron y cuáles fallaron, con el detalle
de cada intento. Los botones **Enviar pendientes** y **Barrer cuotas** fuerzan
la ejecución sin esperar al temporizador.

---

## Política de reintentos

| Intento | Se reintenta después de |
| ------- | ----------------------- |
| 1 | 1 minuto |
| 2 | 5 minutos |
| 3 | 15 minutos |
| 4 | 1 hora |
| 5 | 6 horas |
| 6 | 24 horas |
| 7 | ya no: queda `descartado` |

Un evento descartado no se pierde: sigue en la bandeja con todo su historial y
se puede reenviar a mano desde la pantalla de Integraciones.

Detalles de implementación que importan:

- **`FOR UPDATE SKIP LOCKED`** al tomar eventos: aunque corran dos instancias
  del backend, ninguna envía el mismo evento dos veces.
- **Arriendo de 2 minutos**: si el proceso muere a mitad de un envío, el evento
  vuelve a estar disponible pasado ese tiempo en lugar de quedarse trabado.
- **Un registro por intento** en `integration_event_attempts`, con código HTTP,
  duración, error y un extracto de la respuesta.

---

## Probar sin n8n

```bash
cd backend
npm run test:n8n
```

Levanta un receptor que verifica la firma igual que n8n, arranca la API con el
despacho activado y comprueba 47 cosas: entrega, firma inválida, cuerpo
alterado, reenvío de una petición vieja, duplicados, caída de n8n con
reintento posterior, eventos de cobranza e idempotencia del barrido.

Para dejar el receptor corriendo y mirar lo que llega:

```bash
RECEIVER_SECRET=<tu secreto> RECEIVER_LOG=eventos.jsonl npm run n8n:receiver
```

Modos: `RECEIVER_MODE=ok | fail | slow` para simular fallos y tiempos de espera.

---

## Problemas frecuentes

| Síntoma | Causa y solución |
| ------- | ---------------- |
| n8n responde 401 "Firma inválida" | Los secretos no coinciden, o el nodo Webhook no tiene activado **Raw Body** y n8n reserializó el JSON. |
| "Petición fuera de tolerancia" | El reloj del servidor y el de n8n están desfasados. Sincroniza la hora. |
| Los eventos quedan `pendiente` y no salen | `N8N_DISPATCH_ENABLED` no está en `true`, o falta `N8N_WEBHOOK_URL`. Míralo en la pantalla de Integraciones. |
| Eventos `fallido` que se acumulan | Abre el detalle: el historial de intentos trae el código HTTP y el error exactos. |
| Llegan avisos repetidos de la misma cuota | No debería: hay clave de idempotencia. Revisa que n8n no esté reprocesando por su cuenta y que descarte por `X-Event-Id`. |
| El aviso de cuota llega con un día de diferencia | `APP_TIMEZONE` y `app_today()` deben coincidir. Ver el README. |
