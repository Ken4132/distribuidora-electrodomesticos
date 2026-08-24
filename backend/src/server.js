import { createApp } from './app.js';
import { config } from './config/env.js';
import { pool, closePool } from './config/db.js';

const app = createApp();

async function start() {
    try {
        await pool.query('SELECT 1');
        console.log('[db] Conexión establecida');
    } catch (error) {
        console.error('[db] No se pudo conectar a PostgreSQL:', error.message);
        console.error('     Revisa DATABASE_URL en backend/.env y que el servidor esté encendido.');
        process.exit(1);
    }

    const server = app.listen(config.port, () => {
        console.log(`[api] Escuchando en http://localhost:${config.port}/api  (entorno: ${config.env})`);
        console.log(`[n8n] Despacho de eventos: ${config.n8n.dispatchEnabled ? 'ACTIVO' : 'inactivo (solo outbox)'}`);
    });

    const shutdown = async (signal) => {
        console.log(`\n[api] ${signal} recibido, cerrando...`);
        server.close(async () => {
            await closePool();
            process.exit(0);
        });
        setTimeout(() => process.exit(1), 10000).unref();
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
}

start();
