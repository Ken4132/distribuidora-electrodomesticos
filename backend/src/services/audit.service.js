/**
 * BITÁCORA DE AUDITORÍA  (REQ-0016, RN-0007, RNQ-0010)
 *
 * Registra quién hizo qué, sobre qué, cuándo y desde dónde.
 *
 * Dos decisiones importantes:
 *
 * 1. Se guarda una COPIA del nombre de usuario y del rol en el momento del
 *    hecho. Si mañana el usuario se renombra o cambia de rol, la bitácora
 *    debe seguir diciendo quién era cuando ocurrió la operación.
 *
 * 2. `recordAudit` NUNCA lanza. Que falle el registro de la bitácora no
 *    puede tumbar un cobro que ya se hizo. El fallo se registra en consola
 *    y la operación comercial continúa. La inmutabilidad de lo que sí se
 *    escribió la garantiza un disparador de la base de datos (migración 003),
 *    no la aplicación.
 *
 * NO se registran contraseñas, hashes ni tokens. `details` es para datos de
 * apoyo (montos, códigos, motivos), no para volcar el cuerpo de la petición.
 */
import { query } from '../config/db.js';

/** Extrae del request lo que la bitácora necesita saber del autor. */
export function actorFrom(req) {
    return {
        id: req?.user?.id ?? null,
        username: req?.user?.username ?? null,
        role: req?.user?.role ?? null,
        ip: clientIp(req),
        userAgent: req?.headers?.['user-agent']?.slice(0, 400) ?? null,
    };
}

function clientIp(req) {
    if (!req) return null;
    const forwarded = req.headers?.['x-forwarded-for'];
    const raw = (typeof forwarded === 'string' ? forwarded.split(',')[0] : null) ?? req.ip ?? null;
    return raw ? String(raw).trim().slice(0, 60) : null;
}

/**
 * Escribe una entrada.
 *
 * @param {object}  entry
 * @param {object}  entry.actor      resultado de actorFrom(req)
 * @param {string}  entry.action     'payment.create', 'login.success', ...
 * @param {string} [entry.module]    módulo al que pertenece la acción
 * @param {string} [entry.entity]    customer | product | sale | payment | user | role
 * @param {number} [entry.entityId]
 * @param {string}  entry.summary    frase legible que se muestra en pantalla
 * @param {object} [entry.details]   datos de apoyo, sin información sensible
 * @param {'ok'|'denegado'|'error'} [entry.result]
 * @param {object} [client]          cliente de una transacción en curso. Si se
 *                                   pasa, la entrada se guarda de forma atómica
 *                                   junto con la operación.
 */
export async function recordAudit(entry, client = null) {
    const {
        actor = {},
        action,
        module = null,
        entity = null,
        entityId = null,
        summary,
        details = null,
        result = 'ok',
    } = entry ?? {};

    if (!action || !summary) {
        console.error('[bitacora] Entrada descartada: falta action o summary', { action, summary });
        return null;
    }

    const runner = client ?? { query };

    try {
        const { rows } = await runner.query(
            `INSERT INTO audit_log
                 (user_id, username, user_role, action, module, entity, entity_id,
                  summary, details, result, ip, user_agent)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12)
             RETURNING id, occurred_at`,
            [
                actor.id ?? null,
                actor.username ?? null,
                actor.role ?? null,
                action,
                module,
                entity,
                entityId ?? null,
                summary,
                details ? JSON.stringify(details) : null,
                result,
                actor.ip ?? null,
                actor.userAgent ?? null,
            ]
        );
        return rows[0] ?? null;
    } catch (error) {
        // Si el registro va dentro de una transacción, el fallo sí debe
        // propagarse: la transacción ya quedó abortada y silenciarlo dejaría
        // la operación en un estado imposible de confirmar.
        if (client) throw error;
        console.error(`[bitacora] No se pudo registrar "${action}":`, error.message);
        return null;
    }
}

/** Consulta paginada con filtros, para la pantalla de bitácora. */
export async function listAudit({
    search = '',
    action = '',
    module = '',
    entity = '',
    userId = null,
    result = '',
    from = null,
    to = null,
    page = 1,
    pageSize = 20,
}) {
    const filters = [];
    const params = [];

    if (search) {
        params.push(`%${search.toLowerCase()}%`);
        const p = `$${params.length}`;
        filters.push(`(lower(summary) LIKE ${p} OR lower(COALESCE(username,'')) LIKE ${p})`);
    }
    if (action) {
        params.push(action);
        filters.push(`action = $${params.length}`);
    }
    if (module) {
        params.push(module);
        filters.push(`module = $${params.length}`);
    }
    if (entity) {
        params.push(entity);
        filters.push(`entity = $${params.length}`);
    }
    if (userId) {
        params.push(userId);
        filters.push(`user_id = $${params.length}`);
    }
    if (result) {
        params.push(result);
        filters.push(`result = $${params.length}`);
    }
    if (from) {
        params.push(from);
        filters.push(`occurred_at >= $${params.length}::date`);
    }
    if (to) {
        params.push(to);
        // El filtro "hasta" incluye el día completo, no las 00:00 de ese día.
        filters.push(`occurred_at < ($${params.length}::date + 1)`);
    }

    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    const offset = (page - 1) * pageSize;
    params.push(pageSize, offset);

    const { rows } = await query(
        `SELECT *, COUNT(*) OVER()::int AS total_count
           FROM v_audit_log
           ${where}
       ORDER BY occurred_at DESC, id DESC
          LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params
    );

    const total = rows[0]?.total_count ?? 0;
    return {
        data: rows.map(({ total_count, ...row }) => row),
        pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) || 1 },
    };
}

/** Catálogo de acciones y módulos ya registrados, para armar los filtros. */
export async function auditFilters() {
    const [actions, modules] = await Promise.all([
        query('SELECT DISTINCT action FROM audit_log ORDER BY action'),
        query('SELECT DISTINCT module FROM audit_log WHERE module IS NOT NULL ORDER BY module'),
    ]);
    return {
        actions: actions.rows.map((r) => r.action),
        modules: modules.rows.map((r) => r.module),
    };
}
