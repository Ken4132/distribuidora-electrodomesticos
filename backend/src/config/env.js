import 'dotenv/config';

function required(name, fallback = undefined) {
    const value = process.env[name] ?? fallback;
    if (value === undefined || value === '') {
        throw new Error(
            `Falta la variable de entorno ${name}. Copia backend/.env.example a backend/.env y complétala.`
        );
    }
    return value;
}

const NODE_ENV = process.env.NODE_ENV ?? 'development';

// En desarrollo permitimos un secreto por defecto para no bloquear el arranque,
// pero en producción es obligatorio definirlo.
const JWT_SECRET =
    NODE_ENV === 'production'
        ? required('JWT_SECRET')
        : process.env.JWT_SECRET || 'dev-only-insecure-secret-change-me';


/**
 * CONFIANZA EN EL PROXY (`trust proxy`)
 *
 * La IP del cliente es la clave de los limitadores, así que de qué IP hablamos
 * es una decisión de seguridad, no un detalle. Express solo debe leer
 * `X-Forwarded-For` cuando quien envía esa cabecera es un proxy NUESTRO:
 * cualquiera puede escribir esa cabecera a mano y hacerse pasar por otra IP
 * para saltarse el límite (o para que se bloquee a un tercero).
 *
 * Valores admitidos en TRUST_PROXY:
 *
 *   false | 0        No se lee ninguna cabecera. La IP es la del socket.
 *   loopback         Se confía solo si quien conecta es 127.0.0.1 / ::1.
 *                    Es lo correcto con nginx o Caddy en la MISMA máquina, y
 *                    es el valor por defecto fuera de producción.
 *   linklocal | uniquelocal   Subredes predefinidas de Express.
 *   <número>         Número de saltos de proxy (p. ej. 1 = un balanceador).
 *   <ip>,<cidr>,…    Direcciones o rangos concretos de nuestros proxys.
 *                    Es la opción más segura cuando el proxy es remoto
 *                    (p. ej. "10.0.0.0/8" o la IP del balanceador).
 *
 * `true` confía en CUALQUIER X-Forwarded-For y deja el límite en nada: se
 * rechaza en producción y solo se acepta, con advertencia, fuera de ella.
 *
 * Por defecto en producción es `false`: preferimos que, mal configurado, el
 * límite sea demasiado estricto (todos comparten la IP del proxy) y no que sea
 * falsificable. El arranque avisa para que se configure de verdad.
 */
function parseTrustProxy(raw, isProd) {
    const value = String(raw ?? '').trim();

    if (value === '') {
        if (isProd) {
            console.warn(
                '[config] TRUST_PROXY no está definida. Se usará `false`: si el backend corre detrás ' +
                    'de un proxy o balanceador, TODOS los clientes se verán con la misma IP y el límite ' +
                    'de login será demasiado estricto. Define TRUST_PROXY con la IP/rango de tu proxy.'
            );
            return false;
        }
        return 'loopback';
    }

    const lower = value.toLowerCase();
    if (lower === 'false' || lower === '0') return false;
    if (lower === 'true') {
        if (isProd) {
            throw new Error(
                'TRUST_PROXY=true confiaría en cualquier cabecera X-Forwarded-For y permitiría falsificar ' +
                    'la IP del cliente. En producción usa el número de saltos (p. ej. 1) o la IP/rango de tu proxy.'
            );
        }
        console.warn('[config] TRUST_PROXY=true: cualquiera puede falsificar su IP. Solo para depurar.');
        return true;
    }
    if (['loopback', 'linklocal', 'uniquelocal'].includes(lower)) return lower;
    if (/^\d+$/.test(value)) return Number(value);

    return value
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean);
}

const positiveInt = (raw, fallback) => {
    const value = Number(raw);
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
};

