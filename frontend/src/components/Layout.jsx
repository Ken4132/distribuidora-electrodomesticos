import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';

/**
 * Estructura de la aplicación: barra lateral fija + área de trabajo.
 *
 * El menú se arma con los permisos del usuario (RN-0008): cada quien ve
 * únicamente los módulos a los que tiene acceso. Ocultar el enlace es solo
 * comodidad; quien escriba la dirección a mano igual recibe un 403 del
 * servidor, que es donde de verdad se decide.
 *
 * Los enlaces van agrupados por bloque de trabajo —operación, cartera,
 * catálogo, administración— porque durante la jornada no se salta entre
 * todos: se trabaja dentro de uno.
 */
const GROUPS = [
    {
        title: null,
        links: [
            { to: '/ventas/nueva', label: 'Registrar venta', highlight: true, permission: 'sales.create' },
            { to: '/', label: 'Inicio', end: true, permission: 'dashboard.view' },
        ],
    },
    {
        title: 'Operación',
        links: [
            { to: '/clientes', label: 'Clientes', permission: 'customers.view' },
            { to: '/ventas', label: 'Ventas', permission: 'sales.view' },
            {
                to: '/creditos',
                label: 'Solicitudes de crédito',
                permission: ['credits.view', 'credits.view.own', 'credits.view.branch'],
            },
        ],
    },
    {
        title: 'Cartera',
        links: [
            // Cobranza la ven tanto quien consulta la cartera completa como
            // quien solo consulta la suya.
            { to: '/cartera', label: 'Cartera y mora', permission: ['receivables.view', 'receivables.view.own'] },
            { to: '/cobranza', label: 'Cobranza', permission: ['receivables.view', 'receivables.view.own'] },
        ],
    },
    {
        title: 'Catálogo',
        links: [
            { to: '/productos', label: 'Productos', permission: 'products.view' },
            { to: '/catalogo', label: 'Categorías y marcas', permission: 'products.view' },
            // Inventario admite los dos alcances: el global y el propio.
            { to: '/inventario', label: 'Inventario', permission: ['inventory.view', 'inventory.view.own'] },
        ],
    },
    {
        title: 'Administración',
        links: [
            { to: '/sucursales', label: 'Sucursales', permission: 'branches.view' },
            { to: '/usuarios', label: 'Usuarios', permission: 'users.view' },
            { to: '/bitacora', label: 'Bitácora', permission: 'audit.view' },
            { to: '/integraciones', label: 'Integraciones', permission: 'integrations.manage' },
        ],
    },
];

/** Iniciales para el indicador de sesión. */
function initials(name = '') {
    const parts = String(name).trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return '··';
    return (parts[0][0] + (parts[1]?.[0] ?? '')).toUpperCase();
}

export function Layout() {
    const { user, can, logout } = useAuth();
    const navigate = useNavigate();

    const groups = GROUPS.map((g) => ({
        ...g,
        links: g.links.filter((l) => can(...[].concat(l.permission))),
    })).filter((g) => g.links.length > 0);

    return (
        <div className="app">
            <aside className="sidebar">
                <div className="sidebar__brand">
                    <span className="sidebar__mark" aria-hidden="true">
                        DE
                    </span>
                    <span className="sidebar__name">
                        Distribuidora
                        <span className="sidebar__tag">Sistema de gestión</span>
                    </span>
                </div>

                <nav className="sidebar__nav">
                    {groups.map((g) => (
                        <div key={g.title ?? 'principal'}>
                            {g.title && <div className="sidebar__section">{g.title}</div>}
                            {g.links.map((l) => (
                                <NavLink
                                    key={l.to}
                                    to={l.to}
                                    end={l.end}
                                    className={({ isActive }) =>
                                        `navlink ${isActive ? 'navlink--active' : ''} ${
                                            l.highlight ? 'navlink--cta' : ''
                                        }`
                                    }
                                >
                                    {l.label}
                                </NavLink>
                            ))}
                        </div>
                    ))}
                </nav>

                <div className="sidebar__foot">{user?.branch_name ?? 'Electrodomésticos'}</div>
            </aside>

            <div className="main">
                <header className="topbar">
                    <span className="topbar__context">
                        {user?.branch_name ? `Sucursal ${user.branch_name}` : 'Operación general'}
                    </span>
                    <div className="topbar__user">
                        <span className="avatar" aria-hidden="true">
                            {initials(user?.full_name)}
                        </span>
                        <span className="topbar__who">
                            <span>{user?.full_name}</span>
                            {user?.role_name && <em className="topbar__role">{user.role_name}</em>}
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
        </div>
    );
}
