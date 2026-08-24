import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';

const LINKS = [
    { to: '/', label: 'Inicio', end: true },
    { to: '/ventas/nueva', label: 'Nueva venta', highlight: true },
    { to: '/clientes', label: 'Clientes' },
    { to: '/productos', label: 'Productos' },
    { to: '/ventas', label: 'Ventas' },
    { to: '/cobranza', label: 'Cobranza' },
    { to: '/integraciones', label: 'Integraciones', adminOnly: true },
];

export function Layout() {
    const { user, logout } = useAuth();
    const navigate = useNavigate();

    return (
        <div className="app">
            <header className="topbar">
                <div className="topbar__brand">
                    <strong>Distribuidora</strong>
                    <span className="topbar__sub">Sistema de gestión</span>
                </div>
                <nav className="topbar__nav">
                    {LINKS.filter((l) => !l.adminOnly || user?.role === 'admin').map((l) => (
                        <NavLink
                            key={l.to}
                            to={l.to}
                            end={l.end}
                            className={({ isActive }) =>
                                `navlink ${isActive ? 'navlink--active' : ''} ${l.highlight ? 'navlink--cta' : ''}`
                            }
                        >
                            {l.label}
                        </NavLink>
                    ))}
                </nav>
                <div className="topbar__user">
                    <span title={user?.role}>{user?.full_name}</span>
                    <button
                        className="btn btn--ghost btn--sm"
                        onClick={() => {
                            logout();
                            navigate('/login');
                        }}
                    >
                        Salir
                    </button>
                </div>
            </header>
            <main className="content">
                <Outlet />
            </main>
        </div>
    );
}