export const config = {
    env: NODE_ENV,
    isProd: NODE_ENV === 'production',
    port: Number(process.env.PORT ?? 4000),

    db: {
        connectionString: process.env.DATABASE_URL || undefined,
        host: process.env.PGHOST ?? 'localhost',
        port: Number(process.env.PGPORT ?? 5432),
        user: process.env.PGUSER ?? 'postgres',
        password: process.env.PGPASSWORD ?? 'postgres',
        database: process.env.PGDATABASE ?? 'distribuidora',
    },

    jwt: {
        secret: JWT_SECRET,
        expiresIn: process.env.JWT_EXPIRES_IN ?? '8h',
    },

    // Ver parseTrustProxy: de esto depende qué IP ve el limitador.
    trustProxy: parseTrustProxy(process.env.TRUST_PROXY, NODE_ENV === 'production'),

    /**
     * LÍMITES DE PETICIONES (ver middleware/rateLimit.js).
     *
     * El login lleva dos frenos a la vez, y los dos cuentan SOLO intentos
     * fallidos: por IP + usuario (el principal) y por IP (el global, más alto,
     * para que cambiar de usuario no sea un atajo).
     */
    rateLimit: {
        store: (process.env.RATE_LIMIT_STORE ?? 'memory').trim().toLowerCase(),
        redisUrl: process.env.REDIS_URL ?? '',
        login: {
            windowMs: positiveInt(process.env.LOGIN_RATE_WINDOW_MS, 10 * 60 * 1000),
            perUserLimit: positiveInt(process.env.LOGIN_RATE_LIMIT_USER, 10),
            perIpLimit: positiveInt(process.env.LOGIN_RATE_LIMIT_IP, 50),
        },
        api: {
            windowMs: positiveInt(process.env.API_RATE_WINDOW_MS, 60 * 1000),
            limit: positiveInt(process.env.API_RATE_LIMIT, 300),
        },
    },

    corsOrigins: (process.env.CORS_ORIGINS ?? 'http://localhost:5173')
        .split(',')
        .map((o) => o.trim())
        .filter(Boolean),

    timezone: process.env.APP_TIMEZONE ?? 'America/Guatemala',

    n8n: {
        webhookUrl: process.env.N8N_WEBHOOK_URL ?? '',
        webhookSecret: process.env.N8N_WEBHOOK_SECRET ?? '',
        dispatchEnabled:
            String(process.env.N8N_DISPATCH_ENABLED ?? 'false').toLowerCase() === 'true' &&
            Boolean(process.env.N8N_WEBHOOK_URL),
        // Cada cuánto revisa el despachador si hay eventos por enviar.
        dispatchIntervalMs: Number(process.env.N8N_DISPATCH_INTERVAL_MS ?? 60_000),
        // Tiempo máximo de espera por respuesta del webhook.
        timeoutMs: Number(process.env.N8N_TIMEOUT_MS ?? 10_000),
    },

    // Barrido de cobranza: genera installment.upcoming e installment.overdue.
    collections: {
        enabled: String(process.env.COLLECTIONS_SCAN_ENABLED ?? 'true').toLowerCase() === 'true',
        // Días de anticipación con que se avisa de una cuota por vencer.
        upcomingDays: Number(process.env.COLLECTIONS_UPCOMING_DAYS ?? 3),
        // Cada cuántos días se vuelve a avisar de una cuota vencida.
        // 0 = avisar una sola vez cuando se detecta el atraso.
        overdueRepeatDays: Number(process.env.COLLECTIONS_OVERDUE_REPEAT_DAYS ?? 0),
        // Cada cuánto se ejecuta el barrido dentro del proceso del backend.
        scanIntervalMs: Number(process.env.COLLECTIONS_SCAN_INTERVAL_MS ?? 6 * 60 * 60 * 1000),
    },

    seed: {
        adminUsername: process.env.SEED_ADMIN_USERNAME ?? 'admin',
        adminPassword: process.env.SEED_ADMIN_PASSWORD ?? 'Admin123!',
        adminName: process.env.SEED_ADMIN_NAME ?? 'Administrador',
    },
};
