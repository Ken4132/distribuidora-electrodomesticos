import { useCallback, useEffect, useState } from 'react';
import { productsApi } from '../services/api.js';
import { useDebounce } from '../hooks/useDebounce.js';
import { useToast } from '../context/ToastContext.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import { usePaymentModes } from '../hooks/usePaymentModes.js';
import { Badge, EmptyState, Field, Modal, Pagination, SearchInput, Spinner } from '../components/ui.jsx';
import { money, formatDate } from '../utils/format.js';

const EMPTY = {
    code: '',
    name: '',
    description: '',
    category: 'General',
    brand: '',
    model: '',
    cost: '',
    stock: 0,
    min_stock: 0,
};

export default function Products() {
    const toast = useToast();
    const { can } = useAuth();
    const { modes } = usePaymentModes();

    // RN-0001 y RN-0002: el costo y los porcentajes solo se muestran a quien
    // tiene el permiso. El backend además no los envía, así que aquí no hay
    // nada que ocultar de más: simplemente no se pinta la columna.
    const seeCost = can('products.cost.view');
    const mayCreate = can('products.create');
    const mayUpdate = can('products.update');
    const mayStatus = can('products.status');
    const mayStock = can('products.stock');
    // El histórico de costos es el mismo secreto que el costo actual
    // (RN-0001), así que se rige por el mismo permiso.
    const mayCost = seeCost;
    // La disponibilidad por sucursal la puede consultar cualquiera que
    // vea productos, así que la columna de acciones siempre se pinta.
    const hasActions = true;
    const [search, setSearch] = useState('');
    const [status, setStatus] = useState('active');
    const [lowStock, setLowStock] = useState(false);
    const [page, setPage] = useState(1);
    const [state, setState] = useState({ loading: true, rows: [], pagination: null });
    const [modal, setModal] = useState(null);
    const [stockModal, setStockModal] = useState(null);
    const [costModal, setCostModal] = useState(null);
    const [availModal, setAvailModal] = useState(null);
    // Cuando el backend responde con alcance, el usuario opera con el
    // inventario de una sola sucursal: se muestra esa existencia aparte.
    const [scope, setScope] = useState(null);
    const debounced = useDebounce(search);

    // Texto de ayuda construido con las reglas que informa el backend.
    const pricingHint =
        seeCost && modes.length
            ? `Los precios se calculan solos: ${modes.map((m) => `${m.label.toLowerCase()} +${m.markup_percent}%`).join(', ')}`
            : 'Los precios de venta son los autorizados por la administración';

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
            setScope(res.scope ?? null);
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
                    <p className="page__sub">{pricingHint}</p>
                </div>
                {mayCreate && (
                    <button className="btn btn--primary" onClick={() => setModal({ mode: 'create', data: EMPTY })}>
                        Nuevo producto
                    </button>
                )}
            </div>

            <div className="toolbar">
                <SearchInput value={search} onChange={setSearch} placeholder="Código, nombre, marca o modelo…" />
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
                                {seeCost && <th className="right">Costo</th>}
                                <th className="right">Contado</th>
                                <th className="right">4 pagos</th>
                                <th className="right">8 pagos</th>
                                {scope ? <th className="right">Tu sucursal</th> : null}
                                <th className="right">{scope ? 'Total empresa' : 'Stock'}</th>
                                <th>Estado</th>
                                {hasActions && <th className="right">Acciones</th>}
                            </tr>
                        </thead>
                        <tbody>
                            {state.rows.map((p) => (
                                <tr key={p.id}>
                                    <td className="mono">{p.code}</td>
                                    <td>
                                        {p.name}
                                        {p.brand && <span className="muted"> · {p.brand}</span>}
                                        {p.model && <span className="muted"> {p.model}</span>}
                                    </td>
                                    <td>{p.category}</td>
                                    {seeCost && <td className="right muted">{money(p.cost)}</td>}
                                    <td className="right">{money(p.price_cash)}</td>
                                    <td className="right">{money(p.price_credit_4)}</td>
                                    <td className="right">{money(p.price_credit_8)}</td>
                                    {scope ? (
                                        <td
                                            className={`right strong ${
                                                (p.branch_stock ?? 0) <= p.min_stock ? 'text-danger' : ''
                                            }`}
                                            title="Existencia con la que puedes operar"
                                        >
                                            {p.branch_stock ?? 0}
                                        </td>
                                    ) : null}
                                    <td
                                        className={`right ${scope ? 'muted' : 'strong'} ${
                                            !scope && p.stock <= p.min_stock ? 'text-danger' : ''
                                        }`}
                                        title={scope ? 'Informativo: incluye otras sucursales' : undefined}
                                    >
                                        {p.stock}
                                    </td>
                                    <td>
                                        <Badge status={p.is_active ? 'pagada' : 'anulada'}>
                                            {p.is_active ? 'Activo' : 'Inactivo'}
                                        </Badge>
                                    </td>
                                    {hasActions && (
                                        <td className="right nowrap">
                                            {mayStock && (
                                                <button
                                                    className="btn btn--ghost btn--sm"
                                                    onClick={() => setStockModal(p)}
                                                >
                                                    Stock
                                                </button>
                                            )}
                                            {mayUpdate && (
                                                <button
                                                    className="btn btn--ghost btn--sm"
                                                    onClick={() => setModal({ mode: 'edit', data: p })}
                                                >
                                                    Editar
                                                </button>
                                            )}
                                            <button
                                                className="btn btn--ghost btn--sm"
                                                onClick={() => setAvailModal(p)}
                                                title="Disponibilidad por sucursal"
                                            >
                                                Disponibilidad
                                            </button>
                                            {mayCost && (
                                                <button
                                                    className="btn btn--ghost btn--sm"
                                                    onClick={() => setCostModal(p)}
                                                    title="Histórico de costos"
                                                >
                                                    Costos
                                                </button>
                                            )}
                                            {mayStatus && (
                                                <button
                                                    className="btn btn--ghost btn--sm"
                                                    onClick={() => toggleActive(p)}
                                                >
                                                    {p.is_active ? 'Desactivar' : 'Activar'}
                                                </button>
                                            )}
                                        </td>
                                    )}
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
            {costModal && <CostHistoryModal product={costModal} onClose={() => setCostModal(null)} />}
            {availModal && <AvailabilityModal product={availModal} onClose={() => setAvailModal(null)} />}
        </div>
    );
}

function ProductModal({ mode, initial, onClose, onSaved }) {
    const toast = useToast();
    const { modes } = usePaymentModes();
    const [form, setForm] = useState({ ...EMPTY, ...initial });
    const [errors, setErrors] = useState({});
    const [busy, setBusy] = useState(false);

    const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

    // Vista previa de precios. Los porcentajes NO están escritos aquí: vienen
    // del backend (/api/sales/payment-modes), que es la única fuente de la
    // regla comercial. Al guardar, el precio definitivo lo calcula la BD.
    // `markup` solo llega a quien puede ver costos (RN-0001). Sin él no se
    // puede ni se debe calcular la vista previa.
    const cost = Number(form.cost) || 0;
    const preview = modes
        .filter((m) => typeof m.markup === 'number')
        .map((m) => ({ ...m, price: Math.round(cost * (1 + m.markup) * 100) / 100 }));

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
                model: form.model || '',
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
                <Field label="Modelo" error={errors.model} className="span-1">
                    <input className="input" value={form.model ?? ''} onChange={set('model')} />
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

                <div className="price-preview span-3" hidden={preview.length === 0}>
                    <span className="price-preview__title">Precios de venta calculados</span>
                    <div className="price-preview__row">
                        {preview.map((m) => (
                            <div key={m.key}>
                                <span>
                                    {m.label} (+{m.markup_percent}%)
                                </span>
                                <strong data-mode={m.key}>{money(m.price)}</strong>
                                {m.installments > 1 && <em>{money(m.price / m.installments)} c/u</em>}
                            </div>
                        ))}
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

/**
 * Histórico de costos de un producto.
 *
 * Responde a "¿cuánto costaba esto en tal fecha y quién lo cambió?".
 * NO afecta a las ventas ya registradas: cada venta conserva el costo que
 * tenía el producto ese día, congelado en su detalle.
 */
function CostHistoryModal({ product, onClose }) {
    const toast = useToast();
    const [state, setState] = useState({ loading: true, rows: [], inventory: [] });

    useEffect(() => {
        productsApi
            .costHistory(product.id)
            .then((hist) => setState({ loading: false, rows: hist.data, inventory: [] }))
            .catch((e) => {
                setState({ loading: false, rows: [], inventory: [] });
                toast.error(e.fullMessage);
            });
    }, [product.id, toast]);

    return (
        <Modal open title={`Costos — ${product.code} ${product.name}`} onClose={onClose} wide>
            {state.loading ? (
                <Spinner />
            ) : (
                <>
                    <p className="muted">
                        Las ventas ya registradas conservan el costo que tenía el producto ese día. Cambiar el costo
                        aquí no las recalcula.
                    </p>

                    {state.rows.length === 0 ? (
                        <EmptyState title="Sin movimientos de costo" />
                    ) : (
                        <div className="table-wrap">
                            <table className="table">
                                <thead>
                                    <tr>
                                        <th>Fecha</th>
                                        <th className="right">Costo</th>
                                        <th className="right">Anterior</th>
                                        <th className="right">Variación</th>
                                        <th>Motivo</th>
                                        <th>Usuario</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {state.rows.map((h) => (
                                        <tr key={h.id}>
                                            <td>{formatDate(h.changed_at)}</td>
                                            <td className="right">
                                                <strong>Q{money(h.cost)}</strong>
                                            </td>
                                            <td className="right">{h.previous_cost ? `Q${money(h.previous_cost)}` : '—'}</td>
                                            <td className="right">
                                                {Number(h.variation) === 0
                                                    ? '—'
                                                    : `${Number(h.variation) > 0 ? '+' : ''}Q${money(h.variation)}`}
                                            </td>
                                            <td>{h.reason}</td>
                                            <td>{h.changed_by_username ?? '—'}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}

                    {state.inventory.length > 0 ? (
                        <>
                            <h3 className="mt">Existencias por sucursal</h3>
                            <div className="table-wrap">
                                <table className="table">
                                    <thead>
                                        <tr>
                                            <th>Sucursal</th>
                                            <th className="right">Existencia</th>
                                            <th className="right">Mínimo</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {state.inventory.map((i) => (
                                            <tr key={i.branch_id}>
                                                <td>{i.branch_name}</td>
                                                <td className="right">{i.quantity}</td>
                                                <td className="right">{i.min_stock}</td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        </>
                    ) : null}
                </>
            )}
        </Modal>
    );
}

/**
 * Disponibilidad del producto por sucursal.
 *
 * Es una CONSULTA INFORMATIVA. Para un usuario que opera con una sola
 * sucursal, el desglose marca explícitamente qué unidades son suyas y
 * cuáles solo puede ver: saber que hay 5 camas en otra sucursal no
 * convierte esas 5 camas en stock disponible para vender.
 */
function AvailabilityModal({ product, onClose }) {
    const toast = useToast();
    const [state, setState] = useState({ loading: true, data: null });

    useEffect(() => {
        productsApi
            .inventory(product.id)
            .then((res) => setState({ loading: false, data: res.data }))
            .catch((e) => {
                setState({ loading: false, data: null });
                toast.error(e.fullMessage);
            });
    }, [product.id, toast]);

    const d = state.data;

    return (
        <Modal open title={`Disponibilidad — ${product.code} ${product.name}`} onClose={onClose}>
            {state.loading ? (
                <Spinner />
            ) : !d ? (
                <EmptyState title="No se pudo consultar la disponibilidad" />
            ) : (
                <>
                    <div className="cards">
                        <div className="card">
                            <div className="card__label">Con la que puedes operar</div>
                            <div className="card__value">{d.operational_stock}</div>
                        </div>
                        {!d.scope.global ? (
                            <div className="card">
                                <div className="card__label">En otras sucursales (informativo)</div>
                                <div className="card__value muted">{d.informational_stock}</div>
                            </div>
                        ) : null}
                    </div>

                    {d.notice ? <div className="alert">{d.notice}</div> : null}

                    <div className="table-wrap">
                        <table className="table">
                            <thead>
                                <tr>
                                    <th>Sucursal</th>
                                    <th className="right">Existencia</th>
                                    <th>Para ti</th>
                                </tr>
                            </thead>
                            <tbody>
                                {d.branches.map((b) => (
                                    <tr key={b.branch_id} className={b.operational ? '' : 'muted'}>
                                        <td>{b.branch_name}</td>
                                        <td className="right strong">{b.quantity}</td>
                                        <td>
                                            {b.operational ? (
                                                <Badge status="pagada">Operativa</Badge>
                                            ) : (
                                                <Badge status="pendiente">Solo informativa</Badge>
                                            )}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </>
            )}
        </Modal>
    );
}
