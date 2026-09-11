import { withTransaction } from '../config/db.js';
import * as Product from '../models/product.model.js';
import * as Taxonomy from '../models/taxonomy.model.js';
import { AppError } from '../utils/AppError.js';
import { priceTable } from '../utils/pricing.js';
import { toCents } from '../utils/money.js';

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

    await assertTaxonomyExists(data);

    const initialStock = data.stock ?? 0;
    return withTransaction(async (client) => {
        const { rows } = await client.query(
            `INSERT INTO products (code, name, description, category, brand, model,
                                   category_id, brand_id, cost, stock, min_stock, created_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
             RETURNING id, code, name, description, category, brand, model, category_id, brand_id, cost,
                       price_cash, price_credit_4, price_credit_8,
                       stock, min_stock, is_active, created_at, updated_at`,
            [
                data.code,
                data.name,
                data.description ?? null,
                data.category ?? 'GENERAL',
                data.brand ?? null,
                data.model ?? null,
                data.category_id ?? null,
                data.brand_id ?? null,
                data.cost,
                initialStock,
                data.min_stock ?? 0,
                userId ?? null,
            ]
        );
        const product = rows[0];

        // Primer punto del histórico de costos: el costo con el que nace el
        // producto. Sin esto, el primer cambio no tendría contra qué comparar.
        await Product.recordCostChange(client, {
            productId: product.id,
            cost: product.cost,
            previousCost: null,
            reason: 'inicial',
            notes: data.cost_notes ?? null,
            userId,
        });

        if (initialStock > 0) {
            // Se registra por la misma vía que cualquier otro movimiento: sin
            // sucursal declarada, la base lo imputa a la predeterminada y el
            // inventario por sucursal queda cuadrado desde el primer día.
            await client.query(
                `INSERT INTO stock_movements (product_id, movement, quantity, stock_after, reason, created_by)
                 VALUES ($1, 'entrada', $2, $3, 'stock_inicial', $4)`,
                [product.id, initialStock, initialStock, userId ?? null]
            );
        }
        return product;
    });
}

export async function updateProduct(id, data, userId = null) {
    const current = await Product.findById(id);
    if (!current) throw AppError.notFound('Producto no encontrado');

    if (data.code && data.code.toUpperCase() !== current.code.toUpperCase()) {
        const other = await Product.findByCode(data.code);
        if (other && other.id !== current.id) {
            throw AppError.conflict(`El código ${data.code} ya lo usa el producto "${other.name}"`);
        }
    }

    await assertTaxonomyExists(data);

    const costChanged = data.cost !== undefined && data.cost !== null && toCents(data.cost) !== toCents(current.cost);

    // Sin cambio de costo no hace falta transacción: es una sola sentencia.
    if (!costChanged) return Product.update(id, data);

    // Con cambio de costo, el producto y su histórico se escriben juntos o no
    // se escribe ninguno: un costo sin rastro no sirve para auditar nada.
    return withTransaction(async (client) => {
        const { rows } = await client.query(
            `UPDATE products SET
                 code        = COALESCE($2, code),
                 name        = COALESCE($3, name),
                 description = $4,
                 category    = COALESCE($5, category),
                 brand       = $6,
                 model       = $7,
                 cost        = COALESCE($8, cost),
                 min_stock   = COALESCE($9, min_stock),
                 category_id = COALESCE($10, category_id),
                 brand_id    = CASE WHEN $11::bigint = 0 THEN NULL
                                    ELSE COALESCE($11::bigint, brand_id) END
             WHERE id = $1
             RETURNING id, code, name, description, category, brand, model, category_id, brand_id, cost,
                       price_cash, price_credit_4, price_credit_8,
                       stock, min_stock, is_active, created_at, updated_at`,
            [
                id,
                data.code ?? null,
                data.name ?? null,
                data.description ?? null,
                data.category ?? null,
                data.brand ?? null,
                data.model ?? null,
                data.cost ?? null,
                data.min_stock ?? null,
                data.category_id ?? null,
                data.brand_id ?? null,
            ]
        );
        const updated = rows[0];

        await Product.recordCostChange(client, {
            productId: id,
            cost: updated.cost,
            previousCost: current.cost,
            reason: 'actualizacion',
            notes: data.cost_notes ?? null,
            userId,
        });

        return updated;
    });
}

/** La categoría y la marca referenciadas tienen que existir y estar activas. */
async function assertTaxonomyExists({ category_id: categoryId, brand_id: brandId }) {
    if (categoryId) {
        const category = await Taxonomy.findCategoryById(categoryId);
        if (!category) throw AppError.badRequest('La categoría seleccionada no existe');
        if (!category.is_active) throw AppError.unprocessable(`La categoría "${category.name}" está desactivada`);
    }
    if (brandId) {
        const brand = await Taxonomy.findBrandById(brandId);
        if (!brand) throw AppError.badRequest('La marca seleccionada no existe');
        if (!brand.is_active) throw AppError.unprocessable(`La marca "${brand.name}" está desactivada`);
    }
}

/** Histórico de costos de un producto (RN-0001: exige ver costos). */
export async function getCostHistory(id, limit = 100) {
    const product = await Product.findById(id);
    if (!product) throw AppError.notFound('Producto no encontrado');
    return Product.listCostHistory(id, limit);
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
