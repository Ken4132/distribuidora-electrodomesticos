/**
 * Protección del login contra fuerza bruta.
 *
 *   npm run test:rate-limit           (usa http://localhost:4000)
 *   API_URL=... npm run test:rate-limit
 *
 * Qué se comprueba (ver middleware/rateLimit.js):
 *
 *   * el freno PRINCIPAL es por IP + usuario, así que dos empleados de la
 *     misma oficina NO comparten contador;
 *   * fallar muchas veces con el MISMO usuario sí bloquea;
 *   * cambiar de usuario no es un atajo: el freno GLOBAL por IP lo contiene;
 *   * un inicio de sesión correcto no gasta el presupuesto de fallos;
 *   * la protección está activa, sin excepciones por entorno.
 *
 * Cada escenario usa su PROPIA IP simulada (X-Forwarded-For). No es una
 * excepción para pruebas: el backend solo hace caso de esa cabecera cuando
 * quien conecta es de confianza según TRUST_PROXY (aquí `loopback`), que es
 * exactamente lo que ocurre con un proxy en la misma máquina. El limitador
 * está tan activo como en producción; lo único que cambia es que cada
 * escenario se presenta como un cliente distinto, igual que dos oficinas.
 */
const BASE = (process.env.API_URL ?? 'http://localhost:4000').replace(/\/$/, '') + '/api';
const ADMIN_USER = process.env.SEED_ADMIN_USERNAME ?? 'admin';
const ADMIN_PASS = process.env.SEED_ADMIN_PASSWORD ?? 'Admin123!';

let passed = 0;
let failed = 0;
const c = { ok: '\x1b[32m', bad: '\x1b[31m', dim: '\x1b[2m', off: '\x1b[0m' };

function check(name, condition, extra = '') {
    if (condition) {
        passed += 1;
        console.log(`  ${c.ok}PASA${c.off}  ${name}`);
    } else {
        failed += 1;
        console.log(`  ${c.bad}FALLA${c.off} ${name} ${c.dim}${extra}${c.off}`);
    }
}

