import { query } from '../config/db.js';

const PUBLIC_FIELDS = 'id, username, full_name, email, role, is_active, created_at';

export async function findByUsername(username) {
    const { rows } = await query(
        `SELECT id, username, full_name, email, role, is_active, password_hash
           FROM users WHERE lower(username) = lower($1)`,
        [username]
    );
    return rows[0] ?? null;
}

export async function findById(id) {
    const { rows } = await query(`SELECT ${PUBLIC_FIELDS} FROM users WHERE id = $1`, [id]);
    return rows[0] ?? null;
}

export async function create({ username, fullName, email, passwordHash, role = 'vendedor' }) {
    const { rows } = await query(
        `INSERT INTO users (username, full_name, email, password_hash, role)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING ${PUBLIC_FIELDS}`,
        [username, fullName, email ?? null, passwordHash, role]
    );
    return rows[0];
}

export async function countUsers() {
    const { rows } = await query('SELECT COUNT(*)::int AS total FROM users');
    return rows[0].total;
}
