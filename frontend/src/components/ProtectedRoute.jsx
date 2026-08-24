import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import { Spinner } from './ui.jsx';

export function ProtectedRoute({ children }) {
    const { user, loading } = useAuth();
    const location = useLocation();

    if (loading) return <Spinner label="Verificando sesión…" />;
    if (!user) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
    return children;
}
