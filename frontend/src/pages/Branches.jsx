import { useCallback, useEffect, useState } from 'react';
import { branchesApi } from '../services/api.js';
import { useToast } from '../context/ToastContext.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import { Badge, EmptyState, Field, Modal, SearchInput, Spinner } from '../components/ui.jsx';

const EMPTY = { code: '', name: '', address: '', phone: '', notes: '' };

/**
 * Administración de sucursales.
 *
 * La sucursal PREDETERMINADA no es una etiqueta decorativa: es la que
 * recibe toda operación que no declara sucursal, que hoy son todas las
 * ventas. Por eso se explica en pantalla y el cambio pide confirmación.
 */
export default function Branches() {
    const toast = useToast();
    const { can } = useAuth();
    const puedeAdministrar = can('branches.manage');

    const [search, setSearch] = useState('');
    const [status, setStatus] = useState('all');
    const [state, setState] = useState({ loading: true, rows: [] });
    const [modal, setModal] = useState(null);

    const load = useCallback(async () => {
        setState((s) => ({ ...s, loading: true }));
        try {
            const res = await branchesApi.list({ search, status });
            setState({ loading: false, rows: res.data });
        } catch (e) {
            setState({ loading: false, rows: [] });
            toast.error(e.message);
        }
    }, [search, status, toast]);

    useEffect(() => {
        load();
    }, [load]);

    async function toggleActive(branch) {
        try {
            await branchesApi.setActive(branch.id, !branch.is_active);
            toast.success(branch.is_active ? 'Sucursal desactivada' : 'Sucursal activada');
            load();
        } catch (e) {
            toast.error(e.fullMessage);
        }
    }

    async function makeDefault(branch) {
        const ok = window.confirm(
            `¿Establecer "${branch.name}" como sucursal predeterminada?\n\n` +
                'A partir de ese momento, toda venta y todo ajuste que no declare sucursal ' +
                'descontarán del inventario de esta sucursal.'
        );
        if (!ok) return;
        try {
            const res = await branchesApi.makeDefault(branch.id);
            toast.success(res.message);
            load();
        } catch (e) {
            toast.error(e.fullMessage);
        }
    }

    return (
        <div className="page">
            <div className="page__head">
                <div>
                    <h1>Sucursales</h1>
                    <p className="page__sub">
                        El inventario, los usuarios y cada movimiento de existencias cuelgan de una sucursal
                    </p>
                </div>
                {puedeAdministrar ? (
                    <button className="btn btn--primary" onClick={() => setModal({ mode: 'create', data: EMPTY })}>
                        Nueva sucursal
                    </button>
                ) : null}
            </div>

            <div className="toolbar">
                <SearchInput value={search} onChange={setSearch} placeholder="Nombre o código…" />
                <select className="input" value={status} onChange={(e) => setStatus(e.target.value)}>
                    <option value="all">Todas</option>
                    <option value="active">Activas</option>
                    <option value="inactive">Inactivas</option>
                </select>
            </div>

            {state.loading ? (
                <Spinner />
            ) : state.rows.length === 0 ? (
                <EmptyState title="No hay sucursales que coincidan" />
            ) : (
                <div className="table-wrap">
                    <table className="table">
                        <thead>
                            <tr>
                                <th>Código</th>
                                <th>Nombre</th>
                                <th>Teléfono</th>
                                <th className="num">Usuarios</th>
                                <th className="num">Unidades</th>
                                <th>Estado</th>
                                <th />
                            </tr>
                        </thead>
                        <tbody>
                            {state.rows.map((b) => (
                                <tr key={b.id}>
                                    <td>
                                        <strong>{b.code}</strong>
                                    </td>
                                    <td>
                                        {b.name}
                                        {b.is_default ? (
                                            <span
                                                className="badge badge--info"
                                                title="Recibe las operaciones que no declaran sucursal"
                                                style={{ marginLeft: 8 }}
                                            >
                                                Predeterminada
                                            </span>
                                        ) : null}
                                        {b.address ? <div className="muted small">{b.address}</div> : null}
                                    </td>
                                    <td>{b.phone ?? '—'}</td>
                                    <td className="num">{b.users}</td>
                                    <td className="num">{b.stock_units}</td>
                                    <td>
                                        <Badge status={b.is_active ? 'activa' : 'anulada'}>
                                            {b.is_active ? 'Activa' : 'Inactiva'}
                                        </Badge>
                                    </td>
                                    <td className="row-actions">
                                        {puedeAdministrar ? (
                                            <>
                                                <button
                                                    className="btn btn--ghost btn--sm"
                                                    onClick={() => setModal({ mode: 'edit', data: b })}
                                                >
                                                    Editar
                                                </button>
                                                {!b.is_default && b.is_active ? (
                                                    <button
                                                        className="btn btn--ghost btn--sm"
                                                        onClick={() => makeDefault(b)}
                                                    >
                                                        Hacer predeterminada
                                                    </button>
                                                ) : null}
                                                {!b.is_default ? (
                                                    <button
                                                        className="btn btn--ghost btn--sm"
                                                        onClick={() => toggleActive(b)}
                                                    >
                                                        {b.is_active ? 'Desactivar' : 'Activar'}
                                                    </button>
                                                ) : null}
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
                <BranchForm
                    modal={modal}
                    onClose={() => setModal(null)}
                    onSaved={() => {
                        setModal(null);
                        load();
                    }}
                />
            ) : null}
        </div>
    );
}

function BranchForm({ modal, onClose, onSaved }) {
    const toast = useToast();
    const [form, setForm] = useState({ ...EMPTY, ...modal.data });
    const [errors, setErrors] = useState({});
    const [saving, setSaving] = useState(false);

    const set = (field) => (e) => setForm((f) => ({ ...f, [field]: e.target.value }));

    async function submit(e) {
        e.preventDefault();
        setSaving(true);
        setErrors({});
        try {
            const payload = {
                code: form.code,
                name: form.name,
                address: form.address || null,
                phone: form.phone || null,
                notes: form.notes || null,
            };
            if (modal.mode === 'create') await branchesApi.create(payload);
            else await branchesApi.update(modal.data.id, payload);
            toast.success(modal.mode === 'create' ? 'Sucursal registrada' : 'Sucursal actualizada');
            onSaved();
        } catch (err) {
            setErrors(err.fieldErrors);
            toast.error(err.fullMessage);
        } finally {
            setSaving(false);
        }
    }

    return (
        <Modal open title={modal.mode === 'create' ? 'Nueva sucursal' : 'Editar sucursal'} onClose={onClose}>
            <form onSubmit={submit} className="form">
                <div className="form__row">
                    <Field label="Código" required error={errors.code} hint="Corto y en mayúsculas, p. ej. CENTRAL">
                        <input className="input" value={form.code} onChange={set('code')} maxLength={20} required />
                    </Field>
                    <Field label="Teléfono" error={errors.phone}>
                        <input className="input" value={form.phone ?? ''} onChange={set('phone')} />
                    </Field>
                </div>
                <Field
                    label="Nombre"
                    required
                    error={errors.name}
                    hint="Se guarda en MAYÚSCULAS y sin tildes, igual que el resto de los datos de negocio"
                >
                    <input className="input" value={form.name} onChange={set('name')} maxLength={120} required />
                </Field>
                <Field label="Dirección" error={errors.address}>
                    <input className="input" value={form.address ?? ''} onChange={set('address')} />
                </Field>
                <Field label="Observaciones" error={errors.notes}>
                    <textarea className="input" rows={2} value={form.notes ?? ''} onChange={set('notes')} />
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
