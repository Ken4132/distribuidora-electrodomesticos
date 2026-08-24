/**
 * PUENTE DE INTEGRACIÓN CON n8n — patrón OUTBOX con despachador confiable.
 *
 * Principio irrenunciable del proyecto: la aplicación NO depende de n8n.
 *
 *   1. La operación comercial se persiste en su transacción.
 *   2. En esa MISMA transacción se inserta el evento en `integration_events`.
 *   3. El envío al webhook ocurre DESPUÉS del commit, de forma asíncrona.
 *
 * Si n8n está caído, el evento queda pendiente y se reintenta con espera
 * creciente; registrar un cliente, una venta o un pago nunca falla por eso.
 *
 * Garantía de entrega: "al menos una vez". Un evento puede llegar repetido
 * (por ejemplo si n8n procesa y luego se corta la respuesta), por eso cada
 * envío lleva `X-Event-Id`: n8n debe descartar identificadores ya vistos.
 */
import { query, withTransaction } from '../config/db.js';
import { config } from '../config/env.js';
import { signBody } from '../utils/signature.js';

export const EVENT_TYPES = Object.freeze({
    CUSTOMER_CREATED: 'customer.created',
    CUSTOMER_UPDATED: 'customer.updated',
    SALE_CREATED: 'sale.created',
    SALE_PAID: 'sale.paid',
    SALE_CANCELLED: 'sale.cancelled',
    PAYMENT_CREATED: 'payment.created',
    INSTALLMENT_UPCOMING: 'installment.upcoming',
    INSTALLMENT_OVERDUE: 'installment.overdue',
});

export const ALL_EVENT_TYPES = Object.values(EVENT_TYPES);

/**
 * Espera antes de cada reintento, en segundos.
 * Tras el intento n se espera BACKOFF[n-1]. Agotada la lista, el evento se
 * marca 'descartado' en lugar de reintentarse indefinidamente.
 */
const BACKOFF_SECONDS = [60, 300, 900, 3600, 21600, 86400];
export const MAX_ATTEMPTS = BACKOFF_SECONDS.length;

/** Tiempo que un evento queda reservado por el despachador que lo tomó. */
const LEASE_SECONDS = 120;

// ---------------------------------------------------------------- REGISTRO

/**
 * Registra un evento en la bandeja de salida.
 *
 * @param {object}  event
 * @param {string}  event.type        tipo de evento (ver EVENT_TYPES)
 * @param {string}  event.aggregate   customer | sale | payment | installment
 * @param {number}  event.aggregateId identificador de la entidad
 * @param {object}  event.payload     datos que recibirá n8n
 * @param {string} [event.uniqueKey]  clave de idempotencia. Con ella, insertar
 *                                    dos veces el mismo evento no duplica nada.
 *                                    Los eventos disparados por una acción del
 *                                    usuario NO la usan: cada acción es única.
 * @param {object} [client]           cliente de la transacción en curso. Si se
 *                                    pasa, el evento se guarda de forma atómica
 *                                    junto con la operación comercial.
 */
export async function recordEvent({ type, aggregate, aggregateId, payload, uniqueKey = null }, client = null) {
    const runner = client ?? { query };
    const { rows } = await runner.query(
        `INSERT INTO integration_events (event_type, aggregate, aggregate_id, payload, unique_key)
         VALUES ($1, $2, $3, $4::jsonb, $5)
         ON CONFLICT (unique_key) WHERE unique_key IS NOT NULL DO NOTHING
         RETURNING id, event_type, status, created_at`,
        [type, aggregate, aggregateId, JSON.stringify(payload ?? {}), uniqueKey]
    );
    // rows vacío = ya existía un evento con esa unique_key. No es un error.
    return rows[0] ?? null;
}

// ------------------------------------------------------------- DESPACHADOR

/**
 * Reserva hasta `limit` eventos listos para enviar.
 *
 * `FOR UPDATE SKIP LOCKED` evita que dos despachadores tomen el mismo evento.
 * Además se adelanta `next_attempt_at` (arriendo): si el proceso muere a mitad
 * del envío, el evento vuelve a estar disponible pasado ese tiempo en lugar de
 * quedarse trabado para siempre.
 */
async function claimBatch(limit) {
    return withTransaction(async (client) => {
        const { rows } = await client.query(
            `SELECT id
               FROM integration_events
              WHERE status IN ('pendiente', 'fallido')
                AND attempts < $2
                AND next_attempt_at <= now()
           ORDER BY next_attempt_at, id
              LIMIT $1
                FOR UPDATE SKIP LOCKED`,
            [limit, MAX_ATTEMPTS]
        );
        if (rows.length === 0) return [];

        const ids = rows.map((r) => r.id);
        const { rows: claimed } = await client.query(
            `UPDATE integration_events
                SET next_attempt_at = now() + ($2 || ' seconds')::interval
              WHERE id = ANY($1::bigint[])
          RETURNING id, event_type, aggregate, aggregate_id, payload, attempts, created_at`,
            [ids, LEASE_SECONDS]
        );
        return claimed;
    });
}

