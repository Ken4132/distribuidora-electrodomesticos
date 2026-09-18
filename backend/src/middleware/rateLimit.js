import { createRequire } from 'node:module';
import rateLimit from 'express-rate-limit';
import { config } from '../config/env.js';

/**
 * LÍMITES DE PETICIONES
 *
 * El problema del diseño anterior: `/auth/login` se limitaba solo por IP
 * (10 intentos / 10 min). Varios empleados detrás de la misma IP pública
 * compartían el contador, así que el error de uno bloqueaba a todos.
 *
 * Diseño actual: DOS frenos que se aplican a la vez sobre el login.
 *
 *   1. PRINCIPAL — por IP + usuario normalizado.
 *      Un empleado que se equivoca de contraseña solo se bloquea a sí mismo.
 *      Es el freno directo contra la fuerza bruta sobre UNA cuenta.
 *
 *   2. GLOBAL — por IP, con un límite bastante más alto.
 *      Contiene el abuso masivo desde una misma IP y cierra el atajo obvio
 *      del freno anterior: probar mil usuarios distintos para que cada uno
 *      tenga su propio contador limpio.
 *
 * Los dos SOLO cuentan intentos FALLIDOS (`skipSuccessfulRequests`). Un
 * inicio de sesión correcto no gasta el presupuesto de errores: trabajar
 * normalmente nunca acerca a nadie al bloqueo.
 *
 * Ninguno se desactiva ni tiene excepciones por entorno: en pruebas está tan
 * activo como en producción.
 */

// ---------------------------------------------------------------------
// CLAVES
// ---------------------------------------------------------------------

/** Expande un IPv6 a sus 8 grupos, resolviendo la abreviatura `::`. */
function expandIpv6(value) {
    if (!value.includes('::')) return value.split(':');
    const [head = '', tail = ''] = value.split('::');
    const headParts = head ? head.split(':').filter(Boolean) : [];
    const tailParts = tail ? tail.split(':').filter(Boolean) : [];
    const missing = Math.max(8 - headParts.length - tailParts.length, 0);
    return [...headParts, ...Array(missing).fill('0'), ...tailParts];
}

/**
 * IP canónica del cliente para el contador.
 *
 * IPv4 se usa tal cual. IPv6 se agrupa por bloques de 64 bits: a un atacante se le suele
 * asignar un bloque entero, así que contar cada dirección por separado dejaría
 * el límite en nada (le bastaría con cambiar de dirección dentro de su propio
 * bloque). `::ffff:x.x.x.x` es una IPv4 mapeada y se trata como IPv4.
 */
export function ipKey(req) {
    const raw = req.ip ?? req.socket?.remoteAddress ?? '';
    if (!raw) return 'ip-desconocida';

    let value = String(raw);
    const mapped = value.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i);
    if (mapped) value = mapped[1];
    if (!value.includes(':')) return value;

    const groups = expandIpv6(value).slice(0, 4).map((g) => g.padStart(4, '0').toLowerCase());
    return `${groups.join(':')}::/64`;
}

/**
 * Usuario normalizado del intento.
 *
 * Se aplica la MISMA regla con la que el backend busca la cuenta
 * (`lower(username)`): así "ADMIN", " admin " y "admin" comparten contador y
 * no se puede diluir el límite cambiando mayúsculas o metiendo espacios.
 * El limitador corre ANTES de la validación, así que el cuerpo puede venir
 * mal formado: ese caso tiene su propia clave y también se cuenta.
 */
export function usernameKey(req) {
    const raw = req.body?.username;
    if (typeof raw !== 'string') return '(sin-usuario)';
    const value = raw.trim().toLowerCase().slice(0, 50);
    return value === '' ? '(sin-usuario)' : value;
}

// ---------------------------------------------------------------------
// ALMACENAMIENTO
// ---------------------------------------------------------------------

let redisClient = null;
let redisReady = null;

