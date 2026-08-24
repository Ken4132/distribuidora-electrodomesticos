import pg from 'pg';
import { config } from './env.js';

const { Pool, types } = pg;

// PostgreSQL devuelve NUMERIC como string para no perder precisión.
// Lo mantenemos así en la capa de acceso y lo formateamos explícitamente
// en la capa de presentación: nunca hacemos aritmética de dinero con floats.
// DATE (OID 1082) se devuelve como 'YYYY-MM-DD' tal cual, sin convertir a
// objeto Date, para evitar corrimientos de zona horaria.
types.setTypeParser(1082, (value) => value);

// BIGINT (OID 20) también llega como string por si excede el entero seguro de
// JavaScript. Aquí solo se usa para identificadores autoincrementales, que
// nunca llegarán a 9.007.199.254.740.991, así que se convierten a número.
// Sin esto, un mismo identificador viajaba como "3" en un evento y como 3 en
// otro, y quien consuma los webhooks tendría que normalizarlo por su cuenta.
types.setTypeParser(20, (value) => {
    const n = Number(value);
    return Number.isSafeInteger(n) ? n : value;
});

export const pool = new Pool(
    config.db.connectionString
        ? { connectionString: config.db.connectionString, max: 10 }
        : {
              host: config.db.host,
              port: config.db.port,
              user: config.db.user,
              password: config.db.password,
              database: config.db.database,
              max: 10,
          }
);

pool.on('error', (err) => {
    console.error('[db] Error inesperado en el pool de conexiones:', err.message);
});

/**
 * Ejecuta una consulta parametrizada.
 * SIEMPRE usar placeholders ($1, $2...) — nunca concatenar valores en el SQL.
 */
export function query(text, params) {
    return pool.query(text, params);
}

/**
 * Ejecuta un callback dentro de una transacción.
 * Hace COMMIT si termina bien y ROLLBACK ante cualquier error.
 */
export async function withTransaction(callback) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const result = await callback(client);
        await client.query('COMMIT');
        return result;
    } catch (error) {
        try {
            await client.query('ROLLBACK');
        } catch {
            /* la conexión ya estaba rota */
        }
        throw error;
    } finally {
        client.release();
    }
}

export async function closePool() {
    await pool.end();
}
