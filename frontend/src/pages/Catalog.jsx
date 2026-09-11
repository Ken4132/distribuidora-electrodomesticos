import { useCallback, useEffect, useState } from 'react';
import { categoriesApi, brandsApi, catalogApi } from '../services/api.js';
import { useToast } from '../context/ToastContext.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import { Badge, EmptyState, Field, Modal, SearchInput, Spinner } from '../components/ui.jsx';

/**
 * Categorías y marcas.
 *
 * Lo que resuelve esta pantalla es la navegación CATEGORÍA → MARCA →
 * PRODUCTOS y, sobre todo, que la misma categoría no aparezca tres veces
 * por haberse escrito "Cama", "CAMA" y "cama". El nombre se guarda
 * normalizado y la base rechaza el duplicado.
 */
const TABS = [
    { key: 'categories', label: 'Categorías', api: categoriesApi, permission: 'categories.manage', singular: 'categoría' },
    { key: 'brands', label: 'Marcas', api: brandsApi, permission: 'brands.manage', singular: 'marca' },
    { key: 'tree', label: 'Árbol del catálogo', api: null, permission: null, singular: null },
];

export default function Catalog() {
    const [tab, setTab] = useState('categories');
    const active = TABS.find((t) => t.key === tab);

    return (
        <div className="page">
            <div className="page__head">
                <div>
                    <h1>Catálogo</h1>
                    <p className="page__sub">Categorías y marcas, sin duplicados por mayúsculas ni tildes</p>
                </div>
            </div>

            <div className="tabs">
                {TABS.map((t) => (
                    <button
                        key={t.key}
                        className={`tab ${tab === t.key ? 'tab--active' : ''}`}
                        onClick={() => setTab(t.key)}
                    >
                        {t.label}
                    </button>
                ))}
            </div>

            {tab === 'tree' ? <CatalogTree /> : <TaxonomyList key={active.key} config={active} />}
        </div>
    );
}

