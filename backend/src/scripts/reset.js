/**
 * Borra TODAS las tablas y vuelve a aplicar las migraciones desde cero.
 * Solo para desarrollo — se niega a ejecutarse con NODE_ENV=production.
 *
 *   npm run db:reset
 */
import { pool, closePool } from '../config/db.js';
import { config } from '../config/env.js';

if (config.isProd) {
    console.error('[reset] Bloqueado: no se puede reiniciar la base de datos en producción.');
    process.exit(1);
}

const client = await pool.connect();
try {
    await client.query('DROP SCHEMA public CASCADE');
    await client.query('CREATE SCHEMA public');
    console.log('[reset] Esquema public recreado. Ejecuta ahora: npm run migrate && npm run seed');
} finally {
    client.release();
    await closePool();
}
