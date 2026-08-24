/**
 * Receptor de prueba: simula el webhook de n8n.
 *
 * Sirve para dos cosas:
 *   1. Probar la integración completa sin tener n8n levantado.
 *   2. Servir de referencia exacta de cómo se verifica la firma. Lo que hace
 *      este archivo es lo mismo que debe hacer el nodo Code de n8n.
 *
 *   node src/scripts/n8n-receiver.js
 *
 * Variables:
 *   RECEIVER_PORT    puerto de escucha (4500)
 *   RECEIVER_SECRET  el mismo valor de N8N_WEBHOOK_SECRET
 *   RECEIVER_MODE    ok | fail | slow   — para probar reintentos
 *   RECEIVER_LOG     archivo donde volcar los eventos recibidos (JSON por línea)
 */
import http from 'node:http';
import { appendFileSync } from 'node:fs';
import { verifySignature } from '../utils/signature.js';

const PORT = Number(process.env.RECEIVER_PORT ?? 4500);
const SECRET = process.env.RECEIVER_SECRET ?? '';
const MODE = process.env.RECEIVER_MODE ?? 'ok';
const LOG_FILE = process.env.RECEIVER_LOG ?? '';

const seen = new Set();
let received = 0;
let duplicates = 0;
let rejected = 0;

const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/stats') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ received, duplicates, rejected, unique: seen.size, mode: MODE }));
        return;
    }

    if (req.method !== 'POST') {
        res.writeHead(405).end();
        return;
    }

    let raw = '';
    req.on('data', (chunk) => {
        raw += chunk;
    });

    req.on('end', () => {
        // ---- 1. Verificar la firma ANTES de mirar el contenido -----------
        if (SECRET) {
            const check = verifySignature({
                secret: SECRET,
                timestamp: req.headers['x-webhook-timestamp'],
                body: raw,
                signature: req.headers['x-signature-256'],
            });
            if (!check.valid) {
                rejected += 1;
                console.log(`[receptor] RECHAZADO: ${check.reason}`);
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: check.reason }));
                return;
            }
        }

        // ---- 2. Descartar duplicados por X-Event-Id ----------------------
        const eventId = req.headers['x-event-id'];
        if (eventId && seen.has(eventId)) {
            duplicates += 1;
            console.log(`[receptor] duplicado ignorado: evento ${eventId}`);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, duplicate: true }));
            return;
        }
        if (eventId) seen.add(eventId);

        // ---- 3. Procesar -------------------------------------------------
        let parsed = null;
        try {
            parsed = JSON.parse(raw);
        } catch {
            res.writeHead(400).end(JSON.stringify({ ok: false, error: 'JSON inválido' }));
            return;
        }

        received += 1;
        console.log(`[receptor] ${parsed.event} (evento ${parsed.id}) — agregado ${parsed.aggregate} ${parsed.aggregate_id}`);
        if (LOG_FILE) appendFileSync(LOG_FILE, `${JSON.stringify({ headers: req.headers, body: parsed })}\n`);

        // ---- 4. Responder según el modo de prueba ------------------------
        if (MODE === 'fail') {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'fallo simulado' }));
            return;
        }
        if (MODE === 'slow') {
            setTimeout(() => {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true }));
            }, 30_000);
            return;
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, received: parsed.event }));
    });
});

server.listen(PORT, () => {
    console.log(`[receptor] Escuchando en http://localhost:${PORT}  modo=${MODE}  firma=${SECRET ? 'requerida' : 'desactivada'}`);
});
