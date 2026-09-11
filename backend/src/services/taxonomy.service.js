/**
 * CATEGORÍAS Y MARCAS — reglas de negocio.
 *
 * La regla central es una sola: NO puede haber dos entradas que sean la
 * misma después de normalizar. "Facenco", "FACENCO" y "facenco" son una
 * marca, no tres. La comprobación se hace aquí para poder dar un mensaje
 * claro y decir a cuál se parece; el índice único sobre la forma
 * normalizada de la base de datos sigue siendo la garantía real contra la
 * condición de carrera de dos altas simultáneas.
 */
import * as Taxonomy from '../models/taxonomy.model.js';
import { AppError } from '../utils/AppError.js';

const LABEL = { categories: 'categoría', brands: 'marca' };

const API = {
    categories: {
        list: Taxonomy.listCategories,
        findById: Taxonomy.findCategoryById,
        findByName: Taxonomy.findCategoryByName,
        create: Taxonomy.createCategory,
        update: Taxonomy.updateCategory,
        setActive: Taxonomy.setCategoryActive,
        count: Taxonomy.countCategoryProducts,
    },
    brands: {
        list: Taxonomy.listBrands,
        findById: Taxonomy.findBrandById,
        findByName: Taxonomy.findBrandByName,
        create: Taxonomy.createBrand,
        update: Taxonomy.updateBrand,
        setActive: Taxonomy.setBrandActive,
        count: Taxonomy.countBrandProducts,
    },
};

function apiFor(kind) {
    const api = API[kind];
    if (!api) throw new Error(`Taxonomía desconocida: ${kind}`);
    return api;
}

export const listTaxonomy = (kind, opts) => apiFor(kind).list(opts);

export async function getTaxonomy(kind, id) {
    const row = await apiFor(kind).findById(id);
    if (!row) throw AppError.notFound(`No se encontró la ${LABEL[kind]}`);
    return { ...row, usage: await apiFor(kind).count(id) };
}

export async function createTaxonomy(kind, data, userId) {
    const api = apiFor(kind);

    // `data.name` llega ya normalizado por el validador; se compara
    // normalizado a ambos lados para que la comparación no dependa de cómo
    // se guardó la fila existente.
    const existing = await api.findByName(data.name);
    if (existing) {
        throw AppError.conflict(
            `Ya existe la ${LABEL[kind]} "${existing.name}". No se crean duplicados por mayúsculas o tildes.`,
            { id: existing.id, name: existing.name }
        );
    }
    return api.create(data, userId);
}

export async function updateTaxonomy(kind, id, data) {
    const api = apiFor(kind);

    const current = await api.findById(id);
    if (!current) throw AppError.notFound(`No se encontró la ${LABEL[kind]}`);

    if (data.name) {
        const other = await api.findByName(data.name);
        if (other && other.id !== current.id) {
            throw AppError.conflict(`Ese nombre ya lo usa la ${LABEL[kind]} "${other.name}"`);
        }
    }
    return api.update(id, data);
}

export async function setTaxonomyActive(kind, id, isActive) {
    const api = apiFor(kind);

    const current = await api.findById(id);
    if (!current) throw AppError.notFound(`No se encontró la ${LABEL[kind]}`);

    // Desactivar no borra ni desvincula nada (RN-0006): los productos
    // conservan su categoría o su marca. Solo deja de ofrecerse para
    // asignaciones nuevas. Se avisa de cuántos productos la usan.
    if (!isActive) {
        const usage = await api.count(id);
        if (usage.active > 0) {
            return {
                ...(await api.setActive(id, false)),
                warning: `${usage.active} producto(s) activo(s) siguen usando esta ${LABEL[kind]}. Se conservan; solo deja de ofrecerse para asignaciones nuevas.`,
            };
        }
    }
    return api.setActive(id, isActive);
}

/** Árbol CATEGORÍA -> MARCA -> productos, para la navegación del catálogo. */
export const catalogTree = () => Taxonomy.catalogTree();
