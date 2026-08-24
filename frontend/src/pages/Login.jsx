import { useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import { Field, Spinner } from '../components/ui.jsx';

export default function Login() {
    const { login, user, loading } = useAuth();
    const navigate = useNavigate();
    const [form, setForm] = useState({ username: '', password: '' });
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);

    if (loading) return <Spinner label="Cargando…" />;
    if (user) return <Navigate to="/" replace />;

    async function onSubmit(e) {
        e.preventDefault();
        setError('');
        setBusy(true);
        try {
            await login(form.username.trim(), form.password);
            navigate('/', { replace: true });
        } catch (err) {
            setError(err.message);
        } finally {
            setBusy(false);
        }
    }

    return (
        <div className="login">
            <form className="login__card" onSubmit={onSubmit}>
                <h1 className="login__title">Distribuidora</h1>
                <p className="login__sub">Sistema de gestión de ventas y créditos</p>

                <Field label="Usuario" required>
                    <input
                        className="input"
                        autoFocus
                        autoComplete="username"
                        value={form.username}
                        onChange={(e) => setForm({ ...form, username: e.target.value })}
                    />
                </Field>

                <Field label="Contraseña" required>
                    <input
                        className="input"
                        type="password"
                        autoComplete="current-password"
                        value={form.password}
                        onChange={(e) => setForm({ ...form, password: e.target.value })}
                    />
                </Field>

                {error && <p className="alert alert--error">{error}</p>}

                <button className="btn btn--primary btn--block" disabled={busy}>
                    {busy ? 'Verificando…' : 'Entrar'}
                </button>
            </form>
        </div>
    );
}
