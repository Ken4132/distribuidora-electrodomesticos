import { withTransaction } from '../config/db.js';
import * as Product from '../models/product.model.js';
import { AppError } from '../utils/AppError.js';
import { priceTable } from '../utils/pricing.js';

export const listProducts = (opts) => Product.list(opts);
export const listCategories = () => Product.listCategories();

export async function getProduct(id) {
    const product = await Product.findById(id);
    if (!product) throw AppError.notFound('Producto no encontrado');
    return product;
}

export async function createProduct(data, userId) {
    const existing = await Product.findByCode(data.code);
    if (existing) {
        throw AppError.conflict(`Ya existe un producto con el código ${data.code}: ${existing.name}`, {
            product_id: existing.id,
        });
    }

    const initialStock = data.stock ?? 0;
    return withTransaction(async (client) => {
        const { rows } = await client.query(
            `INSERT INTO products (code, name, description, category, brand, cost, stock, min_stock, created_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
             RETURNING id, code, name, description, category, brand, cost,
                       price_cash, price_credit_4, price_credit_8,
                       stock, min_stock, is_active, created_at, updated_at`,
            [
                data.code,
                data.name,
                data.description ?? null,
                data.category ?? 'General',
                data.brand ?? null,
                data.cost,
                initialStock,
                data.min_stock ?? 0,
                userId ?? null,
            ]
        );
        const product = rows[0];

        if (initialStock > 0) {
            await client.query(
                `INSERT INTO stock_movements (product_id, movement, quantity, stock_after, reason, created_by)
                 VALUES ($1, 'entrada', $2, $3, 'stock_inicial', $4)`,
                [product.id, initialStock, initialStock, userId ?? null]
            );
        }
        return product;
    });
}

export async function updateProduct(id, data) {
    const current = await Product.findById(id);
    if (!current) throw AppError.notFound('Producto no encontrado');

    if (data.code && data.code.toUpperCase() !== current.code.toUpperCase()) {
        const other = await Product.findByCode(data.code);
        if (other && other.id !== current.id) {
            throw AppError.conflict(`El código ${data.code} ya lo usa el producto "${other.name}"`);
        }
    }
    return Product.update(id, data);
}

export async function setProductActive(id, isActive) {
    const current = await Product.findById(id);
    if (!current) throw AppError.notFound('Producto no encontrado');
    return Product.setActive(id, isActive);
}

/** Entrada / salida / ajuste manual de inventario, siempre con trazabilidad. */
export async function adjustStock(id, { delta, reason }, userId) {
    const current = await Product.findById(id);
    if (!current) throw AppError.notFound('Producto no encontrado');

    if (delta === 0) throw AppError.badRequest('La cantidad de ajuste no puede ser cero');
    if (current.stock + delta < 0) {
        throw AppError.unprocessable(
            `El ajuste dejaría el stock en ${current.stock + delta}. Stock disponible: ${current.stock}`
        );
    }

    return withTransaction(async (client) => {
        await Product.adjustStock(client, { productId: id, delta, reason: reason || 'ajuste_manual', userId });
        const { rows } = await client.query(
            `SELECT id, code, name, description, category, brand, cost,
                    price_cash, price_credit_4, price_credit_8,
                    stock, min_stock, is_active, created_at, updated_at
               FROM products WHERE id = $1`,
            [id]
        );
        return rows[0];
    });
}

export const getStockMovements = (id, limit) => Product.listStockMovements(id, limit);

/** Vista previa de precios sin persistir nada (útil en el formulario de alta). */
export const previewPrices = (cost) => priceTable(cost);
