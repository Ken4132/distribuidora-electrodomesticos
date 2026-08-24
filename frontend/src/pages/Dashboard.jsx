import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { dashboardApi } from '../services/api.js';
import { money, formatDate } from '../utils/format.js';
import { Spinner } from '../components/ui.jsx';

export default function Dashboard() {
    const [data, setData] = useState(null);
    const [error, setError] = useState('');

    useEffect(() => {
        dashboardApi
            .get()
            .then((r) => setData(r.data))
            .catch((e) => setError(e.message));
    }, []);

    if (error) return <p className="alert alert--error">{error}</p>;
    if (!data) return <Spinner />;

    const cards = [
        { label: 'Ventas de hoy', value: data.sales.today_count, extra: money(data.sales.today_amount), to: '/ventas' },
        { label: 'Por cobrar', value: money(data.receivables.total_balance), extra: `${data.receivables.overdue_sales} venta(s) vencida(s)`, to: '/cobranza', alert: data.receivables.overdue_sales > 0 },
        { label: 'Clientes activos', value: data.customers.active, extra: `${data.customers.total} en total`, to: '/clientes' },
        { label: 'Productos', value: data.products.active, extra: `${data.products.low_stock} con stock bajo`, to: '/productos', alert: data.products.low_stock > 0 },
    ];

    return (
        <div className="page">
            <div className="page__head">
                <div>
                    <h1>Resumen operativo</h1>
                    <p className="page__sub">{formatDate(data.today)}</p>
                </div>
                <Link to="/ventas/nueva" className="btn btn--primary">
                    Registrar venta
                </Link>
            </div>

            <div className="cards">
                {cards.map((c) => (
                    <Link key={c.label} to={c.to} className={`card ${c.alert ? 'card--alert' : ''}`}>
                        <span className="card__label">{c.label}</span>
                        <strong className="card__value">{c.value}</strong>
                        <span className="card__extra">{c.extra}</span>
                    </Link>
                ))}
            </div>
        </div>
    );
}
