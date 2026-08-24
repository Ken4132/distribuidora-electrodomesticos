import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { authApi, getToken, setToken } from '../services/api.js';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
    const [user, setUser] = useState(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        if (!getToken()) {
            setLoading(false);
            return;
        }
        authApi
            .me()
            .then((res) => setUser(res.data))
            .catch(() => setToken(''))
            .finally(() => setLoading(false));
    }, []);

    const value = useMemo(
        () => ({
            user,
            loading,
            async login(username, password) {
                const res = await authApi.login(username, password);
                setToken(res.data.token);
                setUser(res.data.user);
                return res.data.user;
            },
            logout() {
                setToken('');
                setUser(null);
            },
        }),
        [user, loading]
    );

    return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
    const ctx = useContext(AuthContext);
    if (!ctx) throw new Error('useAuth debe usarse dentro de <AuthProvider>');
    return ctx;
}
