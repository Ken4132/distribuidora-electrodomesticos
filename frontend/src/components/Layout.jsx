import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';

/**
 * El menú se arma con los permisos del usuario (RN-0008): cada quien ve
 * únicamente los módulos a los que tiene acceso. Ocultar el enlace es solo
 * comodidad; quien escriba la dirección a mano igual recibe un 403 del
 * servidor, que es donde de verdad se decide.
 */
const LINKS = [
    { to: '/', label: 'Inicio', end: true, permission: 'dashboard.view' },
    { to: '/ventas/nueva', label: 'Nueva venta', highlight: true, permission: 'sales.create' },
    { to: '/clientes', label: 'Clientes', permission: 'customers.view' },
    { to: '/productos', label: 'Productos', permission: 'products.view' },
    { to: '/ventas', label: 'Ventas', permission: 'sales.view' },
    // Cobranza la ven tanto quien consulta la cartera completa como quien
    // solo consulta la suya.
    { to: '/cobranza', label: 'Cobranza', permission: ['receivables.view', 'receivables.view.own'] },
    { to: '/usuarios', label: 'Usuarios', permission: 'users.view' },
    { to: '/bitacora', label: 'Bitácora', permission: 'audit.view' },
    { to: '/integraciones', label: 'Integraciones', permission: 'integrations.manage' },
];

export function Layout() {
    const { user, can, logout } = useAuth();
    const navigate = useNavigate();

    return (
        <div className="app">
            <header className="topbar">
                <div className="topbar__brand">
                    <strong>Distribuidora</strong>
                    <span className="topbar__sub">Sistema de gestión</span>
                </div>
                <nav className="topbar__nav">
                    {LINKS.filter((l) => can(...[].concat(l.permission))).map((l) => (
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
                    <span title={user?.role_name ?? user?.role}>
                        {user?.full_name}
                        {user?.role_name ? <em className="topbar__role"> · {user.role_name}</em> : null}
                    </span>
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
