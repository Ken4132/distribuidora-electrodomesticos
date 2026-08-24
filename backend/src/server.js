import { createApp } from './app.js';
import { config } from './config/env.js';
import { pool, closePool } from './config/db.js';
import { startDispatcher, stopDispatcher } from './services/events.service.js';
import { startCollectionsScanner, stopCollectionsScanner } from './services/collections.service.js';

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

        if (config.n8n.dispatchEnabled) {
            startDispatcher();
            console.log(
                `[n8n] Despacho ACTIVO hacia ${config.n8n.webhookUrl} cada ${config.n8n.dispatchIntervalMs / 1000}s`
            );
            if (!config.n8n.webhookSecret) {
                console.warn(
                    '[n8n] ADVERTENCIA: no hay N8N_WEBHOOK_SECRET. Los envíos irán SIN FIRMA y n8n no podrá verificar su origen.'
                );
            }
        } else {
            console.log('[n8n] Despacho inactivo: los eventos se acumulan en la bandeja de salida.');
        }

        if (startCollectionsScanner()) {
            console.log(
                `[cobranza] Barrido activo cada ${config.collections.scanIntervalMs / 3600000}h ` +
                    `(aviso ${config.collections.upcomingDays} día(s) antes del vencimiento)`
            );
        }
    });

    const shutdown = async (signal) => {
        console.log(`\n[api] ${signal} recibido, cerrando...`);
        stopDispatcher();
        stopCollectionsScanner();
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