/** Un intento de login desde una IP simulada concreta. */
async function login(ip, username, password) {
    const res = await fetch(`${BASE}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip },
        body: JSON.stringify({ username, password }),
    });
    const body = await res.json().catch(() => null);
    return {
        status: res.status,
        code: body?.error?.code ?? null,
        limit: res.headers.get('ratelimit-limit'),
        remaining: res.headers.get('ratelimit-remaining'),
    };
}

const fail = (ip, username) => login(ip, username, 'clave-incorrecta-de-prueba');
const ok = (ip) => login(ip, ADMIN_USER, ADMIN_PASS);

/** Repite intentos fallidos y devuelve la lista de estados. */
async function failMany(ip, username, times) {
    const out = [];
    for (let i = 0; i < times; i += 1) out.push((await fail(ip, username)).status);
    return out;
}

async function main() {
    console.log(`\n=== Protección del login contra fuerza bruta (${BASE}) ===\n`);

    const primero = await fail('198.51.100.1', 'usuario_inexistente_a');
    if (primero.status === 0 || primero.status >= 500) {
        throw new Error(`El backend no responde correctamente al login (estado ${primero.status})`);
    }

    // El límite real se DESCUBRE fallando, no se lee de la configuración: así
    // la prueba comprueba el comportamiento y no una copia de los ajustes.
    // Se usa una IP propia para no gastar contador de los demás escenarios.
    const SONDA = '198.51.100.2';
    let LIMITE_USUARIO = 0;
    while (LIMITE_USUARIO < 200) {
        const intento = await fail(SONDA, 'usuario_sonda');
        if (intento.status === 429) break;
        LIMITE_USUARIO += 1;
    }
    check('Hay un límite de intentos fallidos por usuario y es razonable',
        LIMITE_USUARIO > 0 && LIMITE_USUARIO < 200, `${LIMITE_USUARIO} intentos`);
    check('El límite que ve el cliente en las cabeceras RateLimit-* es ese mismo',
        Number(primero.limit) === LIMITE_USUARIO, `RateLimit-Limit = ${primero.limit}`);

    // ------------------------------------------------------------------ 1
    console.log('\n[1] Dos empleados en la misma IP no comparten el límite principal');
    const OFICINA = '203.0.113.10';
    const estadosA = await failMany(OFICINA, 'empleado_uno', LIMITE_USUARIO);
    check(
        `El primer empleado agota su propio límite (${LIMITE_USUARIO} intentos)`,
        estadosA.every((s) => s === 401),
        estadosA.join(',')
    );
    const bloqueadoA = await fail(OFICINA, 'empleado_uno');
    check('Y al siguiente intento queda bloqueado (429 RATE_LIMITED)',
        bloqueadoA.status === 429 && bloqueadoA.code === 'RATE_LIMITED',
        `${bloqueadoA.status} ${bloqueadoA.code}`);

    const companero = await fail(OFICINA, 'empleado_dos');
    check('Su compañero, desde la MISMA IP, sigue pudiendo intentar (401, no 429)',
        companero.status === 401, `recibido ${companero.status}`);
    const companeroEntra = await ok(OFICINA);
    check('Y un empleado con credenciales correctas entra sin problema (200)',
        companeroEntra.status === 200, `recibido ${companeroEntra.status}`);

    // ------------------------------------------------------------------ 2
    console.log('\n[2] Fallar repetidamente con el mismo usuario sí se limita');
    const ATACANTE = '203.0.113.20';
    const serie = await failMany(ATACANTE, 'empleado_uno', LIMITE_USUARIO + 2);
    const bloqueos = serie.filter((s) => s === 429).length;
    check(`Tras ${LIMITE_USUARIO} fallos, los siguientes se rechazan con 429`,
        serie.slice(0, LIMITE_USUARIO).every((s) => s === 401) && bloqueos === 2, serie.join(','));
    check('El mismo usuario desde OTRA IP no está bloqueado (el contador es por IP + usuario)',
        (await fail('203.0.113.21', 'empleado_uno')).status === 401);

    // ------------------------------------------------------------------ 3
    console.log('\n[3] Cambiar de usuario no es un atajo: el límite global por IP');
    const BARRIDO = '203.0.113.30';
    let globalStatus = 401;
    let intentos = 0;
    const TOPE = 400; // corta la prueba si algo no estuviera limitando
    while (globalStatus === 401 && intentos < TOPE) {
        intentos += 1;
        // Un usuario DISTINTO cada vez: el límite por IP + usuario nunca se
        // agota, así que lo único que puede frenar esto es el límite global.
        globalStatus = (await fail(BARRIDO, `barrido_${intentos}`)).status;
    }
    check('Probar un usuario distinto cada vez termina bloqueado por la IP',
        globalStatus === 429 && intentos < TOPE, `bloqueado en el intento ${intentos}`);
    check('El límite global es más alto que el principal, no una copia',
        intentos > LIMITE_USUARIO, `global ${intentos} vs principal ${LIMITE_USUARIO}`);
    check('Con la IP bloqueada tampoco pasa un usuario nuevo cualquiera',
        (await fail(BARRIDO, 'otro_usuario_mas')).status === 429);

    // ------------------------------------------------------------------ 4
    console.log('\n[4] Un inicio de sesión correcto no gasta el contador de fallos');
    const NORMAL = '203.0.113.40';
    const aciertos = [];
    for (let i = 0; i < 30; i += 1) aciertos.push(await ok(NORMAL));
    check('30 inicios de sesión correctos seguidos: todos entran (200)',
        aciertos.every((r) => r.status === 200),
        aciertos.map((r) => r.status).join(','));
    // Un acierto ocupa su hueco mientras se procesa y lo libera al responder,
    // así que la cabecera marca siempre lo mismo: los aciertos NO se acumulan.
    // Si consumieran contador, este número iría bajando intento a intento.
    check('Los aciertos no se acumulan: el presupuesto de fallos no baja',
        new Set(aciertos.map((r) => r.remaining)).size === 1 &&
            Number(aciertos.at(-1).remaining) === LIMITE_USUARIO - 1,
        `valores observados: ${[...new Set(aciertos.map((r) => r.remaining))].join(', ')}`);

    // Y el presupuesto de fallos sigue siendo el mismo de siempre.
    const mezcla = [];
    for (let i = 0; i < LIMITE_USUARIO - 1; i += 1) {
        mezcla.push((await fail(NORMAL, ADMIN_USER)).status);
        await ok(NORMAL); // un acierto entre fallo y fallo: no debe contar
    }
    check(`Intercalando aciertos, los ${LIMITE_USUARIO - 1} fallos siguen aceptándose`,
        mezcla.every((s) => s === 401), mezcla.join(','));
    check('El fallo siguiente agota el límite y el posterior se bloquea',
        (await fail(NORMAL, ADMIN_USER)).status === 401 &&
            (await fail(NORMAL, ADMIN_USER)).status === 429);
    check('Aun con ese usuario bloqueado, otro usuario de la misma IP puede intentar',
        (await fail(NORMAL, 'otro_empleado_de_la_oficina')).status === 401);

    // ------------------------------------------------------------------ 5
    console.log('\n[5] No se diluye el límite escribiendo el usuario de otra forma');
    const FORMATO = '203.0.113.50';
    const variantes = ['ADMIN_PRUEBA', 'admin_prueba', '  Admin_Prueba  ', 'aDmIn_PrUeBa', 'ADMIN_prueba'];
    const estadosFormato = [];
    for (let i = 0; i < LIMITE_USUARIO; i += 1) {
        estadosFormato.push((await fail(FORMATO, variantes[i % variantes.length])).status);
    }
    check('Mayúsculas, minúsculas y espacios comparten el mismo contador',
        estadosFormato.every((s) => s === 401), estadosFormato.join(','));
    check('Al agotarlo, cualquier variante del mismo usuario queda bloqueada',
        (await fail(FORMATO, '   ADMIN_PRUEBA ')).status === 429);
    check('Pero un usuario realmente distinto de esa IP sigue pudiendo intentar',
        (await fail(FORMATO, 'admin_prueba_2')).status === 401);

    // ------------------------------------------------------------------ 6
    console.log('\n[6] La protección está activa y no se puede rodear');
    const CUERPO = '203.0.113.60';
    const basura = await fetch(`${BASE}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': CUERPO },
        body: JSON.stringify({ usuario: 'admin' }),
    });
    check('Un cuerpo inválido también se rechaza (422) y cuenta como intento',
        basura.status === 422 && Number(basura.headers.get('ratelimit-remaining')) < LIMITE_USUARIO,
        `estado ${basura.status}, quedan ${basura.headers.get('ratelimit-remaining')}`);
    const sinUsuario = await failMany(CUERPO, undefined, LIMITE_USUARIO);
    check('Enviar el login sin usuario tampoco es un hueco: se limita igual',
        sinUsuario.includes(429), sinUsuario.join(','));

    const bloqueadoDeVerdad = await fail('203.0.113.20', 'empleado_uno');
    check('El bloqueo de [2] sigue vigente: no se olvida entre pruebas',
        bloqueadoDeVerdad.status === 429, `recibido ${bloqueadoDeVerdad.status}`);
    check('La protección no depende del entorno: no hay excepción para pruebas',
        bloqueadoDeVerdad.code === 'RATE_LIMITED');

    // ------------------------------------------------------------------ 7
    console.log('\n[7] Las suites de pruebas ya no se bloquean entre sí');
    const SUITE_A = '198.18.0.11';
    const SUITE_B = '198.18.0.12';
    const entradasA = [];
    for (let i = 0; i < 20; i += 1) entradasA.push((await ok(SUITE_A)).status);
    const entradasB = [];
    for (let i = 0; i < 20; i += 1) entradasB.push((await ok(SUITE_B)).status);
    check('Dos suites seguidas pueden iniciar sesión decenas de veces sin reiniciar el backend',
        entradasA.every((s) => s === 200) && entradasB.every((s) => s === 200),
        `${entradasA.filter((s) => s !== 200).length + entradasB.filter((s) => s !== 200).length} fallos`);

    console.log(`\n=== Resultado: ${c.ok}${passed} correctas${c.off}, ${failed ? c.bad : ''}${failed} fallidas${c.off} ===\n`);
    process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
    console.error('\nError inesperado durante la prueba:', error);
    process.exit(1);
});
