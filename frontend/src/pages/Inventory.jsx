import { useCallback, useEffect, useState } from 'react';
import { inventoryApi, branchesApi, productsApi } from '../services/api.js';
import { useDebounce } from '../hooks/useDebounce.js';
import { useToast } from '../context/ToastContext.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import { EmptyState, Field, Modal, Pagination, SearchInput, Spinner } from '../components/ui.jsx';

/**
 * Inventario por sucursal.
 *
 * Todo ajuste que se hace aquí pasa por el mismo camino que usa una venta:
 * deja un movimiento con su motivo y su responsable, y de ahí se aplica al
 * inventario. No hay forma de cambiar existencias sin rastro.
 */
export default function Inventory() {
    const toast = useToast();
    const { can } = useAuth();
    const puedeAjustar = can('inventory.manage');
    // Alcance propio: el usuario opera con el inventario de SU sucursal.
    // El backend lo impone igualmente; esto solo evita ofrecerle un
    // selector de sucursal que no va a poder usar.
    const alcancePropio = !can('inventory.view') && can('inventory.view.own');

    const [branches, setBranches] = useState([]);
    const [summary, setSummary] = useState([]);
    const [branchId, setBranchId] = useState('');
    const [search, setSearch] = useState('');
    const [restock, setRestock] = useState(false);
    const [page, setPage] = useState(1);
    const [state, setState] = useState({ loading: true, rows: [], pagination: null });
    const [modal, setModal] = useState(null);
    const [mismatches, setMismatches] = useState(null);
    const [notice, setNotice] = useState(null);
    const debounced = useDebounce(search);

    // El listado de sucursales solo lo pide quien puede consultarlas. Un
    // usuario de alcance propio no lo necesita: su sucursal se la impone el
    // servidor, y pedirlo le devolvería un 403 y un error en pantalla.
    const puedeVerSucursales = can('branches.view');
    useEffect(() => {
        if (!puedeVerSucursales) return;
        branchesApi
            .list({ status: 'active' })
            .then((res) => setBranches(res.data))
            .catch((e) => toast.error(e.message));
    }, [puedeVerSucursales, toast]);

    const loadSummary = useCallback(() => {
        inventoryApi
            .summary()
            .then((res) => setSummary(res.data))
            .catch(() => setSummary([]));
    }, []);

    const load = useCallback(async () => {
        setState((s) => ({ ...s, loading: true }));
        try {
            const res = await inventoryApi.list({
                branch_id: branchId || undefined,
                search: debounced,
                restock: restock ? 'true' : 'false',
                page,
                pageSize: 15,
            });
            setState({ loading: false, rows: res.data, pagination: res.pagination });
            setNotice(res.notice ?? null);
        } catch (e) {
            setState({ loading: false, rows: [], pagination: null });
            setNotice(null);
            toast.error(e.message);
        }
    }, [branchId, debounced, restock, page, toast]);

    useEffect(() => {
        load();
        loadSummary();
    }, [load, loadSummary]);
    useEffect(() => {
        setPage(1);
    }, [branchId, debounced, restock]);

    async function checkMismatches() {
        try {
            const res = await inventoryApi.mismatches();
            setMismatches(res.data);
            if (res.data.length === 0) toast.success(res.message);
            else toast.error(res.message);
        } catch (e) {
            toast.error(e.fullMessage);
        }
    }

    return (
        <div className="page">
            <div className="page__head">
                <div>
                    <h1>Inventario</h1>
                    <p className="page__sub">
                        {alcancePropio
                            ? 'Existencias de tu sucursal. Las de otras sucursales se consultan desde el producto, como información.'
                            : 'Existencias desglosadas por sucursal'}
                    </p>
                </div>
                <div className="row-actions">
                    {!alcancePropio ? (
                        <button className="btn btn--ghost" onClick={checkMismatches}>
                            Comprobar cuadre
                        </button>
                    ) : null}
                    {puedeAjustar ? (
                        <button className="btn btn--primary" onClick={() => setModal({ row: null })}>
                            Ajustar existencias
                        </button>
                    ) : null}
                </div>
            </div>

            {summary.length > 0 ? (
                <div className="cards">
                    {summary.map((s) => (
                        <div key={s.branch_id} className="card">
                            <div className="card__label">{s.branch_name}</div>
                            <div className="card__value">{s.stock_units}</div>
                            <div className="card__hint">
                                {s.products_in_stock} producto(s) con existencia
                                {s.needs_restock > 0 ? ` · ${s.needs_restock} bajo mínimo` : ''}
                            </div>
                        </div>
                    ))}
                </div>
            ) : null}

            {notice ? <div className="alert">{notice}</div> : null}

            {mismatches && mismatches.length > 0 ? (
                <div className="alert alert--error">
                    <strong>Descuadre detectado.</strong> La existencia total de estos productos no coincide con la
                    suma de su desglose por sucursal:
                    <ul>
                        {mismatches.map((m) => (
                            <li key={m.product_id}>
                                {m.code} — {m.name}: total {m.product_stock}, desglose {m.inventory_total} (diferencia{' '}
                                {m.difference})
                            </li>
                        ))}
                    </ul>
                </div>
            ) : null}

            <div className="toolbar">
                <SearchInput value={search} onChange={setSearch} placeholder="Producto, código o marca…" />
                {!alcancePropio ? (
                    <select className="input" value={branchId} onChange={(e) => setBranchId(e.target.value)}>
                        <option value="">Todas las sucursales</option>
                        {branches.map((b) => (
                            <option key={b.id} value={b.id}>
                                {b.name}
                                {b.is_default ? ' (predeterminada)' : ''}
                            </option>
                        ))}
                    </select>
                ) : null}
                <label className="checkbox">
                    <input type="checkbox" checked={restock} onChange={(e) => setRestock(e.target.checked)} />
                    Solo bajo mínimo
                </label>
            </div>

            {state.loading ? (
                <Spinner />
            ) : state.rows.length === 0 ? (
                <EmptyState title="Sin existencias que mostrar" hint="Prueba a cambiar la sucursal o la búsqueda" />
            ) : (
                <>
                    <div className="table-wrap">
                        <table className="table">
                            <thead>
                                <tr>
                                    <th>Código</th>
                                    <th>Producto</th>
                                    <th>Sucursal</th>
                                    <th className="num">Existencia</th>
                                    <th className="num">Mínimo</th>
                                    <th />
                                </tr>
                            </thead>
                            <tbody>
                                {state.rows.map((r) => (
                                    <tr key={r.id} className={r.needs_restock ? 'row--warn' : ''}>
                                        <td>
                                            <strong>{r.product_code}</strong>
                                        </td>
                                        <td>
                                            {r.product_name}
                                            <div className="muted small">
                                                {r.category}
                                                {r.brand ? ` · ${r.brand}` : ''}
                                            </div>
                                        </td>
                                        <td>{r.branch_name}</td>
                                        <td className="num">
                                            <strong>{r.quantity}</strong>
                                        </td>
                                        <td className="num">{r.min_stock}</td>
                                        <td className="row-actions">
                                            {puedeAjustar ? (
                                                <button
                                                    className="btn btn--ghost btn--sm"
                                                    onClick={() => setModal({ row: r })}
                                                >
                                                    Ajustar
                                                </button>
                                            ) : null}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                    <Pagination pagination={state.pagination} onChange={setPage} />
                </>
            )}

            {modal ? (
                <AdjustForm
                    row={modal.row}
                    branches={branches}
                    onClose={() => setModal(null)}
                    onSaved={() => {
                        setModal(null);
                        load();
                        loadSummary();
                    }}
                />
            ) : null}
        </div>
    );
}

function AdjustForm({ row, branches, onClose, onSaved }) {
    const toast = useToast();
    const [productQuery, setProductQuery] = useState('');
    const [options, setOptions] = useState([]);
    const [form, setForm] = useState({
        product_id: row?.product_id ?? '',
        branch_id: row?.branch_id ?? branches.find((b) => b.is_default)?.id ?? '',
        delta: '',
        reason: 'ajuste_manual',
        notes: '',
    });
    const [saving, setSaving] = useState(false);
    const debounced = useDebounce(productQuery);

    useEffect(() => {
        if (row || debounced.length < 2) return;
        productsApi
            .list({ search: debounced, status: 'active', pageSize: 10 })
            .then((res) => setOptions(res.data))
            .catch(() => setOptions([]));
    }, [debounced, row]);

    const set = (field) => (e) => setForm((f) => ({ ...f, [field]: e.target.value }));

    async function submit(e) {
        e.preventDefault();
        setSaving(true);
        try {
            const res = await inventoryApi.adjust({
                product_id: Number(form.product_id),
                branch_id: Number(form.branch_id),
                delta: Number(form.delta),
                reason: form.reason || 'ajuste_manual',
                notes: form.notes || null,
            });
            // El backend devuelve un aviso cuando el ajuste cae fuera de la
            // sucursal predeterminada: esa mercadería todavía no la puede
            // vender el flujo actual.
            if (res.data?.warning) toast.error(res.data.warning);
            else toast.success('Inventario actualizado');
            onSaved();
        } catch (err) {
            toast.error(err.fullMessage);
        } finally {
            setSaving(false);
        }
    }

    return (
        <Modal open title="Ajustar existencias" onClose={onClose}>
            <form onSubmit={submit} className="form">
                {row ? (
                    <p className="muted">
                        <strong>{row.product_code}</strong> — {row.product_name} en <strong>{row.branch_name}</strong>
                        <br />
                        Existencia actual: {row.quantity}
                    </p>
                ) : (
                    <>
                        <Field label="Producto" required hint="Escribe al menos dos letras del nombre o del código">
                            <input
                                className="input"
                                value={productQuery}
                                onChange={(e) => setProductQuery(e.target.value)}
                                placeholder="Buscar producto…"
                            />
                        </Field>
                        {options.length > 0 ? (
                            <Field label="Selecciona" required>
                                <select
                                    className="input"
                                    value={form.product_id}
                                    onChange={set('product_id')}
                                    required
                                >
                                    <option value="">—</option>
                                    {options.map((p) => (
                                        <option key={p.id} value={p.id}>
                                            {p.code} — {p.name}
                                        </option>
                                    ))}
                                </select>
                            </Field>
                        ) : null}
                    </>
                )}

                <div className="form__row">
                    <Field label="Sucursal" required>
                        <select className="input" value={form.branch_id} onChange={set('branch_id')} required>
                            {branches.map((b) => (
                                <option key={b.id} value={b.id}>
                                    {b.name}
                                    {b.is_default ? ' (predeterminada)' : ''}
                                </option>
                            ))}
                        </select>
                    </Field>
                    <Field
                        label="Cantidad"
                        required
                        hint="Positiva para entrada, negativa para salida. Cero no se admite."
                    >
                        <input
                            className="input"
                            type="number"
                            step="1"
                            value={form.delta}
                            onChange={set('delta')}
                            required
                        />
                    </Field>
                </div>

                <Field label="Motivo">
                    <select className="input" value={form.reason} onChange={set('reason')}>
                        <option value="ajuste_manual">Ajuste manual</option>
                        <option value="compra">Compra / ingreso de mercadería</option>
                        <option value="traslado_entrada">Traslado — entrada</option>
                        <option value="traslado_salida">Traslado — salida</option>
                        <option value="merma">Merma o daño</option>
                        <option value="conteo_fisico">Corrección por conteo físico</option>
                    </select>
                </Field>

                <Field label="Observaciones">
                    <textarea className="input" rows={2} value={form.notes} onChange={set('notes')} />
                </Field>

                <div className="form__actions">
                    <button type="button" className="btn btn--ghost" onClick={onClose}>
                        Cancelar
                    </button>
                    <button type="submit" className="btn btn--primary" disabled={saving || !form.product_id}>
                        {saving ? 'Guardando…' : 'Aplicar ajuste'}
                    </button>
                </div>
            </form>
        </Modal>
    );
}
