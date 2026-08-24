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
};

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
    tarjeta: 'Tarjeta',
    cheque: 'Cheque',
    otro: 'Otro',
};
