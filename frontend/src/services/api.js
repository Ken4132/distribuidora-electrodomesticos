/**
 * Cliente HTTP de la aplicación.
 * Centraliza el token, el manejo de errores y el formato de respuesta
 * ({ ok, data, pagination, error }) que devuelve el backend.
 */
const BASE = (import.meta.env.VITE_API_URL || '') + '/api';
const TOKEN_KEY = 'distribuidora.token';

export function getToken() {
    return localStorage.getItem(TOKEN_KEY) || '';
}
export function setToken(token) {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
}

export class ApiError extends Error {
    constructor(message, { status, code, details } = {}) {
        super(message);
        this.status = status;
        this.code = code;
        this.details = details;
    }
    /** Mensaje listo para mostrar, incluyendo los errores campo por campo. */
    get fullMessage() {
        if (!this.details?.length) return this.message;
        return `${this.message}: ${this.details.map(describeDetail).join('; ')}`;
    }
    /** { campo: mensaje } para pintar el error debajo de cada input. */
    get fieldErrors() {
        if (!Array.isArray(this.details)) return {};
        return Object.fromEntries(this.details.filter((d) => d?.campo).map((d) => [d.campo, d.mensaje]));
    }
}

/** Detalle de error: campo inválido o faltante de existencia por producto. */
function describeDetail(d) {
    if (d?.campo) return `${d.campo} — ${d.mensaje}`;
    if (d?.producto && d.disponible != null) return `${d.producto}: disponible ${d.disponible}, requerido ${d.requerido}`;
    if (d?.producto) return d.producto;
    return typeof d === 'string' ? d : JSON.stringify(d);
}

async function request(method, path, body, extraHeaders = {}) {
    let response;
    try {
        response = await fetch(BASE + path, {
            method,
            headers: {
                'Content-Type': 'application/json',
                ...(getToken() ? { Authorization: `Bearer ${getToken()}` } : {}),
                ...extraHeaders,
            },
            ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        });
    } catch {
        throw new ApiError('No se pudo conectar con el servidor. ¿Está encendido el backend?', { status: 0 });
    }

    let payload = null;
    try {
        payload = await response.json();
    } catch {
        /* sin cuerpo */
    }

    if (!response.ok) {
        if (response.status === 401) setToken('');
        const err = payload?.error ?? {};
        throw new ApiError(err.message || `Error ${response.status}`, {
            status: response.status,
            code: err.code,
            details: err.details,
        });
    }
    return payload;
}

const qs = (params = {}) => {
    const search = new URLSearchParams();
    Object.entries(params).forEach(([k, v]) => {
        if (v !== undefined && v !== null && v !== '') search.append(k, v);
    });
    const s = search.toString();
    return s ? `?${s}` : '';
};

export const api = {
    get: (path, params) => request('GET', path + qs(params)),
    post: (path, body, headers) => request('POST', path, body, headers),
    put: (path, body) => request('PUT', path, body),
    patch: (path, body) => request('PATCH', path, body),
    del: (path, body) => request('DELETE', path, body),
};

// --------------------------------------------------------------- Endpoints
export const authApi = {
    login: (username, password) => api.post('/auth/login', { username, password }),
    me: () => api.get('/auth/me'),
    logout: () => api.post('/auth/logout'),
    changeOwnPassword: (current_password, password) =>
        api.post('/users/me/password', { current_password, password }),
};

export const usersApi = {
    list: (params) => api.get('/users', params),
    get: (id) => api.get(`/users/${id}`),
    create: (data) => api.post('/users', data),
    update: (id, data) => api.put(`/users/${id}`, data),
    setActive: (id, isActive) => api.patch(`/users/${id}/status`, { is_active: isActive }),
    resetPassword: (id, password) => api.post(`/users/${id}/password`, { password }),
    assignBranch: (id, branchId) => api.patch(`/users/${id}/branch`, { branch_id: branchId }),
    // Permisos adicionales por usuario (012)
    permissions: (id) => api.get(`/users/${id}/permissions`),
    permissionCatalog: () => api.get('/users/catalog/permissions'),
    setPermission: (id, data) => api.put(`/users/${id}/permissions`, data),
    clearPermission: (id, data) => api.del(`/users/${id}/permissions`, data),
};

export const branchesApi = {
    list: (params) => api.get('/branches', params),
    get: (id) => api.get(`/branches/${id}`),
    create: (data) => api.post('/branches', data),
    update: (id, data) => api.put(`/branches/${id}`, data),
    setActive: (id, isActive) => api.patch(`/branches/${id}/status`, { is_active: isActive }),
    makeDefault: (id) => api.patch(`/branches/${id}/default`),
};

export const inventoryApi = {
    list: (params) => api.get('/inventory', params),
    summary: () => api.get('/inventory/summary'),
    mismatches: () => api.get('/inventory/mismatches'),
    adjust: (data) => api.post('/inventory/adjust', data),
    setMinStock: (data) => api.put('/inventory/min-stock', data),
};