function TaxonomyList({ config }) {
    const toast = useToast();
    const { can } = useAuth();
    const puedeAdministrar = can(config.permission);

    const [search, setSearch] = useState('');
    const [status, setStatus] = useState('all');
    const [state, setState] = useState({ loading: true, rows: [] });
    const [modal, setModal] = useState(null);

    const load = useCallback(async () => {
        setState((s) => ({ ...s, loading: true }));
        try {
            const res = await config.api.list({ search, status });
            setState({ loading: false, rows: res.data });
        } catch (e) {
            setState({ loading: false, rows: [] });
            toast.error(e.message);
        }
    }, [config, search, status, toast]);

    useEffect(() => {
        load();
    }, [load]);

    async function toggleActive(row) {
        try {
            const res = await config.api.setActive(row.id, !row.is_active);
            toast.success(res.message);
            load();
        } catch (e) {
            toast.error(e.fullMessage);
        }
    }

    return (
        <>
            <div className="toolbar">
                <SearchInput value={search} onChange={setSearch} placeholder="Nombre…" />
                <select className="input" value={status} onChange={(e) => setStatus(e.target.value)}>
                    <option value="all">Todas</option>
                    <option value="active">Activas</option>
                    <option value="inactive">Inactivas</option>
                </select>
                {puedeAdministrar ? (
                    <button
                        className="btn btn--primary"
                        onClick={() => setModal({ mode: 'create', data: { name: '', description: '' } })}
                    >
                        Nueva {config.singular}
                    </button>
                ) : null}
            </div>

            {state.loading ? (
                <Spinner />
            ) : state.rows.length === 0 ? (
                <EmptyState title={`No hay ${config.label.toLowerCase()} que coincidan`} />
            ) : (
                <div className="table-wrap">
                    <table className="table">
                        <thead>
                            <tr>
                                <th>Nombre</th>
                                <th className="num">Productos</th>
                                <th className="num">Activos</th>
                                <th>Estado</th>
                                <th />
                            </tr>
                        </thead>
                        <tbody>
                            {state.rows.map((row) => (
                                <tr key={row.id}>
                                    <td>
                                        <strong>{row.name}</strong>
                                        {row.description ? <div className="muted small">{row.description}</div> : null}
                                    </td>
                                    <td className="num">{row.products}</td>
                                    <td className="num">{row.active_products}</td>
                                    <td>
                                        <Badge status={row.is_active ? 'activa' : 'anulada'}>
                                            {row.is_active ? 'Activa' : 'Inactiva'}
                                        </Badge>
                                    </td>
                                    <td className="row-actions">
                                        {puedeAdministrar ? (
                                            <>
                                                <button
                                                    className="btn btn--ghost btn--sm"
                                                    onClick={() => setModal({ mode: 'edit', data: row })}
                                                >
                                                    Editar
                                                </button>
                                                <button
                                                    className="btn btn--ghost btn--sm"
                                                    onClick={() => toggleActive(row)}
                                                >
                                                    {row.is_active ? 'Desactivar' : 'Activar'}
                                                </button>
                                            </>
                                        ) : null}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}

            {modal ? (
                <TaxonomyForm
                    config={config}
                    modal={modal}
                    onClose={() => setModal(null)}
                    onSaved={() => {
                        setModal(null);
                        load();
                    }}
                />
            ) : null}
        </>
    );
}

function TaxonomyForm({ config, modal, onClose, onSaved }) {
    const toast = useToast();
    const [form, setForm] = useState({ name: '', description: '', ...modal.data });
    const [errors, setErrors] = useState({});
    const [saving, setSaving] = useState(false);

    const set = (field) => (e) => setForm((f) => ({ ...f, [field]: e.target.value }));

    async function submit(e) {
        e.preventDefault();
        setSaving(true);
        setErrors({});
        try {
            const payload = { name: form.name, description: form.description || null };
            if (modal.mode === 'create') await config.api.create(payload);
            else await config.api.update(modal.data.id, payload);
            toast.success('Guardado');
            onSaved();
        } catch (err) {
            setErrors(err.fieldErrors);
            toast.error(err.fullMessage);
        } finally {
            setSaving(false);
        }
    }

    return (
        <Modal
            open
            title={`${modal.mode === 'create' ? 'Nueva' : 'Editar'} ${config.singular}`}
            onClose={onClose}
        >
            <form onSubmit={submit} className="form">
                <Field
                    label="Nombre"
                    required
                    error={errors.name}
                    hint="Se guarda en MAYÚSCULAS y sin tildes. No se admiten duplicados que solo cambien el formato."
                >
                    <input className="input" value={form.name} onChange={set('name')} maxLength={80} required />
                </Field>
                <Field label="Descripción" error={errors.description}>
                    <textarea
                        className="input"
                        rows={2}
                        value={form.description ?? ''}
                        onChange={set('description')}
                    />
                </Field>
                <div className="form__actions">
                    <button type="button" className="btn btn--ghost" onClick={onClose}>
                        Cancelar
                    </button>
                    <button type="submit" className="btn btn--primary" disabled={saving}>
                        {saving ? 'Guardando…' : 'Guardar'}
                    </button>
                </div>
            </form>
        </Modal>
    );
}

function CatalogTree() {
    const toast = useToast();
    const [state, setState] = useState({ loading: true, rows: [] });

    useEffect(() => {
        catalogApi
            .tree()
            .then((res) => setState({ loading: false, rows: res.data }))
            .catch((e) => {
                setState({ loading: false, rows: [] });
                toast.error(e.message);
            });
    }, [toast]);

    if (state.loading) return <Spinner />;
    if (state.rows.length === 0) {
        return <EmptyState title="Todavía no hay productos clasificados" />;
    }

    return (
        <div className="tree">
            {state.rows.map((cat) => (
                <details key={cat.id} className="tree__node" open>
                    <summary>
                        <strong>{cat.name}</strong> <span className="muted">· {cat.products} producto(s)</span>
                    </summary>
                    <ul>
                        {cat.brands.map((b) => (
                            <li key={`${cat.id}-${b.id ?? 'none'}`}>
                                {b.name} <span className="muted">· {b.products} producto(s)</span>
                            </li>
                        ))}
                    </ul>
                </details>
            ))}
        </div>
    );
}
