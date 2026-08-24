import { Component } from 'react';

/**
 * Evita la pantalla en blanco.
 *
 * Sin esto, cualquier error de render deja la aplicación completamente vacía y
 * la persona que la usa no tiene forma de saber qué pasó ni cómo salir.
 * Con esto se muestra un mensaje, se conserva el detalle técnico para
 * reportarlo y se ofrece recargar.
 */
export class ErrorBoundary extends Component {
    constructor(props) {
        super(props);
        this.state = { error: null };
    }

    static getDerivedStateFromError(error) {
        return { error };
    }

    componentDidCatch(error, info) {
        console.error('[ui] Error no controlado:', error, info?.componentStack);
    }

    render() {
        if (!this.state.error) return this.props.children;

        return (
            <div className="page">
                <div className="panel">
                    <h1>Algo salió mal en esta pantalla</h1>
                    <p className="muted">
                        La información guardada no se vio afectada. Recarga la página; si vuelve a
                        ocurrir, comparte el detalle de abajo con el desarrollador.
                    </p>
                    <pre className="error-detail">{String(this.state.error?.message ?? this.state.error)}</pre>
                    <div className="form-actions">
                        <button className="btn" onClick={() => window.location.reload()}>
                            Recargar
                        </button>
                        <button
                            className="btn btn--primary"
                            onClick={() => {
                                window.location.href = '/';
                            }}
                        >
                            Volver al inicio
                        </button>
                    </div>
                </div>
            </div>
        );
    }
}
