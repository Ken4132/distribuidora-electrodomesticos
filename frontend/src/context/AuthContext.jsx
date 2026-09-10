import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { authApi, getToken, setToken } from '../services/api.js';

const AuthContext = createContext(null);

/**
 * Sesión del usuario y sus permisos (REQ-0011).
 *
 * Los permisos que llegan aquí sirven ÚNICAMENTE para no mostrar botones y
 * menús que el servidor va a rechazar. La decisión real la toma siempre el
 * backend: ocultar un botón no protege nada por sí solo.
 */
export function AuthProvider({ children }) {
    const [user, setUser] = useState(null);
    const [permissions, setPermissions] = useState([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        if (!getToken()) {
            setLoading(false);
            return;
        }
        authApi
            .me()
            .then((res) => {
                setUser(res.data);
                setPermissions(res.data?.permissions ?? []);
            })
            .catch(() => setToken(''))
            .finally(() => setLoading(false));
    }, []);

    const value = useMemo(() => {
        const owned = new Set(permissions);
        return {
            user,
            loading,
            permissions,
            /** ¿El usuario tiene este permiso? Acepta varios: basta con uno. */
            can: (...codes) => codes.some((c) => owned.has(c)),
            async login(username, password) {
                const res = await authApi.login(username, password);
                setToken(res.data.token);
                setUser(res.data.user);
                setPermissions(res.data.permissions ?? []);
                return res.data.user;
            },
            logout() {
                // Se avisa al servidor para que quede en la bitácora, pero la
                // sesión se cierra igual aunque esa llamada falle.
                authApi.logout().catch(() => {});
                setToken('');
                setUser(null);
                setPermissions([]);
            },
        };
    }, [user, loading, permissions]);

    return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
    const ctx = useContext(AuthContext);
    if (!ctx) throw new Error('useAuth debe usarse dentro de <AuthProvider>');
    return ctx;
}
