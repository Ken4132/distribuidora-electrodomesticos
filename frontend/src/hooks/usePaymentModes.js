import { useEffect, useState } from 'react';
import { salesApi } from '../services/api.js';

/**
 * Modalidades de pago y sus reglas comerciales, tomadas del backend.
 *
 * El frontend NO repite los porcentajes 30/50/70 ni los nombres de las
 * columnas de precio: los pide a la API. Así la regla vive en un solo lugar
 * (base de datos + backend) y la interfaz no puede quedar desincronizada.
 *
 * Se cachea a nivel de módulo: son datos que no cambian durante la sesión.
 */
let cache = null;
let inFlight = null;

export function usePaymentModes() {
    const [modes, setModes] = useState(cache ?? []);
    const [error, setError] = useState('');

    useEffect(() => {
        if (cache) return;
        inFlight = inFlight ?? salesApi.paymentModes();
        let active = true;
        inFlight
            .then((res) => {
                cache = res.data;
                if (active) setModes(res.data);
            })
            .catch((e) => {
                inFlight = null;
                if (active) setError(e.message);
            });
        return () => {
            active = false;
        };
    }, []);

    return { modes, error };
}

/** Precio de venta de un producto según la modalidad, usando la regla del backend. */
export function unitPriceFor(product, mode) {
    if (!product || !mode) return 0;
    return Number(product[mode.price_field] ?? 0);
}
