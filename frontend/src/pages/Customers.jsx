import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { customersApi } from '../services/api.js';
import { useDebounce } from '../hooks/useDebounce.js';
import { useToast } from '../context/ToastContext.jsx';
import { Badge, EmptyState, Field, Modal, Pagination, SearchInput, Spinner } from '../components/ui.jsx';
import { formatDate } from '../utils/format.js';

const EMPTY = {
    dpi: '',
    full_name: '',
    phone: '',
    phone_alt: '',
    email: '',
    address: '',
    address_ref: '',
    notes: '',
};

export default function Customers() {
    const toast = useToast();
    const [search, setSearch] = useState('');
    const [status, setStatus] = useState('active');
    const [page, setPage] = useState(1);
    const [state, setState] = useState({ loading: true, rows: [], pagination: null });
    const [modal, setModal] = useState(null); // { mode: 'create'|'edit', data }
    const debounced = useDebounce(search);

    const load = useCallback(async () => {
        setState((s) => ({ ...s, loading: true }));
        try {
            const res = await customersApi.list({ search: debounced, status, page, pageSize: 15 });
            setState({ loading: false, rows: res.data, pagination: res.pagination });
        } catch (e) {
            setState({ loading: false, rows: [], pagination: null });
            toast.error(e.message);
        }
    }, [debounced, status, page, toast]);

    useEffect(() => {
        load();
    }, [load]);
    useEffect(() => {
        setPage(1);
    }, [debounced, status]);

    async function toggleActive(customer) {
        try {
            await customersApi.setActive(customer.id, !customer.is_active);
            toast.success(customer.is_active ? 'Cliente desactivado' : 'Cliente activado');
            load();
        } catch (e) {
            toast.error(e.fullMessage);
        }
    }

    return (
        <div className="page">
            <div className="page__head">
                <div>
                    <h1>Clientes</h1>
                    <p className="page__sub">Busca por nombre, DPI o teléfono</p>
                </div>
                <button className="btn btn--primary" onClick={() => setModal({ mode: 'create', data: EMPTY })}>
                    Nuevo cliente
                </button>
            </div>

            <div className="toolbar">
                <SearchInput value={search} onChange={setSearch} placeholder="Nombre, DPI o teléfono…" />
                <select className="input input--select" value={status} onChange={(e) => setStatus(e.target.value)}>
                    <option value="active">Activos</option>
                    <option value="inactive">Inactivos</option>
                    <option value="all">Todos</option>
                </select>
            </div>

            {state.loading ? (
                <Spinner />
            ) : state.rows.length === 0 ? (
                <EmptyState
                    title="No hay clientes que coincidan"
                    hint={search ? 'Prueba con otro término de búsqueda.' : 'Registra el primer cliente para empezar.'}
                />
            ) : (
                <div className="table-wrap">
                    <table className="table">
                        <thead>
                            <tr>
                                <th>DPI</th>
                                <th>Nombre</th>
                                <th>Teléfono</th>
                                <th>Dirección</th>
                                <th>Alta</th>
                                <th>Estado</th>
                                <th className="right">Acciones</th>
                            </tr>
                        </thead>
                        <tbody>
                            {state.rows.map((c) => (
                                <tr key={c.id}>
                                    <td className="mono">{c.dpi}</td>
                                    <td>
                                        <Link to={`/clientes/${c.id}`} className="link">
                                            {c.full_name}
                                        </Link>
                                    </td>
                                    <td className="mono">{c.phone}</td>
                                    <td className="truncate" title={c.address}>
                                        {c.address}
                                    </td>
                                    <td>{formatDate(c.created_at)}</td>
                                    <td>
                                        <Badge status={c.is_active ? 'pagada' : 'anulada'}>
                                            {c.is_active ? 'Activo' : 'Inactivo'}
                                        </Badge>
                                    </td>
                                    <td className="right nowrap">
                                        <button
                                            className="btn btn--ghost btn--sm"
                                            onClick={() => setModal({ mode: 'edit', data: c })}
                                        >
                                            Editar
                                        </button>
                                        <button className="btn btn--ghost btn--sm" onClick={() => toggleActive(c)}>
                                            {c.is_active ? 'Desactivar' : 'Activar'}
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
                <CustomerModal
                    mode={modal.mode}
                    initial={modal.data}
                    onClose={() => setModal(null)}
                    onSaved={() => {
                        setModal(null);
                        load();
                    }}
                />
            )}
        </div>
    );
}

function CustomerModal({ mode, initial, onClose, onSaved }) {
    const toast = useToast();
    const [form, setForm] = useState({ ...EMPTY, ...initial });
    const [errors, setErrors] = useState({});
    const [busy, setBusy] = useState(false);

    const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

    async function submit(e) {
        e.preventDefault();
        setBusy(true);
        setErrors({});
        try {
            const payload = {
                dpi: form.dpi,
                full_name: form.full_name,
                phone: form.phone,
                phone_alt: form.phone_alt || '',
                email: form.email || '',
                address: form.address,
                address_ref: form.address_ref || '',
                notes: form.notes || '',
            };
            if (mode === 'create') {
                await customersApi.create(payload);
                toast.success('Cliente registrado');
            } else {
                await customersApi.update(initial.id, payload);
                toast.success('Cliente actualizado');
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
        <Modal open title={mode === 'create' ? 'Nuevo cliente' : 'Editar cliente'} onClose={onClose} wide>
            <form onSubmit={submit} className="form-grid">
                <Field label="DPI" required error={errors.dpi} hint="13 dígitos" className="span-1">
                    <input className="input mono" autoFocus inputMode="numeric" maxLength={15} value={form.dpi} onChange={set('dpi')} />
                </Field>
                <Field label="Nombre completo" required error={errors.full_name} className="span-2">
                    <input className="input" value={form.full_name} onChange={set('full_name')} />
                </Field>
                <Field label="Teléfono" required error={errors.phone} hint="8 dígitos" className="span-1">
                    <input className="input mono" inputMode="tel" value={form.phone} onChange={set('phone')} />
                </Field>
                <Field label="Teléfono alterno" error={errors.phone_alt} className="span-1">
                    <input className="input mono" inputMode="tel" value={form.phone_alt ?? ''} onChange={set('phone_alt')} />
                </Field>
                <Field label="Correo electrónico" error={errors.email} className="span-1">
                    <input className="input" type="email" value={form.email ?? ''} onChange={set('email')} />
                </Field>
                <Field label="Dirección" required error={errors.address} className="span-3">
                    <input className="input" value={form.address} onChange={set('address')} />
                </Field>
                <Field label="Punto de referencia" error={errors.address_ref} className="span-3">
                    <input className="input" value={form.address_ref ?? ''} onChange={set('address_ref')} />
                </Field>
                <Field label="Observaciones" error={errors.notes} className="span-3">
                    <textarea className="input" rows={2} value={form.notes ?? ''} onChange={set('notes')} />
                </Field>

                <div className="form-actions span-3">
                    <button type="button" className="btn btn--ghost" onClick={onClose}>
                        Cancelar
                    </button>
                    <button className="btn btn--primary" disabled={busy}>
                        {busy ? 'Guardando…' : 'Guardar cliente'}
                    </button>
                </div>
            </form>
        </Modal>
    );
}
