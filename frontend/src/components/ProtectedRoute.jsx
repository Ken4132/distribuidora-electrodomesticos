import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import { Spinner } from './ui.jsx';

/**
 * Exige sesión y, opcionalmente, un permiso (RN-0008). `permission` admite
 * una cadena o una lista: con una lista basta con tener uno de ellos, que es
 * lo que necesitan las pantallas con alcance global o propio.
 * Si no lo tiene se le devuelve al inicio en lugar de mostrarle una pantalla
 * que va a fallar con 403 en cada petición.
 */
export function ProtectedRoute({ children, permission }) {
    const { user, loading, can } = useAuth();
    const location = useLocation();

    if (loading) return <Spinner label="Verificando sesión…" />;
    if (!user) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
    if (permission && !can(...[].concat(permission))) return <Navigate to="/" replace />;
    return children;
}