/** Categorías y marcas comparten forma, así que comparten cliente. */
const taxonomyApi = (base) => ({
    list: (params) => api.get(`/${base}`, params),
    get: (id) => api.get(`/${base}/${id}`),
    create: (data) => api.post(`/${base}`, data),
    update: (id, data) => api.put(`/${base}/${id}`, data),
    setActive: (id, isActive) => api.patch(`/${base}/${id}/status`, { is_active: isActive }),
});

export const categoriesApi = taxonomyApi('categories');
export const brandsApi = taxonomyApi('brands');
export const catalogApi = { tree: () => api.get('/catalog/tree') };

export const rolesApi = {
    list: () => api.get('/roles'),
    permissions: () => api.get('/roles/permissions'),
    get: (code) => api.get(`/roles/${code}`),
    create: (data) => api.post('/roles', data),
    update: (code, data) => api.put(`/roles/${code}`, data),
    setPermissions: (code, permissions) => api.put(`/roles/${code}/permissions`, { permissions }),
};

export const auditApi = {
    list: (params) => api.get('/audit', params),
    filters: () => api.get('/audit/filters'),
};

export const customersApi = {
    list: (params) => api.get('/customers', params),
    get: (id) => api.get(`/customers/${id}`),
    account: (id) => api.get(`/customers/${id}/account`),
    create: (data) => api.post('/customers', data),
    update: (id, data) => api.put(`/customers/${id}`, data),
    setActive: (id, isActive) => api.patch(`/customers/${id}/status`, { is_active: isActive }),
    confirmations: (id) => api.get(`/customers/${id}/confirmations`),
    confirm: (id, data) => api.post(`/customers/${id}/confirmations`, data),
};

/** Solicitudes de crédito (bloques 3.1–3.3). */
export const creditsApi = {
    list: (params) => api.get('/credit-applications', params),
    get: (id) => api.get(`/credit-applications/${id}`),
    quote: (data) => api.post('/credit-applications/quote', data),
    /** `requestKey` evita registrar dos veces el mismo envío (doble clic, reintento). */
    create: (data, requestKey) =>
        api.post('/credit-applications', data, requestKey ? { 'Idempotency-Key': requestKey } : undefined),
    verify: (id, data) => api.post(`/credit-applications/${id}/verifications`, data),
    conclude: (id) => api.post(`/credit-applications/${id}/verifications/conclude`, {}),
    modify: (id, data) => api.patch(`/credit-applications/${id}/conditions`, data),
    evaluation: (id) => api.get(`/credit-applications/${id}/evaluation`),
    decide: (id, data) => api.post(`/credit-applications/${id}/decision`, data),
    cancel: (id, reason) => api.post(`/credit-applications/${id}/cancel`, { reason }),
    concretize: (id, data) => api.post(`/credit-applications/${id}/concretize`, data),
    /** Última revisión de Administración/Gerencia tras un cambio del vendedor (012). */
    finalReview: (id, data) => api.post(`/credit-applications/${id}/final-review`, data),
};

export const productsApi = {
    list: (params) => api.get('/products', params),
    get: (id) => api.get(`/products/${id}`),
    categories: () => api.get('/products/categories'),
    pricePreview: (cost) => api.get('/products/price-preview', { cost }),
    create: (data) => api.post('/products', data),
    update: (id, data) => api.put(`/products/${id}`, data),
    setActive: (id, isActive) => api.patch(`/products/${id}/status`, { is_active: isActive }),
    adjustStock: (id, delta, reason) => api.post(`/products/${id}/stock`, { delta, reason }),
    movements: (id) => api.get(`/products/${id}/stock-movements`),
    inventory: (id) => api.get(`/products/${id}/inventory`),
    costHistory: (id) => api.get(`/products/${id}/cost-history`),
};

export const salesApi = {
    list: (params) => api.get('/sales', params),
    get: (id) => api.get(`/sales/${id}`),
    paymentModes: () => api.get('/sales/payment-modes'),
    quote: (data) => api.post('/sales/quote', data),
    create: (data) => api.post('/sales', data),
    cancel: (id, reason) => api.patch(`/sales/${id}/cancel`, { reason }),
};

export const paymentsApi = {
    list: (params) => api.get('/payments', params),
    methods: () => api.get('/payments/methods'),
    receivables: (params) => api.get('/payments/receivables', params),
    create: (data) => api.post('/payments', data),
    void: (id, reason) => api.patch(`/payments/${id}/void`, { reason }),
};

export const integrationsApi = {
    status: () => api.get('/integrations/status'),
    events: (params) => api.get('/integrations/events', params),
    event: (id) => api.get(`/integrations/events/${id}`),
    retry: (id) => api.post(`/integrations/events/${id}/retry`),
    dispatch: () => api.post('/integrations/dispatch'),
    scan: () => api.post('/integrations/collections/scan'),
    preview: () => api.get('/integrations/collections/preview'),
    eventTypes: () => api.get('/integrations/event-types'),
};

export const dashboardApi = { get: () => api.get('/dashboard') };
