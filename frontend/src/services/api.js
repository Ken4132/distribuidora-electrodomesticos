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
        return `${this.message}: ${this.details.map((d) => `${d.campo} — ${d.mensaje}`).join('; ')}`;
    }
    /** { campo: mensaje } para pintar el error debajo de cada input. */
    get fieldErrors() {
        if (!Array.isArray(this.details)) return {};
        return Object.fromEntries(this.details.map((d) => [d.campo, d.mensaje]));
    }
}

async function request(method, path, body) {
    let response;
    try {
        response = await fetch(BASE + path, {
            method,
            headers: {
                'Content-Type': 'application/json',
                ...(getToken() ? { Authorization: `Bearer ${getToken()}` } : {}),
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
    post: (path, body) => request('POST', path, body),
    put: (path, body) => request('PUT', path, body),
    patch: (path, body) => request('PATCH', path, body),
};

// --------------------------------------------------------------- Endpoints
export const authApi = {
    login: (username, password) => api.post('/auth/login', { username, password }),
    me: () => api.get('/auth/me'),
};

export const customersApi = {
    list: (params) => api.get('/customers', params),
    get: (id) => api.get(`/customers/${id}`),
    account: (id) => api.get(`/customers/${id}/account`),
    create: (data) => api.post('/customers', data),
    update: (id, data) => api.put(`/customers/${id}`, data),
    setActive: (id, isActive) => api.patch(`/customers/${id}/status`, { is_active: isActive }),
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

export const dashboardApi = { get: () => api.get('/dashboard') };
