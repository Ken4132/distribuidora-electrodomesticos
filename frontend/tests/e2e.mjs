/**
 * Prueba de extremo a extremo en un navegador real.
 *
 * Recorre la aplicación como lo haría una persona:
 *   login → cliente → producto → venta a crédito → stock → pago → saldo →
 *   cobranza → estado de cuenta del cliente.
 *
 * Requisitos (no van en las dependencias del proyecto para no engordar la
 * instalación de quien solo quiere ejecutar el sistema):
 *
 *   npm install --no-save playwright
 *   npx playwright install chromium
 *
 * Con el backend y el frontend corriendo:
 *
 *   npm run test:e2e
 *
 * Variables opcionales:
 *   E2E_BASE_URL   (por defecto http://localhost:5173)
 *   E2E_USER       (por defecto admin)
 *   E2E_PASSWORD   (por defecto Admin123!)
 *   E2E_SHOTS      carpeta donde guardar capturas (por defecto ./tests/shots)
 */
import { mkdirSync } from 'node:fs';

const BASE = (process.env.E2E_BASE_URL ?? 'http://localhost:5173').replace(/\/$/, '');
const USER = process.env.E2E_USER ?? 'admin';
const PASSWORD = process.env.E2E_PASSWORD ?? 'Admin123!';
const SHOTS = process.env.E2E_SHOTS ?? new URL('./shots', import.meta.url).pathname;

let chromium;
try {
    ({ chromium } = await import('playwright'));
} catch {
    console.error(
        '\nFalta Playwright. Instálalo con:\n' +
            '  npm install --no-save playwright\n' +
            '  npx playwright install chromium\n'
    );
    process.exit(1);
}

const color = { ok: '\x1b[32m', bad: '\x1b[31m', dim: '\x1b[2m', off: '\x1b[0m' };
const failures = [];
const consoleErrors = [];
let passed = 0;

const log = (m) => console.log(m);
function check(name, condition, extra = '') {
    if (condition) {
        passed += 1;
        log(`  ${color.ok}PASA${color.off}  ${name}`);
    } else {
        failures.push(name);
        log(`  ${color.bad}FALLA${color.off} ${name} ${color.dim}${extra}${color.off}`);
    }
}

mkdirSync(SHOTS, { recursive: true });

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1500, height: 950 } });
const page = await context.newPage();
page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
page.on('pageerror', (e) => consoleErrors.push(`PAGEERROR: ${e.message}`));

const shot = async (name) => page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });

const stamp = Date.now().toString().slice(-6);
const DPI = `31${stamp}0101`.slice(0, 13).padEnd(13, '0');
const CODE = `E2E-${stamp}`;

