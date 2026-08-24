import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

// `loadEnv` es necesario: Vite NO copia el archivo .env a process.env dentro de
// este archivo de configuración. Sin esto, VITE_API_TARGET se ignoraba en
// silencio y el proxy siempre apuntaba a http://localhost:4000.
export default defineConfig(({ mode }) => {
    const env = loadEnv(mode, process.cwd(), '');
    const target = env.VITE_API_TARGET || 'http://localhost:4000';

    return {
        plugins: [react()],
        server: {
            port: Number(env.VITE_PORT) || 5173,
            // El frontend siempre llama a /api de forma relativa; en desarrollo
            // este proxy lo redirige al backend, así no hace falta tocar CORS.
            proxy: {
                '/api': { target, changeOrigin: true },
            },
        },
        preview: {
            port: Number(env.VITE_PORT) || 5173,
            proxy: {
                '/api': { target, changeOrigin: true },
            },
        },
    };
});
