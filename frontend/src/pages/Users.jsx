import { useCallback, useEffect, useState } from 'react';
import { usersApi, rolesApi } from '../services/api.js';
import { useDebounce } from '../hooks/useDebounce.js';
import { useToast } from '../context/ToastContext.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import { Badge, EmptyState, Field, Modal, Pagination, SearchInput, Spinner } from '../components/ui.jsx';
import { formatDate } from '../utils/format.js';

const EMPTY = { username: '', full_name: '', email: '', phone: '', password: '', role: 'vendedor' };

/**
 * REQ-0010 Gestión de usuarios y REQ-0011 Gestión de roles y permisos.
 *
 * Las cuentas se desactivan, nunca se borran: al desactivar un usuario se
 * conserva su historial de actividades, como pide la tesis.
 */
export default function Users() {
    const toast = useToast();
    const { user: me, can } = useAuth();

    const [search, setSearch] = useState('');
    const [role, setRole] = useState('');
    const [status, setStatus] = useState('all');
    const [page, setPage] = useState(1);
    const [state, setState] = useState({ loading: true, rows: [], pagination: null });
    const [roles, setRoles] = useState([]);
    const [modal, setModal] = useState(null); // { mode, data }
    const debounced = useDebounce(search);

    const manages = can('users.manage');

    const load = useCallback(async () => {
        setState((s) => ({ ...s, loading: true }));
        try {
            const res = await usersApi.list({ search: debounced, role, status, page, pageSize: 15 });
            setState({ loading: false, rows: res.data, pagination: res.pagination });
        } catch (e) {
            setState({ loading: false, rows: [], pagination: null });
            toast.error(e.message);
        }
    }, [debounced, role, status, page, toast]);

    const loadRoles = useCallback(async () => {
        try {
            const res = await rolesApi.list();
            setRoles(res.data);
        } catch {
            /* sin permiso de ver roles: el selector se queda con lo que haya */
        }
    }, []);

    useEffect(() => {
        load();
    }, [load]);
    useEffect(() => {
        loadRoles();
    }, [loadRoles]);
    useEffect(() => {
        setPage(1);
    }, [debounced, role, status]);

    async function toggleActive(u) {
        try {
            await usersApi.setActive(u.id, !u.is_active);
            toast.success(u.is_active ? 'Usuario desactivado' : 'Usuario activado');
            load();
        } catch (e) {
            toast.error(e.fullMessage);
        }
    }

    return (
        <div className="page">
            <div className="page__head">
                <div>
                    <h1>Usuarios</h1>
                    <p className="page__sub">Cuentas de acceso y roles del personal</p>
                </div>
                <div className="nowrap">
                    {can('roles.view') && (
                        <button className="btn btn--ghost" onClick={() => setModal({ mode: 'roles' })}>
                            Roles y permisos
                        </button>
                    )}
                    {manages && (
                        <button className="btn btn--primary" onClick={() => setModal({ mode: 'create', data: EMPTY })}>
                            Nuevo usuario
                        </button>
                    )}
                </div>
            </div>

            <div className="toolbar">
                <SearchInput value={search} onChange={setSearch} placeholder="Usuario, nombre o correo…" />
                <select className="input input--select" value={role} onChange={(e) => setRole(e.target.value)}>
                    <option value="">Todos los roles</option>
                    {roles.map((r) => (
                        <option key={r.role_code} value={r.role_code}>
                            {r.role_name}
                        </option>
                    ))}
                </select>
                <select className="input input--select" value={status} onChange={(e) => setStatus(e.target.value)}>
                    <option value="all">Todos</option>
                    <option value="active">Activos</option>
                    <option value="inactive">Inactivos</option>
                </select>
            </div>

            {state.loading ? (
                <Spinner />
            ) : state.rows.length === 0 ? (
                <EmptyState title="No hay usuarios que coincidan" />
            ) : (
                <div className="table-wrap">
                    <table className="table">
                        <thead>
                            <tr>
                                <th>Usuario</th>
                                <th>Nombre</th>
                                <th>Rol</th>
                                <th>Correo</th>
                                <th>Último ingreso</th>
                                <th>Estado</th>
                                {manages && <th className="right">Acciones</th>}
                            </tr>
                        </thead>
                        <tbody>
                            {state.rows.map((u) => (
                                <tr key={u.id}>
                                    <td className="mono">{u.username}</td>
                                    <td>
                                        {u.full_name}
                                        {u.id === me?.id && <span className="muted"> (tú)</span>}
                                    </td>
                                    <td>{u.role_name ?? u.role}</td>
                                    <td className="truncate">{u.email ?? '—'}</td>
                                    <td>{u.last_login_at ? formatDate(u.last_login_at) : 'nunca'}</td>
                                    <td>
                                        <Badge status={u.is_active ? 'pagada' : 'anulada'}>
                                            {u.is_active ? 'Activo' : 'Inactivo'}
                                        </Badge>
                                    </td>
                                    {manages && (
                                        <td className="right nowrap">
                                            <button
                                                className="btn btn--ghost btn--sm"
                                                onClick={() => setModal({ mode: 'edit', data: u })}
                                            >
                                                Editar
                                            </button>
                                            <button
                                                className="btn btn--ghost btn--sm"
                                                onClick={() => setModal({ mode: 'password', data: u })}
                                            >
                                                Contraseña
                                            </button>
                                            <button
                                                className="btn btn--ghost btn--sm"
                                                disabled={u.id === me?.id}
                                                title={u.id === me?.id ? 'No puedes desactivar tu propia cuenta' : ''}
                                                onClick={() => toggleActive(u)}
                                            >
                                                {u.is_active ? 'Desactivar' : 'Activar'}
                                            </button>
                                        </td>
                                    )}
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}

            <Pagination pagination={state.pagination} onChange={setPage} />

            <Modal
                open={modal?.mode === 'create' || modal?.mode === 'edit'}
                title={modal?.mode === 'edit' ? 'Editar usuario' : 'Nuevo usuario'}
                onClose={() => setModal(null)}
            >
                <UserForm
                    mode={modal?.mode}
                    initial={modal?.data ?? EMPTY}
                    roles={roles}
                    onDone={() => {
                        setModal(null);
                        load();
                    }}
                />
            </Modal>

            <Modal
                open={modal?.mode === 'password'}
                title={`Restablecer contraseña de ${modal?.data?.username ?? ''}`}
                onClose={() => setModal(null)}
            >
                <PasswordForm user={modal?.data} onDone={() => setModal(null)} />
            </Modal>

            <Modal
                open={modal?.mode === 'roles'}
                title="Roles y permisos"
                wide
                onClose={() => setModal(null)}
            >
                <RolesPanel
                    onChanged={() => {
                        loadRoles();
                        load();
                    }}
                />
            </Modal>
        </div>
    );
}

function UserForm({ mode, initial, roles, onDone }) {
    const toast = useToast();
    const [form, setForm] = useState({ ...EMPTY, ...initial, password: '' });
    const [errors, setErrors] = useState({});
    const [saving, setSaving] = useState(false);
    const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

    async function submit(e) {
        e.preventDefault();
        setSaving(true);
        setErrors({});
        try {
            if (mode === 'edit') {
                await usersApi.update(initial.id, {
                    full_name: form.full_name,
                    email: form.email || '',
                    phone: form.phone || '',
                    role: form.role,
                });
                toast.success('Usuario actualizado');
            } else {
                await usersApi.create({
                    username: form.username,
                    full_name: form.full_name,
                    email: form.email || '',
                    phone: form.phone || '',
                    password: form.password,
                    role: form.role,
                });
                toast.success('Usuario creado');
            }
            onDone();
        } catch (err) {
            setErrors(err.fieldErrors ?? {});
            toast.error(err.fullMessage);
        } finally {
            setSaving(false);
        }
    }

    return (
        <form className="form-grid" onSubmit={submit}>
            {mode !== 'edit' && (
                <Field label="Usuario" required error={errors.username} className="span-1">
                    <input className="input" value={form.username} onChange={set('username')} autoFocus />
                </Field>
            )}
            <Field label="Nombre completo" required error={errors.full_name} className="span-1">
                <input className="input" value={form.full_name} onChange={set('full_name')} />
            </Field>
            <Field label="Correo" error={errors.email} className="span-1">
                <input className="input" type="email" value={form.email ?? ''} onChange={set('email')} />
            </Field>
            <Field label="Teléfono" error={errors.phone} className="span-1">
                <input className="input" value={form.phone ?? ''} onChange={set('phone')} />
            </Field>
            <Field label="Rol" required error={errors.role} className="span-1">
                <select className="input input--select" value={form.role} onChange={set('role')}>
                    {roles.length === 0 && <option value={form.role}>{form.role}</option>}
                    {roles
                        .filter((r) => r.is_active)
                        .map((r) => (
                            <option key={r.role_code} value={r.role_code}>
                                {r.role_name}
                            </option>
                        ))}
                </select>
            </Field>
            {mode !== 'edit' && (
                <Field
                    label="Contraseña"
                    required
                    error={errors.password}
                    hint="Mínimo 8 caracteres, con al menos una letra y un número"
                    className="span-1"
                >
                    <input className="input" type="password" value={form.password} onChange={set('password')} />
                </Field>
            )}
            <div className="form-actions span-2">
                <button className="btn btn--primary" disabled={saving}>
                    {saving ? 'Guardando…' : mode === 'edit' ? 'Guardar cambios' : 'Crear usuario'}
                </button>
            </div>
        </form>
    );
}

function PasswordForm({ user, onDone }) {
    const toast = useToast();
    const [password, setPassword] = useState('');
    const [errors, setErrors] = useState({});
    const [saving, setSaving] = useState(false);

    async function submit(e) {
        e.preventDefault();
        setSaving(true);
        setErrors({});
        try {
            await usersApi.resetPassword(user.id, password);
            toast.success(`Contraseña de ${user.username} restablecida`);
            onDone();
        } catch (err) {
            setErrors(err.fieldErrors ?? {});
            toast.error(err.fullMessage);
        } finally {
            setSaving(false);
        }
    }

    return (
        <form className="form-grid" onSubmit={submit}>
            <Field
                label="Nueva contraseña"
                required
                error={errors.password}
                hint="Mínimo 8 caracteres, con al menos una letra y un número"
                className="span-2"
            >
                <input
                    className="input"
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    autoFocus
                />
            </Field>
            <div className="form-actions span-2">
                <button className="btn btn--primary" disabled={saving}>
                    {saving ? 'Guardando…' : 'Restablecer'}
                </button>
            </div>
        </form>
    );
}

/** Matriz de permisos por rol (REQ-0011). */
function RolesPanel({ onChanged }) {
    const toast = useToast();
    const { can } = useAuth();
    const [roles, setRoles] = useState([]);
    const [catalog, setCatalog] = useState([]);
    const [selected, setSelected] = useState('');
    const [checked, setChecked] = useState(new Set());
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);

    const editable = can('roles.manage');

    useEffect(() => {
        Promise.all([rolesApi.list(), rolesApi.permissions()])
            .then(([r, p]) => {
                setRoles(r.data);
                setCatalog(p.data);
                const first = r.data[0]?.role_code ?? '';
                setSelected(first);
                setChecked(new Set(r.data[0]?.permissions ?? []));
            })
            .catch((e) => toast.error(e.message))
            .finally(() => setLoading(false));
    }, [toast]);

    function selectRole(code) {
        setSelected(code);
        setChecked(new Set(roles.find((r) => r.role_code === code)?.permissions ?? []));
    }

    function toggle(code) {
        setChecked((prev) => {
            const next = new Set(prev);
            if (next.has(code)) next.delete(code);
            else next.add(code);
            return next;
        });
    }

    async function save() {
        setSaving(true);
        try {
            const res = await rolesApi.setPermissions(selected, [...checked]);
            toast.success(res.message);
            const refreshed = await rolesApi.list();
            setRoles(refreshed.data);
            onChanged?.();
        } catch (e) {
            toast.error(e.fullMessage);
        } finally {
            setSaving(false);
        }
    }

    if (loading) return <Spinner />;

    const modules = [...new Set(catalog.map((p) => p.module))];
    const current = roles.find((r) => r.role_code === selected);

    return (
        <div>
            <div className="toolbar">
                <select className="input input--select" value={selected} onChange={(e) => selectRole(e.target.value)}>
                    {roles.map((r) => (
                        <option key={r.role_code} value={r.role_code}>
                            {r.role_name} · {r.users_count} usuario(s)
                        </option>
                    ))}
                </select>
                {editable && (
                    <button className="btn btn--primary" onClick={save} disabled={saving}>
                        {saving ? 'Guardando…' : 'Guardar permisos'}
                    </button>
                )}
            </div>

            {current?.description && <p className="page__sub">{current.description}</p>}
            {selected === 'admin' && (
                <p className="alert">
                    El rol de administrador no puede quedarse sin los permisos de administración de usuarios,
                    roles y bitácora: el sistema quedaría sin nadie que pueda arreglarlo.
                </p>
            )}

            {modules.map((mod) => (
                <div key={mod} className="perm-group">
                    <h3 className="perm-group__title">{mod}</h3>
                    <div className="perm-group__items">
                        {catalog
                            .filter((p) => p.module === mod)
                            .map((p) => (
                                <label key={p.code} className="perm-item" title={p.description ?? ''}>
                                    <input
                                        type="checkbox"
                                        checked={checked.has(p.code)}
                                        disabled={!editable}
                                        onChange={() => toggle(p.code)}
                                    />
                                    <span>{p.name}</span>
                                    <code className="perm-item__code">{p.code}</code>
                                </label>
                            ))}
                    </div>
                </div>
            ))}
        </div>
    );
}
