/** Formato de moneda en quetzales. */
export function money(value) {
    const n = Number(value ?? 0);
    return `Q ${n.toLocaleString('es-GT', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** 'YYYY-MM-DD' -> '23/08/2026'. No usa Date para no arrastrar zona horaria. */
export function formatDate(iso) {
    if (!iso) return '—';
    const [y, m, d] = String(iso).slice(0, 10).split('-');
    return `${d}/${m}/${y}`;
}

export function formatDateTime(value) {
    if (!value) return '—';
    return new Date(value).toLocaleString('es-GT', {
        timeZone: 'America/Guatemala',
        dateStyle: 'short',
        timeStyle: 'short',
    });
}

/** 'YYYY-MM-DD' de hoy en la zona del negocio (para valores por defecto). */
export function todayIso() {
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/Guatemala',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).format(new Date());
}

export const PAYMENT_MODE_LABELS = {
    contado: 'Contado',
    credito_4: 'Crédito 4 pagos',
    credito_8: 'Crédito 8 pagos',
    credito: 'Crédito',
};

export const CREDIT_STATUS_LABELS = {
    SOLICITADO: 'Solicitado',
    EN_VERIFICACION: 'En verificación',
    EN_EVALUACION: 'En evaluación',
    APROBADO: 'Aprobado',
    VENTA_CONCRETADA: 'Venta concretada',
    ACTIVO: 'Activo',
    RECHAZADO: 'Rechazado',
    CANCELADO: 'Cancelado',
    VENTA_ANULADA: 'Venta anulada',
};

/** Estado de solicitud -> color de insignia existente. */
export const CREDIT_STATUS_BADGE = {
    SOLICITADO: 'pendiente',
    EN_VERIFICACION: 'parcial',
    EN_EVALUACION: 'parcial',
    APROBADO: 'al_dia',
    VENTA_CONCRETADA: 'pagada',
    ACTIVO: 'pagada',
    RECHAZADO: 'vencida',
    CANCELADO: 'anulada',
    VENTA_ANULADA: 'anulada',
};

export const CREDIT_TYPE_LABELS = {
    NORMAL: 'Normal',
    EXCEPCIONAL_CONTADO: 'Excepcional a precio de contado',
};

export const FINANCING_TYPE_LABELS = {
    PREDEFINIDO: 'Predefinido',
    ESPECIAL: 'Especial',
    CONTADO_EXCEPCIONAL: 'Contado (excepcional)',
};

export const VERIFICATION_RESULT_LABELS = {
    FAVORABLE: 'Favorable',
    DESFAVORABLE: 'Desfavorable',
    NECESITA_REVISION: 'Necesita revisión',
};

/** Clave única por intento de envío (cabecera Idempotency-Key). */
export function newRequestKey() {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
    return `k${Date.now()}${Math.random().toString(36).slice(2, 12)}`;
}

export const ACCOUNT_STATUS_LABELS = {
    pendiente: 'Pendiente',
    al_dia: 'Al día',
    vencida: 'Vencida',
    pagada: 'Pagada',
    anulada: 'Anulada',
};

export const INSTALLMENT_STATUS_LABELS = {
    pendiente: 'Pendiente',
    parcial: 'Parcial',
    vencida: 'Vencida',
    pagada: 'Pagada',
};

export const METHOD_LABELS = {
    efectivo: 'Efectivo',
    transferencia: 'Transferencia',
    deposito: 'Depósito',
    remesa: 'Remesa',
    tarjeta: 'Tarjeta',
    // Históricos: ya no se pueden registrar, pero se siguen leyendo.
    cheque: 'Cheque',
    otro: 'Otro',
};

/**
 * Métodos que EXIGEN correlativo/referencia al registrar (regla PG9 del
 * backend). Se replica aquí solo para avisar antes de enviar; quien decide y
 * rechaza es el servidor.
 */
export const METHODS_REQUIRING_REFERENCE = ['transferencia', 'deposito', 'tarjeta'];

/** Tramos de morosidad que devuelve la cartera (bloque 5). */
export const BUCKET_LABELS = {
    AL_DIA: 'Al día',
    '1_30': '1 a 30 días',
    '31_60': '31 a 60 días',
    '61_90': '61 a 90 días',
    MAS_90: 'Más de 90 días',
};

/**
 * Tramo -> insignia. Escala propia y progresiva: el rojo queda para el
 * último tramo, que es el único realmente crítico.
 */
export const BUCKET_BADGE = {
    AL_DIA: 'al_dia',
    '1_30': 'mora1',
    '31_60': 'mora2',
    '61_90': 'mora3',
    MAS_90: 'mora4',
};

/** Clave de color de cada tramo para la barra de distribución de mora. */
export const BUCKET_TONE = {
    AL_DIA: 'al_dia',
    '1_30': 'mora1',
    '31_60': 'mora2',
    '61_90': 'mora3',
    MAS_90: 'mora4',
};

export const VOUCHER_STATUS_LABELS = {
    PENDIENTE_DE_BOLETA: 'Pendiente de boleta',
    EN_REVISION: 'En revisión',
    REVISADA: 'Revisada',
    RECHAZADA: 'Rechazada',
};

export const RESTRUCTURING_KIND_LABELS = {
    REESTRUCTURACION: 'Reestructuración',
    REGULARIZACION: 'Regularización',
};
