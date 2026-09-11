/**
 * NORMALIZACIÓN DE DATOS DE NEGOCIO
 *
 * Representación canónica de un texto identificable o buscable:
 *
 *     MAYÚSCULAS + SIN TILDES + ESPACIOS NORMALIZADOS + TRIM
 *
 *     '   José   López Álvarez  '   ->   'JOSE LOPEZ ALVAREZ'
 *
 * Se normaliza AQUÍ, en el backend, no en React: el navegador puede
 * saltarse, y una carga por API o un script no pasan por el formulario.
 *
 * La misma regla existe en SQL como `normalize_business_text()` (migración
 * 004). Las dos implementaciones deben coincidir carácter por carácter;
 * `npm run test:normalize` lo comprueba contra la base de datos real.
 *
 * REGLAS QUE NO SON ARBITRARIAS:
 *
 *   * La Ñ SE CONSERVA. En español la eñe es una letra, no un diacrítico:
 *     "PEÑA" y "PENA" son apellidos distintos y no deben colapsar.
 *
 *   * Cada tipo de dato lleva su propia normalización. Aplicar mayúsculas
 *     a un correo o a un nombre de usuario sería incorrecto, y aplicarlas a
 *     un código de permiso o de rol rompería el control de acceso. Por eso
 *     no existe una única función para todo.
 */

/** Tildes y diéresis del español (y la ç), en minúscula y mayúscula. */
const DIACRITICS = 'áàäâãéèëêíìïîóòöôõúùüûçÁÀÄÂÃÉÈËÊÍÌÏÎÓÒÖÔÕÚÙÜÛÇ';
const REPLACEMENTS = 'aaaaaeeeeiiiiooooouuuucAAAAAEEEEIIIIOOOOOUUUUC';

const DIACRITIC_MAP = new Map();
for (let i = 0; i < DIACRITICS.length; i += 1) {
    DIACRITIC_MAP.set(DIACRITICS[i], REPLACEMENTS[i]);
}

// Mismo juego de espacios que reconoce PostgreSQL, más el espacio duro
// (U+00A0), que llega constantemente al pegar texto desde Word.
const SPACE_RUN = /[ \t\n\r\f\v ]+/g;
const SPACE_EDGE = /^[ \t\n\r\f\v ]+|[ \t\n\r\f\v ]+$/g;

/**
 * Forma canónica de un texto de negocio.
 * Devuelve null si la entrada es null o undefined; devuelve '' si el texto
 * solo traía espacios (quien llama decide si eso es válido).
 *
 * @param {string|null|undefined} value
 * @returns {string|null}
 */
export function normalizeText(value) {
    if (value === null || value === undefined) return null;

    const collapsed = String(value).replace(SPACE_EDGE, '').replace(SPACE_RUN, ' ');

    let out = '';
    for (const ch of collapsed) {
        out += DIACRITIC_MAP.get(ch) ?? ch;
    }
    return out.toUpperCase();
}

/**
 * Igual que `normalizeText`, pero un texto vacío se convierte en null.
 * Para los campos opcionales: en la base de datos "sin referencia" es NULL,
 * no una cadena vacía.
 */
export function normalizeOptionalText(value) {
    const normalized = normalizeText(value);
    return normalized === '' ? null : normalized;
}

/**
 * Correo electrónico: minúsculas y sin espacios.
 * NO se le aplican mayúsculas: la parte local de una dirección puede ser
 * sensible a mayúsculas según el RFC, y mostrar un correo en mayúsculas es
 * incorrecto aunque el servidor lo acepte.
 */
export function normalizeEmail(value) {
    if (value === null || value === undefined) return null;
    const trimmed = String(value).trim().toLowerCase();
    return trimmed === '' ? null : trimmed;
}

/**
 * Código técnico (producto, sucursal): mayúsculas y sin espacios en los
 * extremos. No se le quitan tildes porque el propio formato ya solo admite
 * letras sin acento, números y separadores.
 */
export function normalizeCode(value) {
    if (value === null || value === undefined) return null;
    return String(value).trim().toUpperCase();
}

/**
 * Consulta de búsqueda. Es la MISMA transformación que se aplicó al guardar,
 * y por eso "josé lópez", "JOSE LOPEZ" y "  José   López " encuentran el
 * mismo registro.
 *
 * Devuelve '' cuando no hay nada que buscar, para que quien llama pueda
 * omitir el filtro sin condicionales repartidos por el código.
 */
export function normalizeSearch(value) {
    return normalizeText(value) ?? '';
}

/**
 * DPI de Guatemala: solo los 13 dígitos.
 * Idéntico a lo que ya hacía el validador de clientes; se centraliza aquí
 * para que la búsqueda por DPI use exactamente la misma forma canónica que
 * el alta.
 */
export function normalizeDpi(value) {
    if (value === null || value === undefined) return null;
    return String(value).replace(/[^0-9]/g, '');
}

/**
 * Teléfono: se conserva el formato que ya usa el proyecto (dígitos, con el
 * prefijo +502 opcional). No se reformatea ni se le añade prefijo: cambiar
 * el formato invalidaría los teléfonos ya guardados.
 */
export function normalizePhone(value) {
    if (value === null || value === undefined) return null;
    const cleaned = String(value).replace(/[\s()-]/g, '');
    return cleaned === '' ? null : cleaned;
}
