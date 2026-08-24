/**
 * Runner de migraciones.
 * Aplica en orden los archivos .sql de database/migrations que aún no se
 * hayan ejecutado y los registra en la tabla schema_migrations.
 *
 *   npm run migrate
 */
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { pool, closePool } from '../config/db.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(HERE, '../../../database/migrations');

async function ensureTable(client) {
    await client.query(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
            filename   TEXT PRIMARY KEY,
            applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
    `);
}

async function run() {
    const client = await pool.connect();
    try {
        await ensureTable(client);

        const { rows } = await client.query('SELECT filename FROM schema_migrations');
        const applied = new Set(rows.map((r) => r.filename));

        const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();

        const pending = files.filter((f) => !applied.has(f));
        if (pending.length === 0) {
            console.log('[migrate] Sin migraciones pendientes.');
            return;
        }

        for (const file of pending) {
            const sql = await readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
            process.stdout.write(`[migrate] Aplicando ${file} ... `);
            try {
                await client.query('BEGIN');
                await client.query(sql);
                await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
                await client.query('COMMIT');
                console.log('OK');
            } catch (error) {
                await client.query('ROLLBACK');
                console.log('FALLÓ');
                throw new Error(`${file}: ${error.message}`);
            }
        }
        console.log(`[migrate] ${pending.length} migración(es) aplicada(s).`);
    } finally {
        client.release();
        await closePool();
    }
}

run().catch((error) => {
    console.error('[migrate] Error:', error.message);
    process.exit(1);
});
