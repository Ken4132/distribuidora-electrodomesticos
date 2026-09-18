import express from 'express';
import cors from 'cors';
import helmet from 'helmet';

import routes from './routes/index.js';
import { config } from './config/env.js';
import { apiLimiter } from './middleware/rateLimit.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';

export function createApp() {
    const app = express();

    // De esto depende qué IP ve el limitador de login. NO se fija a `true`:
    // eso confiaría en cualquier X-Forwarded-For y la IP sería falsificable.
    // El valor sale de TRUST_PROXY; ver config/env.js -> parseTrustProxy.
    app.set('trust proxy', config.trustProxy);
    app.disable('x-powered-by');

    app.use(helmet());

    // CORS restringido a los orígenes declarados en la configuración.
    app.use(
        cors({
            origin(origin, callback) {
                // Peticiones sin Origin (curl, Postman, health checks) se permiten.
                if (!origin) return callback(null, true);
                if (config.corsOrigins.includes(origin)) return callback(null, true);
                return callback(new Error(`Origen no permitido por CORS: ${origin}`));
            },
            credentials: true,
        })
    );

    app.use(express.json({ limit: '256kb' }));
    app.use(express.urlencoded({ extended: false, limit: '256kb' }));

    // Freno general de volumen. El login tiene además sus dos frenos propios
    // (por IP + usuario y por IP) en routes/auth.routes.js.
    app.use(apiLimiter);

    if (!config.isProd) {
        app.use((req, _res, next) => {
            console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl}`);
            next();
        });
    }

    app.use('/api', routes);

    app.use(notFoundHandler);
    app.use(errorHandler);

    return app;
}