/**
 * Store del limitador.
 *
 * `memory` (por defecto): el `MemoryStore` de express-rate-limit. Vive dentro
 * del proceso, así que **con varias instancias del backend cada una lleva su
 * propia cuenta** y el límite real se multiplica por el número de instancias.
 * Sirve para una sola instancia, que es como corre hoy el sistema.
 *
 * `redis`: store compartido entre instancias. La pieza está diseñada y el
 * código listo, pero las dependencias NO se instalan todavía (no hace falta
 * levantar Redis para una sola instancia). Cuando toque:
 *
 *     npm install rate-limit-redis redis
 *     RATE_LIMIT_STORE=redis
 *     REDIS_URL=redis://usuario:clave@host:6379
 *
 * Si se pide `redis` sin las dependencias, el backend falla al arrancar con
 * un mensaje claro en vez de quedarse silenciosamente sin protección
 * compartida.
 */
function buildStore(prefix) {
    if (config.rateLimit.store === 'memory') return undefined;

    const require = createRequire(import.meta.url);
    let RedisStore;
    let createClient;
    try {
        RedisStore = require('rate-limit-redis').default ?? require('rate-limit-redis');
        ({ createClient } = require('redis'));
    } catch (error) {
        throw new Error(
            'RATE_LIMIT_STORE=redis necesita las dependencias opcionales: ejecuta ' +
                '`npm install rate-limit-redis redis` y define REDIS_URL. ' +
                `Detalle: ${error.message}`
        );
    }

    if (!config.rateLimit.redisUrl) {
        throw new Error('RATE_LIMIT_STORE=redis necesita REDIS_URL');
    }

    if (!redisClient) {
        redisClient = createClient({ url: config.rateLimit.redisUrl });
        redisClient.on('error', (error) => console.error('[rate-limit] Redis:', error.message));
        redisReady = redisClient.connect();
    }

    return new RedisStore({
        prefix,
        sendCommand: async (...args) => {
            await redisReady;
            return redisClient.sendCommand(args);
        },
    });
}

// ---------------------------------------------------------------------
// LIMITADORES
// ---------------------------------------------------------------------

const respond = (code, message) => ({ ok: false, error: { code, message } });

/** 1. Principal: IP + usuario. Solo cuenta intentos fallidos. */
export const loginUserLimiter = rateLimit({
    windowMs: config.rateLimit.login.windowMs,
    limit: config.rateLimit.login.perUserLimit,
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests: true,
    keyGenerator: (req) => `${ipKey(req)}|${usernameKey(req)}`,
    store: buildStore('rl:login:usuario:'),
    message: respond(
        'RATE_LIMITED',
        'Demasiados intentos fallidos con este usuario. Espera unos minutos o pide a Administración que restablezca la contraseña.'
    ),
});

/** 2. Global por IP: contiene el abuso masivo y el cambio de usuario. */
export const loginIpLimiter = rateLimit({
    windowMs: config.rateLimit.login.windowMs,
    limit: config.rateLimit.login.perIpLimit,
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests: true,
    keyGenerator: (req) => ipKey(req),
    store: buildStore('rl:login:ip:'),
    message: respond(
        'RATE_LIMITED',
        'Demasiados intentos fallidos desde esta red. Espera unos minutos antes de volver a intentarlo.'
    ),
});

/**
 * Freno general de la API (todas las rutas). No sustituye a los dos
 * anteriores: acota el volumen de peticiones, no los intentos de login.
 */
export const apiLimiter = rateLimit({
    windowMs: config.rateLimit.api.windowMs,
    limit: config.rateLimit.api.limit,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => ipKey(req),
    store: buildStore('rl:api:'),
    message: respond('RATE_LIMITED', 'Demasiadas peticiones. Espera un momento.'),
});

/**
 * Orden en la ruta: primero el freno de la red, después el del usuario.
 *
 * Los dos se aplican igual; lo que decide el orden es QUÉ cabeceras
 * `RateLimit-*` ve el cliente, porque las escribe el último que corre. Se deja
 * al final el del usuario: "te quedan N intentos con esta cuenta" es lo útil
 * para quien está escribiendo su contraseña, y es además el límite más
 * estricto de los dos.
 */
export const loginLimiters = [loginIpLimiter, loginUserLimiter];
