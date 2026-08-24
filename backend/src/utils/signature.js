import crypto from 'node:crypto';

/**
 * Firma HMAC-SHA256 de los webhooks que la aplicación envía a n8n.
 *
 * Por qué firmar en vez de mandar el secreto en una cabecera:
 *   1. El secreto nunca viaja por la red. Quien intercepte una petición no
 *      puede fabricar otras.
 *   2. La firma cubre el CUERPO: si alguien altera un monto en tránsito, la
 *      verificación falla.
 *   3. Va sellada con la hora, así que una petición capturada no se puede
 *      reenviar días después (protección contra repetición).
 *
 * Lo que se firma es la cadena `${timestamp}.${body}`, no solo el cuerpo.
 * Firmar solo el cuerpo permitiría reenviar la misma petición para siempre.
 */

export const SIGNATURE_HEADER = 'x-signature-256';
export const TIMESTAMP_HEADER = 'x-webhook-timestamp';

export function signingPayload(timestamp, body) {
    return `${timestamp}.${body}`;
}

/** Devuelve la firma en el formato `sha256=<hex>`. */
export function signBody(secret, timestamp, body) {
    const hmac = crypto.createHmac('sha256', secret);
    hmac.update(signingPayload(timestamp, body), 'utf8');
    return `sha256=${hmac.digest('hex')}`;
}

/**
 * Verifica una firma recibida. Se usa en el receptor de pruebas y sirve de
 * referencia para el nodo de n8n.
 *
 * La comparación es en tiempo constante: comparar con `===` filtra
 * información sobre cuántos caracteres coinciden.
 */
export function verifySignature({ secret, timestamp, body, signature, toleranceSeconds = 300 }) {
    if (!signature || !timestamp) return { valid: false, reason: 'faltan cabeceras de firma' };

    const age = Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp));
    if (!Number.isFinite(age)) return { valid: false, reason: 'timestamp inválido' };
    if (age > toleranceSeconds) return { valid: false, reason: `timestamp fuera de tolerancia (${age}s)` };

    const expected = signBody(secret, timestamp, body);
    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(String(signature), 'utf8');
    if (a.length !== b.length) return { valid: false, reason: 'firma no coincide' };
    if (!crypto.timingSafeEqual(a, b)) return { valid: false, reason: 'firma no coincide' };

    return { valid: true };
}
