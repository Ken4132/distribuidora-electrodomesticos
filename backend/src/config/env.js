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
    },

    seed: {
        adminUsername: process.env.SEED_ADMIN_USERNAME ?? 'admin',
        adminPassword: process.env.SEED_ADMIN_PASSWORD ?? 'Admin123!',
        adminName: process.env.SEED_ADMIN_NAME ?? 'Administrador',
    },
};