function buildBody(event) {
    return JSON.stringify({
        id: Number(event.id),
        event: event.event_type,
        aggregate: event.aggregate,
        aggregate_id: Number(event.aggregate_id),
        data: event.payload,
        emitted_at: new Date().toISOString(),
        source: 'distribuidora-electrodomesticos',
    });
}

async function sendOne(event) {
    const attemptNo = event.attempts + 1;
    const body = buildBody(event);
    const timestamp = Math.floor(Date.now() / 1000).toString();

    const headers = {
        'Content-Type': 'application/json',
        'X-Event-Id': String(event.id),
        'X-Event-Type': event.event_type,
        'X-Webhook-Timestamp': timestamp,
    };
    // La firma solo se puede calcular si hay secreto configurado. Sin secreto
    // el webhook sigue funcionando, pero queda sin autenticar: el arranque
    // avisa de ello.
    if (config.n8n.webhookSecret) {
        headers['X-Signature-256'] = signBody(config.n8n.webhookSecret, timestamp, body);
    }

    const startedAt = Date.now();
    let httpStatus = null;
    let ok = false;
    let error = null;
    let excerpt = null;

    try {
        const response = await fetch(config.n8n.webhookUrl, {
            method: 'POST',
            headers,
            body,
            signal: AbortSignal.timeout(config.n8n.timeoutMs),
        });
        httpStatus = response.status;
        excerpt = (await response.text().catch(() => '')).slice(0, 500);
        ok = response.ok;
        if (!ok) error = `n8n respondió ${response.status}`;
    } catch (err) {
        error = err.name === 'TimeoutError' ? `tiempo de espera agotado (${config.n8n.timeoutMs} ms)` : err.message;
    }

    const durationMs = Date.now() - startedAt;

    await withTransaction(async (client) => {
        // El número de intento del historial se calcula desde la propia tabla,
        // no desde `attempts`: un reintento manual reinicia el contador del
        // backoff pero NO debe borrar ni pisar los intentos ya registrados.
        await client.query(
            `INSERT INTO integration_event_attempts
                 (event_id, attempt_no, duration_ms, http_status, ok, error, response_excerpt)
             SELECT $1,
                    COALESCE(MAX(attempt_no), 0) + 1,
                    $2, $3, $4, $5, $6
               FROM integration_event_attempts
              WHERE event_id = $1`,
            [event.id, durationMs, httpStatus, ok, error, excerpt]
        );

        if (ok) {
            await client.query(
                `UPDATE integration_events
                    SET status = 'enviado', sent_at = now(), attempts = $2, last_error = NULL
                  WHERE id = $1`,
                [event.id, attemptNo]
            );
            return;
        }

        const exhausted = attemptNo >= MAX_ATTEMPTS;
        const waitSeconds = BACKOFF_SECONDS[Math.min(attemptNo - 1, BACKOFF_SECONDS.length - 1)];

        await client.query(
            // Los casts explícitos son necesarios: $3 se usa como valor de una
            // columna varchar y a la vez dentro de una comparación, y sin ellos
            // PostgreSQL no logra deducir un tipo único para el parámetro.
            `UPDATE integration_events
                SET status          = $3::varchar,
                    attempts        = $2,
                    last_error      = $4,
                    next_attempt_at = now() + ($5::int || ' seconds')::interval,
                    discarded_at    = CASE WHEN $3::text = 'descartado' THEN now() ELSE NULL END
              WHERE id = $1`,
            [
                event.id,
                attemptNo,
                exhausted ? 'descartado' : 'fallido',
                String(error).slice(0, 1000),
                exhausted ? 0 : waitSeconds,
            ]
        );
    });

    return { ok, httpStatus, error, durationMs, attemptNo };
}

/**
 * Envía los eventos que ya toca enviar. Nunca lanza: un fallo de integración
 * no debe tumbar el proceso ni afectar a la operación comercial.
 */
export async function dispatchPending({ limit = 20 } = {}) {
    if (!config.n8n.dispatchEnabled) {
        return { enabled: false, claimed: 0, sent: 0, failed: 0 };
    }

    const events = await claimBatch(limit);
    let sent = 0;
    let failed = 0;

    for (const event of events) {
        try {
            const result = await sendOne(event);
            if (result.ok) sent += 1;
            else failed += 1;
        } catch (err) {
            failed += 1;
            console.error(`[n8n] fallo inesperado enviando el evento ${event.id}:`, err.message);
        }
    }

    if (events.length) {
        console.log(`[n8n] despacho: ${sent} enviado(s), ${failed} fallido(s) de ${events.length}`);
    }
    return { enabled: true, claimed: events.length, sent, failed };
}

