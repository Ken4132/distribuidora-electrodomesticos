import { useCallback, useEffect, useState } from 'react';
import { productsApi } from '../services/api.js';
import { useDebounce } from '../hooks/useDebounce.js';
import { useToast } from '../context/ToastContext.jsx';
import { Badge, EmptyState, Field, Modal, Pagination, SearchInput, Spinner } from '../components/ui.jsx';
import { money } from '../utils/format.js';

const EMPTY = { code: '', name: '', description: '', category: 'General', brand: '', cost: '', stock: 0, min_stock: 0 };

export default function Products() {
    const toast = useToast();
    const [search, setSearch] = useState('');
    const [status, setStatus] = useState('active');
    const [lowStock, setLowStock] = useState(false);
    const [page, setPage] = useState(1);
    const [state, setState] = useState({ loading: true, rows: [], pagination: null });
    const [modal, setModal] = useState(null);
    const [stockModal, setStockModal] = useState(null);
    const debounced = useDebounce(search);

    const load = useCallback(async () => {
        setState((s) => ({ ...s, loading: true }));
        try {
            const res = await productsApi.list({
                search: debounced,
                status,
                lowStock: String(lowStock),
                page,
                pageSize: 15,
            });
            setState({ loading: false, rows: res.data, pagination: res.pagination });
        } catch (e) {
            setState({ loading: false, rows: [], pagination: null });
            toast.error(e.message);
        }
    }, [debounced, status, lowStock, page, toast]);

    useEffect(() => {
        load();
    }, [load]);
    useEffect(() => {
        setPage(1);
    }, [debounced, status, lowStock]);

    async function toggleActive(p) {
        try {
            await productsApi.setActive(p.id, !p.is_active);
            toast.success(p.is_active ? 'Producto desactivado' : 'Producto activado');
            load();
        } catch (e) {
            toast.error(e.fullMessage);
        }
    }

    return (
        <div className="page">
            <div className="page__head">
                <div>
                    <h1>Productos</h1>
                    <p className="page__sub">
                        Los precios se calculan solos: contado +30%, 4 pagos +50%, 8 pagos +70%
                    </p>
                </div>
                <button className="btn btn--primary" onClick={() => setModal({ mode: 'create', data: EMPTY })}>
                    Nuevo producto
                </button>
            </div>

            <div className="toolbar">
                <SearchInput value={search} onChange={setSearch} placeholder="Código, nombre o marca…" />
                <select className="input input--select" value={status} onChange={(e) => setStatus(e.target.value)}>
                    <option value="active">Activos</option>
                    <option value="inactive">Inactivos</option>
                    <option value="all">Todos</option>
                </select>
                <label className="checkbox">
                    <input type="checkbox" checked={lowStock} onChange={(e) => setLowStock(e.target.checked)} />
                    Solo stock bajo
                </label>
            </div>

            {state.loading ? (
                <Spinner />
            ) : state.rows.length === 0 ? (
                <EmptyState title="No hay productos que coincidan" hint="Registra un producto para empezar a vender." />
            ) : (
                <div className="table-wrap">
                    <table className="table">
                        <thead>
                            <tr>
                                <th>Código</th>
                                <th>Producto</th>
                                <th>Categoría</th>
                                <th className="right">Costo</th>
                                <th className="right">Contado</th>
                                <th className="right">4 pagos</th>
                                <th className="right">8 pagos</th>
                                <th className="right">Stock</th>
                                <th>Estado</th>
                                <th className="right">Acciones</th>
                            </tr>
                        </thead>
                        <tbody>
                            {state.rows.map((p) => (
                                <tr key={p.id}>
                                    <td className="mono">{p.code}</td>
                                    <td>
                                        {p.name}
                                        {p.brand && <span className="muted"> · {p.brand}</span>}
                                    </td>
                                    <td>{p.category}</td>
                                    <td className="right muted">{money(p.cost)}</td>
                                    <td className="right">{money(p.price_cash)}</td>
                                    <td className="right">{money(p.price_credit_4)}</td>
                                    <td className="right">{money(p.price_credit_8)}</td>
                                    <td className={`right strong ${p.stock <= p.min_stock ? 'text-danger' : ''}`}>
                                        {p.stock}
                                    </td>
                                    <td>
                                        <Badge status={p.is_active ? 'pagada' : 'anulada'}>
                                            {p.is_active ? 'Activo' : 'Inactivo'}
                                        </Badge>
                                    </td>
                                    <td className="right nowrap">
                                        <button className="btn btn--ghost btn--sm" onClick={() => setStockModal(p)}>
                                            Stock
                                        </button>
                                        <button
                                            className="btn btn--ghost btn--sm"
                                            onClick={() => setModal({ mode: 'edit', data: p })}
                                        >
                                            Editar
                                        </button>
                                        <button className="btn btn--ghost btn--sm" onClick={() => toggleActive(p)}>
                                            {p.is_active ? 'Desactivar' : 'Activar'}
                                        </button>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}

            <Pagination pagination={state.pagination} onChange={setPage} />

            {modal && (
                <ProductModal
                    mode={modal.mode}
                    initial={modal.data}
                    onClose={() => setModal(null)}
                    onSaved={() => {
                        setModal(null);
                        load();
                    }}
                />
            )}
            {stockModal && (
                <StockModal
                    product={stockModal}
                    onClose={() => setStockModal(null)}
                    onSaved={() => {
                        setStockModal(null);
                        load();
                    }}
                />
            )}
        </div>
    );
}

function ProductModal({ mode, initial, onClose, onSaved }) {
    const toast = useToast();
    const [form, setForm] = useState({ ...EMPTY, ...initial });
    const [errors, setErrors] = useState({});
    const [busy, setBusy] = useState(false);

    const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

    // Vista previa de precios calculada en el cliente con la MISMA regla del
    // backend; al guardar, el valor autoritativo lo devuelve la base de datos.
    const cost = Number(form.cost) || 0;
    const preview = {
        contado: Math.round(cost * 1.3 * 100) / 100,
        credito_4: Math.round(cost * 1.5 * 100) / 100,
        credito_8: Math.round(cost * 1.7 * 100) / 100,
    };

    async function submit(e) {
        e.preventDefault();
        setBusy(true);
        setErrors({});
        try {
            const base = {
                code: form.code,
                name: form.name,
                description: form.description || '',
                category: form.category,
                brand: form.brand || '',
                cost: Number(form.cost),
                min_stock: Number(form.min_stock) || 0,
            };
            if (mode === 'create') {
                await productsApi.create({ ...base, stock: Number(form.stock) || 0 });
                toast.success('Producto registrado');
            } else {
                await productsApi.update(initial.id, base);
                toast.success('Producto actualizado');
            }
            onSaved();
        } catch (err) {
            setErrors(err.fieldErrors);
            toast.error(err.message);
        } finally {
            setBusy(false);
        }
    }

    return (
        <Modal open title={mode === 'create' ? 'Nuevo producto' : 'Editar producto'} onClose={onClose} wide>
            <form onSubmit={submit} className="form-grid">
                <Field label="Código" required error={errors.code} className="span-1">
                    <input className="input mono" autoFocus value={form.code} onChange={set('code')} />
                </Field>
                <Field label="Nombre" required error={errors.name} className="span-2">
                    <input className="input" value={form.name} onChange={set('name')} />
                </Field>
                <Field label="Categoría" required error={errors.category} className="span-1">
                    <input className="input" value={form.category} onChange={set('category')} />
                </Field>
                <Field label="Marca" error={errors.brand} className="span-1">
                    <input className="input" value={form.brand ?? ''} onChange={set('brand')} />
                </Field>
                <Field label="Costo (Q)" required error={errors.cost} className="span-1">
                    <input
                        className="input"
                        type="number"
                        step="0.01"
                        min="0"
                        value={form.cost}
                        onChange={set('cost')}
                    />
                </Field>

                {mode === 'create' && (
                    <Field label="Stock inicial" error={errors.stock} className="span-1">
                        <input
                            className="input"
                            type="number"
                            min="0"
                            value={form.stock}
                            onChange={set('stock')}
                        />
                    </Field>
                )}
                <Field label="Stock mínimo" error={errors.min_stock} hint="Para avisar cuando baje" className="span-1">
                    <input className="input" type="number" min="0" value={form.min_stock} onChange={set('min_stock')} />
                </Field>

                <Field label="Descripción" error={errors.description} className="span-3">
                    <textarea className="input" rows={2} value={form.description ?? ''} onChange={set('description')} />
                </Field>

                <div className="price-preview span-3">
                    <span className="price-preview__title">Precios de venta calculados</span>
                    <div className="price-preview__row">
                        <div>
                            <span>Contado (+30%)</span>
                            <strong>{money(preview.contado)}</strong>
                        </div>
                        <div>
                            <span>4 pagos (+50%)</span>
                            <strong>{money(preview.credito_4)}</strong>
                            <em>{money(preview.credito_4 / 4)} c/u</em>
                        </div>
                        <div>
                            <span>8 pagos (+70%)</span>
                            <strong>{money(preview.credito_8)}</strong>
                            <em>{money(preview.credito_8 / 8)} c/u</em>
                        </div>
                    </div>
                </div>

                <div className="form-actions span-3">
                    <button type="button" className="btn btn--ghost" onClick={onClose}>
                        Cancelar
                    </button>
                    <button className="btn btn--primary" disabled={busy}>
                        {busy ? 'Guardando…' : 'Guardar producto'}
                    </button>
                </div>
            </form>
        </Modal>
    );
}

function StockModal({ product, onClose, onSaved }) {
    const toast = useToast();
    const [delta, setDelta] = useState('');
    const [reason, setReason] = useState('compra');
    const [busy, setBusy] = useState(false);

    async function submit(e) {
        e.preventDefault();
        setBusy(true);
        try {
            await productsApi.adjustStock(product.id, Number(delta), reason);
            toast.success('Inventario actualizado');
            onSaved();
        } catch (err) {
            toast.error(err.fullMessage);
        } finally {
            setBusy(false);
        }
    }

    const resulting = product.stock + (Number(delta) || 0);

    return (
        <Modal open title={`Inventario — ${product.name}`} onClose={onClose}>
            <form onSubmit={submit}>
                <p className="muted">
                    Stock actual: <strong>{product.stock}</strong> unidades
                </p>
                <Field
                    label="Cantidad"
                    required
                    hint="Positivo para entrada (compra), negativo para salida (merma, devolución)"
                >
                    <input
                        className="input"
                        type="number"
                        autoFocus
                        value={delta}
                        onChange={(e) => setDelta(e.target.value)}
                    />
                </Field>
                <Field label="Motivo">
                    <select className="input input--select" value={reason} onChange={(e) => setReason(e.target.value)}>
                        <option value="compra">Compra a proveedor</option>
                        <option value="devolucion">Devolución de cliente</option>
                        <option value="merma">Merma o daño</option>
                        <option value="conteo_fisico">Ajuste por conteo físico</option>
                        <option value="ajuste_manual">Otro ajuste</option>
                    </select>
                </Field>
                <p className={resulting < 0 ? 'alert alert--error' : 'muted'}>
                    Stock resultante: <strong>{resulting}</strong>
                </p>
                <div className="form-actions">
                    <button type="button" className="btn btn--ghost" onClick={onClose}>
                        Cancelar
                    </button>
                    <button className="btn btn--primary" disabled={busy || !delta || resulting < 0}>
                        {busy ? 'Guardando…' : 'Aplicar'}
                    </button>
                </div>
            </form>
        </Modal>
    );
}