try {
    // ------------------------------------------------------------------ LOGIN
    log('\n[UI 1] Autenticación');
    await page.goto(`${BASE}/clientes`);
    await page.waitForURL('**/login');
    check('Una ruta protegida redirige a /login', page.url().includes('/login'));

    await page.fill('input[autocomplete="username"]', USER);
    await page.fill('input[type="password"]', 'contraseña-incorrecta');
    await page.click('button:has-text("Entrar")');
    await page.waitForSelector('.alert--error');
    check('El login con contraseña incorrecta muestra error', true);
    await shot('01-login-error');

    await page.fill('input[type="password"]', PASSWORD);
    await page.click('button:has-text("Entrar")');
    await page.waitForSelector('h1:has-text("Resumen operativo")', { timeout: 15000 });
    check('El login correcto entra al sistema', true);
    await shot('02-inicio');

    // --------------------------------------------------------------- CLIENTES
    log('\n[UI 2] Alta de cliente');
    await page.click('a.navlink:has-text("Clientes")');
    await page.waitForSelector('h1:has-text("Clientes")');
    await page.click('button:has-text("Nuevo cliente")');
    await page.waitForSelector('.modal');

    await page.fill('.modal input.mono >> nth=0', '123');
    await page.fill('.modal .span-2 input', 'Cliente Prueba E2E');
    await page.fill('.modal .span-1:has-text("Teléfono") input >> nth=0', '55559999');
    await page.fill('.modal .span-3 input >> nth=0', 'Zona 10, Ciudad de Guatemala');
    await page.click('.modal button:has-text("Guardar cliente")');
    await page.waitForSelector('.field__error, .toast--error', { timeout: 8000 });
    check('Un DPI inválido muestra el error en el formulario', true);
    await shot('03-cliente-validacion');

    await page.fill('.modal input.mono >> nth=0', DPI);
    await page.click('.modal button:has-text("Guardar cliente")');
    await page.waitForSelector('.toast--success', { timeout: 10000 });
    await page.waitForSelector('.modal', { state: 'detached' });
    check('El cliente se registra desde la interfaz', true);

    await page.fill('input[type="search"]', DPI);
    await page.waitForTimeout(900);
    check('El cliente aparece al buscarlo por DPI', await page.isVisible('text=Cliente Prueba E2E'));
    await shot('04-clientes');

    // -------------------------------------------------------------- PRODUCTOS
    log('\n[UI 3] Alta de producto y reglas de precio');
    await page.click('a.navlink:has-text("Productos")');
    await page.waitForSelector('h1:has-text("Productos")');
    await page.click('button:has-text("Nuevo producto")');
    await page.waitForSelector('.modal');
    await page.fill('.modal input.mono', CODE);
    await page.fill('.modal .span-2 input', 'Producto Prueba E2E');
    await page.fill('.modal input[type="number"] >> nth=0', '1000');
    await page.waitForTimeout(400);

    const contado = await page.locator('.price-preview__row strong[data-mode="contado"]').textContent();
    const credito4 = await page.locator('.price-preview__row strong[data-mode="credito_4"]').textContent();
    const credito8 = await page.locator('.price-preview__row strong[data-mode="credito_8"]').textContent();
    check('Vista previa contado (+30 %) = Q 1,300.00', contado.includes('1,300.00'), contado);
    check('Vista previa 4 pagos (+50 %) = Q 1,500.00', credito4.includes('1,500.00'), credito4);
    check('Vista previa 8 pagos (+70 %) = Q 1,700.00', credito8.includes('1,700.00'), credito8);
    await shot('05-producto-precios');

    await page.fill('.modal input[type="number"] >> nth=1', '10');
    await page.click('.modal button:has-text("Guardar producto")');
    await page.waitForSelector('.toast--success', { timeout: 10000 });
    await page.waitForSelector('.modal', { state: 'detached' });
    await page.fill('input[type="search"]', CODE);
    await page.waitForTimeout(900);
    check('El producto aparece en el listado', await page.isVisible('text=Producto Prueba E2E'));
    await shot('06-productos');

    // ----------------------------------------------------------------- VENTA
    log('\n[UI 4] Registro de venta a crédito de 4 pagos');
    await page.click('a.navlink:has-text("Nueva venta")');
    await page.waitForSelector('h1:has-text("Nueva venta")');

    await page.fill('input[placeholder*="cliente"]', DPI);
    await page.waitForSelector('.picker__list button', { timeout: 10000 });
    await page.click('.picker__list button >> nth=0');
    check('El cliente queda seleccionado', await page.isVisible('.picked'));

    await page.fill('input[placeholder*="producto"]', CODE);
    await page.waitForSelector('.picker__list button', { timeout: 10000 });
    await page.click('.picker__list button >> nth=0');
    await page.fill('.input--qty', '3');
    await page.click('.mode:has-text("4 pagos")');
    await page.waitForTimeout(1500);

    const total = await page.locator('.summary__row--total strong').textContent();
    check('Total calculado = Q 4,500.00', total.includes('4,500.00'), total);
    check('Se muestran 4 cuotas', (await page.locator('.installments li').count()) === 4);
    const cuota = await page.locator('.installments li strong >> nth=0').textContent();
    check('Cada cuota = Q 1,125.00', cuota.includes('1,125.00'), cuota);
    await shot('07-nueva-venta');

    await page.click('button:has-text("Registrar venta")');
    await page.waitForSelector('h1:has-text("Venta V-")', { timeout: 15000 });
    const saleUrl = page.url();
    check('La venta se registra y se abre su detalle', true);
    const saldo = await page.locator('.card:has-text("Saldo pendiente") .card__value').textContent();
    check('Saldo inicial = Q 4,500.00', saldo.includes('4,500.00'), saldo);
    await shot('08-venta');

    await page.click('a.navlink:has-text("Productos")');
    await page.waitForSelector('h1:has-text("Productos")');
    await page.fill('input[type="search"]', CODE);
    await page.waitForTimeout(1000);
    const stock = (await page.locator('tbody tr >> nth=0').locator('td').nth(7).textContent()).trim();
    check('El stock bajó de 10 a 7', stock === '7', `= ${stock}`);

    // ------------------------------------------------------------------ PAGO
    log('\n[UI 5] Registro de pago y saldo');
    await page.goto(saleUrl);
    await page.click('button:has-text("Registrar pago")');
    await page.waitForSelector('.modal');
    const monto = await page.locator('.modal input[type="number"]').inputValue();
    check('El monto se precarga con la cuota completa', monto === '1125.00', `= ${monto}`);
    await shot('09-pago');

    await page.click('.modal button:has-text("Registrar pago")');
    await page.waitForSelector('.toast--success', { timeout: 10000 });
    await page.waitForTimeout(1500);
    const saldo2 = await page.locator('.card:has-text("Saldo pendiente") .card__value').textContent();
    check('Saldo tras el pago = Q 3,375.00', saldo2.includes('3,375.00'), saldo2);
    check('La cuota 1 queda marcada como Pagada', await page.isVisible('.badge--pagada'));
    check('El pago aparece en el historial', await page.isVisible('table >> text=Efectivo'));
    await shot('10-venta-pagada-parcial');

    // ---------------------------------------------- COBRANZA Y PERSISTENCIA
    log('\n[UI 6] Cobranza y persistencia');
    await page.click('a.navlink:has-text("Cobranza")');
    await page.waitForSelector('h1:has-text("Cobranza")');
    await page.waitForTimeout(1000);
    check('La venta aparece en cuentas por cobrar', await page.isVisible('text=Cliente Prueba E2E'));
    await shot('11-cobranza');

    await page.click('a.navlink:has-text("Clientes")');
    await page.waitForSelector('h1:has-text("Clientes")');
    await page.fill('input[type="search"]', DPI);
    await page.waitForTimeout(1000);
    await page.click('tbody a.link >> nth=0');
    await page.waitForSelector('h1:has-text("Cliente Prueba E2E")');
    const saldoCliente = await page.locator('.card:has-text("Saldo pendiente") .card__value').textContent();
    check('El estado de cuenta del cliente muestra Q 3,375.00', saldoCliente.includes('3,375.00'), saldoCliente);
    await shot('12-estado-de-cuenta');

    // -------------------------------------------------------------- CONSOLA
    log('\n[UI 7] Salud del navegador');
    const realErrors = consoleErrors.filter((e) => !/favicon|Failed to load resource/i.test(e));
    check('Sin errores de JavaScript en consola', realErrors.length === 0, realErrors.slice(0, 3).join(' | '));
} catch (error) {
    failures.push(`Excepción: ${error.message}`);
    log(`\n${color.bad}Excepción durante la prueba:${color.off} ${error.message}`);
    await shot('99-error');
} finally {
    await browser.close();
}

log(
    `\n=== Interfaz: ${color.ok}${passed} correctas${color.off}, ` +
        `${failures.length ? color.bad : ''}${failures.length} fallidas${color.off} ` +
        `· capturas en ${SHOTS} ===\n`
);
if (failures.length) log(failures.join('\n'));
process.exit(failures.length ? 1 : 0);