// --------------------------------------------- EJECUCIÓN EN SEGUNDO PLANO

// Un único despacho a la vez. Si llegan varios eventos seguidos (una venta
// emite uno y el pago inmediato otro), no se lanzan despachos en paralelo:
// se marca que hay trabajo pendiente y se vuelve a correr al terminar.
let running = false;
let rerunRequested = false;

export function dispatchInBackground() {
    if (!config.n8n.dispatchEnabled) return;
    if (running) {
        rerunRequested = true;
        return;
    }
    running = true;
    dispatchPending()
        .catch((err) => console.error('[n8n] error en el despacho:', err.message))
        .finally(() => {
            running = false;
            if (rerunRequested) {
                rerunRequested = false;
                dispatchInBackground();
            }
        });
}

let timer = null;

/**
 * Arranca el despachador periódico. Es lo que rescata los eventos que
 * quedaron en espera por el backoff cuando n8n estaba caído.
 */
export function startDispatcher() {
    if (!config.n8n.dispatchEnabled || timer) return false;
    timer = setInterval(dispatchInBackground, config.n8n.dispatchIntervalMs);
    timer.unref();
    return true;
}

export function stopDispatcher() {
    if (timer) clearInterval(timer);
    timer = null;
}

// ------------------------------------------------------------- CONSULTAS

export async function outboxSummary() {
    const [byStatus, byType, oldest] = await Promise.all([
        query(`SELECT status, COUNT(*)::int AS total FROM integration_events GROUP BY status`),
        query(
            `SELECT event_type,
                    COUNT(*)::int AS total,
                    COUNT(*) FILTER (WHERE status = 'enviado')::int    AS enviados,
                    COUNT(*) FILTER (WHERE status <> 'enviado')::int   AS no_enviados
               FROM integration_events
           GROUP BY event_type
           ORDER BY event_type`
        ),
        query(
            `SELECT id, event_type, created_at, attempts, next_attempt_at, last_error
               FROM integration_events
              WHERE status IN ('pendiente', 'fallido')
           ORDER BY created_at
              LIMIT 1`
        ),
    ]);

    const counts = Object.fromEntries(byStatus.rows.map((r) => [r.status, r.total]));
    return {
        enabled: config.n8n.dispatchEnabled,
        webhook_configured: Boolean(config.n8n.webhookUrl),
        signature_configured: Boolean(config.n8n.webhookSecret),
        interval_ms: config.n8n.dispatchIntervalMs,
        max_attempts: MAX_ATTEMPTS,
        backoff_seconds: BACKOFF_SECONDS,
        counts: {
            pendiente: counts.pendiente ?? 0,
            enviado: counts.enviado ?? 0,
            fallido: counts.fallido ?? 0,
            descartado: counts.descartado ?? 0,
        },
        by_type: byType.rows,
        oldest_pending: oldest.rows[0] ?? null,
    };
}

export async function listEvents({ status = '', type = '', page = 1, pageSize = 20 }) {
    const filters = [];
    const params = [];

    if (status) {
        params.push(status);
        filters.push(`status = $${params.length}`);
    }
    if (type) {
        params.push(type);
        filters.push(`event_type = $${params.length}`);
    }
    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    const offset = (page - 1) * pageSize;
    params.push(pageSize, offset);

    const { rows } = await query(
        `SELECT id, event_type, aggregate, aggregate_id, status, attempts,
                unique_key, last_error, created_at, sent_at, next_attempt_at,
                COUNT(*) OVER()::int AS total_count
           FROM integration_events
           ${where}
       ORDER BY created_at DESC, id DESC
          LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params
    );

    const total = rows[0]?.total_count ?? 0;
    return {
        data: rows.map(({ total_count, ...e }) => e),
        pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) || 1 },
    };
}

export async function getEvent(id) {
    const { rows } = await query(`SELECT * FROM integration_events WHERE id = $1`, [id]);
    if (!rows[0]) return null;

    const { rows: attempts } = await query(
        `SELECT attempt_no, started_at, duration_ms, http_status, ok, error, response_excerpt
           FROM integration_event_attempts
          WHERE event_id = $1
       ORDER BY attempt_no`,
        [id]
    );
    return { ...rows[0], attempts };
}

/**
 * Deja un evento listo para reintentarse ya mismo, sin borrar su historial de
 * intentos. Sirve para reenviar a mano lo que se descartó tras una caída larga.
 */
export async function retryEvent(id, { resetAttempts = true } = {}) {
    const { rows } = await query(
        `UPDATE integration_events
            SET status          = 'pendiente',
                next_attempt_at = now(),
                attempts        = CASE WHEN $2 THEN 0 ELSE attempts END,
                discarded_at    = NULL,
                last_error      = NULL
          WHERE id = $1 AND status <> 'enviado'
      RETURNING id, event_type, status`,
        [id, resetAttempts]
    );
    return rows[0] ?? null;
}
