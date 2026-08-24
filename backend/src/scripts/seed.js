/**
 * Seed idempotente: crea el usuario administrador inicial y, en desarrollo,
 * un pequeño catálogo de demostración. Se puede ejecutar varias veces sin
 * duplicar nada.
 *
 *   npm run seed
 */
import bcrypt from 'bcryptjs';
import { pool, closePool } from '../config/db.js';
import { config } from '../config/env.js';

const DEMO_CUSTOMERS = [
    {
        dpi: '2589631470101',
        full_name: 'María Elena Gómez Pérez',
        phone: '55512345',
        address: '4a calle 5-20 zona 1, Ciudad de Guatemala',
        address_ref: 'Frente a la tienda El Progreso',
    },
    {
        dpi: '1478523690102',
        full_name: 'Carlos Roberto Sicán López',
        phone: '42019876',
        address: '12 avenida 3-45 zona 7, Mixco',
        address_ref: 'Casa de portón azul',
    },
];

const DEMO_PRODUCTS = [
    { code: 'REF-001', name: 'Refrigeradora 11 pies', category: 'Refrigeración', brand: 'Mabe', cost: 3000.0, stock: 8, min_stock: 2 },
    { code: 'LAV-002', name: 'Lavadora automática 22 lb', category: 'Lavandería', brand: 'Whirlpool', cost: 2200.0, stock: 6, min_stock: 2 },
    { code: 'TEL-003', name: 'Televisor LED 43"', category: 'Electrónica', brand: 'Samsung', cost: 1800.0, stock: 12, min_stock: 3 },
    { code: 'EST-004', name: 'Estufa de 4 hornillas', category: 'Cocina', brand: 'Indurama', cost: 1500.0, stock: 5, min_stock: 2 },
    { code: 'MIC-005', name: 'Microondas 0.7 pies', category: 'Cocina', brand: 'LG', cost: 700.0, stock: 15, min_stock: 4 },
];

async function seedAdmin(client) {
    const { rows } = await client.query('SELECT id FROM users WHERE lower(username) = lower($1)', [
        config.seed.adminUsername,
    ]);
    if (rows.length) {
        console.log(`[seed] El usuario "${config.seed.adminUsername}" ya existe, no se modifica.`);
        return;
    }
    const hash = await bcrypt.hash(config.seed.adminPassword, 10);
    await client.query(
        `INSERT INTO users (username, full_name, password_hash, role) VALUES ($1, $2, $3, 'admin')`,
        [config.seed.adminUsername, config.seed.adminName, hash]
    );
    console.log(`[seed] Usuario administrador creado: ${config.seed.adminUsername}`);
    if (config.seed.adminPassword === 'Admin123!') {
        console.log('[seed] ATENCIÓN: se usó la contraseña por defecto. Cámbiala antes de usar el sistema en real.');
    }
}

async function seedDemo(client) {
    if (config.isProd) {
        console.log('[seed] Entorno de producción: se omiten los datos de demostración.');
        return;
    }

    for (const c of DEMO_CUSTOMERS) {
        await client.query(
            `INSERT INTO customers (dpi, full_name, phone, address, address_ref)
             VALUES ($1,$2,$3,$4,$5) ON CONFLICT (dpi) DO NOTHING`,
            [c.dpi, c.full_name, c.phone, c.address, c.address_ref]
        );
    }

    for (const p of DEMO_PRODUCTS) {
        const { rows } = await client.query('SELECT id FROM products WHERE upper(code) = upper($1)', [p.code]);
        if (rows.length) continue;
        const inserted = await client.query(
            `INSERT INTO products (code, name, category, brand, cost, stock, min_stock)
             VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
            [p.code, p.name, p.category, p.brand, p.cost, p.stock, p.min_stock]
        );
        await client.query(
            `INSERT INTO stock_movements (product_id, movement, quantity, stock_after, reason)
             VALUES ($1, 'entrada', $2, $2, 'stock_inicial')`,
            [inserted.rows[0].id, p.stock]
        );
    }

    console.log(`[seed] Datos de demostración listos (${DEMO_CUSTOMERS.length} clientes, ${DEMO_PRODUCTS.length} productos).`);
}

async function run() {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await seedAdmin(client);
        await seedDemo(client);
        await client.query('COMMIT');
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
        await closePool();
    }
}

run().catch((error) => {
    console.error('[seed] Error:', error.message);
    process.exit(1);
});
