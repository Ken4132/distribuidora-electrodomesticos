import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';

import routes from './routes/index.js';
import { config } from './config/env.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';

export function createApp() {
    const app = express();

    app.set('trust proxy', 1);
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

    app.use(
        rateLimit({
            windowMs: 60 * 1000,
            limit: 300,
            standardHeaders: true,
            legacyHeaders: false,
        })
    );

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
