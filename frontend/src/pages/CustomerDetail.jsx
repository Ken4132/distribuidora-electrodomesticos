import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { customersApi, salesApi } from '../services/api.js';
import { Badge, Spinner } from '../components/ui.jsx';
import { ACCOUNT_STATUS_LABELS, formatDate, money, PAYMENT_MODE_LABELS } from '../utils/format.js';

export default function CustomerDetail() {
    const { id } = useParams();
    const [customer, setCustomer] = useState(null);
    const [sales, setSales] = useState([]);
    const [error, setError] = useState('');

    useEffect(() => {
        Promise.all([customersApi.get(id), salesApi.list({ customerId: id, pageSize: 50 })])
            .then(([c, s]) => {
                setCustomer(c.data);
                setSales(s.data);
            })
            .catch((e) => setError(e.message));
    }, [id]);

    if (error) return <p className="alert alert--error">{error}</p>;
    if (!customer) return <Spinner />;

    const acc = customer.account ?? {};

    return (
        <div className="page">
            <div className="page__head">
                <div>
                    <Link to="/clientes" className="link link--back">
                        ← Clientes
                    </Link>
                    <h1>{customer.full_name}</h1>
                    <p className="page__sub">
                        DPI {customer.dpi} · {customer.phone}
                        {customer.phone_alt ? ` / ${customer.phone_alt}` : ''}
                    </p>
                </div>
                <Link to={`/ventas/nueva?cliente=${customer.id}`} className="btn btn--primary">
                    Nueva venta
                </Link>
            </div>

            <div className="cards">
                <div className="card card--static">
                    <span className="card__label">Total vendido</span>
                    <strong className="card__value">{money(acc.total_sold)}</strong>
                    <span className="card__extra">{acc.sales_count ?? 0} venta(s)</span>
                </div>
                <div className="card card--static">
                    <span className="card__label">Total pagado</span>
                    <strong className="card__value">{money(acc.total_paid)}</strong>
                </div>
                <div className={`card card--static ${Number(acc.total_balance) > 0 ? 'card--alert' : ''}`}>
                    <span className="card__label">Saldo pendiente</span>
                    <strong className="card__value">{money(acc.total_balance)}</strong>
                    <span className="card__extra">
                        {Number(acc.overdue_installments) > 0
                            ? `${acc.overdue_installments} cuota(s) vencida(s)`
                            : 'Sin cuotas vencidas'}
                    </span>
                </div>
                <div className="card card--static">
                    <span className="card__label">Próximo vencimiento</span>
                    <strong className="card__value">{acc.next_due_date ? formatDate(acc.next_due_date) : '—'}</strong>
                </div>
            </div>

            <section className="panel">
                <h2 className="panel__title">Datos de contacto</h2>
                <dl className="datalist">
                    <div>
                        <dt>Dirección</dt>
                        <dd>{customer.address}</dd>
                    </div>
                    <div>
                        <dt>Referencia</dt>
                        <dd>{customer.address_ref || '—'}</dd>
                    </div>
                    <div>
                        <dt>Correo</dt>
                        <dd>{customer.email || '—'}</dd>
                    </div>
                    <div>
                        <dt>Registrado</dt>
                        <dd>{formatDate(customer.created_at)}</dd>
                    </div>
                    <div>
                        <dt>Observaciones</dt>
                        <dd>{customer.notes || '—'}</dd>
                    </div>
                </dl>
            </section>

            <section className="panel">
                <h2 className="panel__title">Historial de ventas</h2>
                {sales.length === 0 ? (
                    <p className="muted">Este cliente todavía no tiene ventas registradas.</p>
                ) : (
                    <div className="table-wrap">
                        <table className="table">
                            <thead>
                                <tr>
                                    <th>No.</th>
                                    <th>Fecha</th>
                                    <th>Modalidad</th>
                                    <th className="right">Total</th>
                                    <th className="right">Pagado</th>
                                    <th className="right">Saldo</th>
                                    <th>Estado</th>
                                </tr>
                            </thead>
                            <tbody>
                                {sales.map((s) => (
                                    <tr key={s.id}>
                                        <td>
                                            <Link className="link mono" to={`/ventas/${s.id}`}>
                                                {s.sale_number}
                                            </Link>
                                        </td>
                                        <td>{formatDate(s.sale_date)}</td>
                                        <td>{PAYMENT_MODE_LABELS[s.payment_mode]}</td>
                                        <td className="right">{money(s.total)}</td>
                                        <td className="right">{money(s.paid_amount)}</td>
                                        <td className="right strong">{money(s.balance)}</td>
                                        <td>
                                            <Badge status={s.account_status}>
                                                {ACCOUNT_STATUS_LABELS[s.account_status]}
                                            </Badge>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </section>
        </div>
    );
}
