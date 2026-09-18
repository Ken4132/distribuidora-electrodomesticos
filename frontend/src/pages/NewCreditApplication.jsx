import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { creditsApi, customersApi, productsApi } from '../services/api.js';
import { useDebounce } from '../hooks/useDebounce.js';
import { useToast } from '../context/ToastContext.jsx';
import { Field } from '../components/ui.jsx';
import { CustomerPicker } from './NewSale.jsx';
import { CustomerConfirmModal } from '../components/CustomerConfirmModal.jsx';
import { FINANCING_TYPE_LABELS, money, newRequestKey } from '../utils/format.js';

const PREDEFINED_TERMS = [4, 5, 6, 10, 12];

const DECLARED_FIELDS = [
    ['Vivienda y residencia', [['housing_type', 'Tipo de vivienda'], ['residence_time', 'Tiempo de residencia']]],
    [
        'Empleo',
        [
            ['employer_name', 'Empleador'],
            ['employer_phone', 'Teléfono del empleador'],
            ['employer_address', 'Dirección del empleo'],
            ['job_position', 'Puesto'],
            ['employment_time', 'Tiempo de laborar'],
            ['monthly_income', 'Ingreso mensual (Q)'],
        ],
    ],
    [
        'Referencias',
        [
            ['labor_reference_name', 'Referencia laboral'],
            ['labor_reference_phone', 'Teléfono ref. laboral'],
            ['labor_reference_relation', 'Relación ref. laboral'],
            ['personal_reference_name', 'Referencia personal'],
            ['personal_reference_phone', 'Teléfono ref. personal'],
            ['personal_reference_relation', 'Relación ref. personal'],
        ],
    ],
    [
        'Fiador (opcional)',
        [
            ['guarantor_name', 'Nombre del fiador'],
            ['guarantor_dpi', 'DPI del fiador'],
            ['guarantor_phone', 'Teléfono del fiador'],
            ['guarantor_address', 'Dirección del fiador'],
            ['guarantor_relation', 'Relación'],
        ],
    ],
];

export default function NewCreditApplication() {
    const toast = useToast();
    const navigate = useNavigate();
    const [params] = useSearchParams();

    const [customer, setCustomer] = useState(null);
    const [creditType, setCreditType] = useState('NORMAL');
    const [lines, setLines] = useState([]); // { key, product, quantity, financing_type, installments_count, proposed_price }
    const [downPayment, setDownPayment] = useState('0');
    const [declared, setDeclared] = useState({});
    const [quote, setQuote] = useState(null);
    const [quoteError, setQuoteError] = useState('');
    const [errors, setErrors] = useState({});
    const [saving, setSaving] = useState(false);
    const [confirming, setConfirming] = useState(false);
    // Una clave por intento de registro: un doble clic o un reintento no duplica la solicitud.
    const [requestKey, setRequestKey] = useState(newRequestKey);

    useEffect(() => {
        const id = params.get('cliente');
        if (id) customersApi.get(id).then((r) => setCustomer(r.data)).catch(() => {});
    }, [params]);

    const exceptional = creditType === 'EXCEPCIONAL_CONTADO';

    const items = useMemo(
        () =>
            lines.map((l) =>
                exceptional
                    ? { product_id: l.product.id, quantity: Number(l.quantity) }
                    : {
                          product_id: l.product.id,
                          quantity: Number(l.quantity),
                          financing_type: l.financing_type,
                          installments_count: Number(l.installments_count),
                          proposed_price: l.proposed_price === '' ? '0' : String(l.proposed_price),
                      }
            ),
        [lines, exceptional]
    );

    const quoteInput = useDebounce(JSON.stringify({ items, downPayment, creditType }), 400);

    useEffect(() => {
        // Cualquier cambio de datos es un envío distinto: nueva clave.
        setRequestKey(newRequestKey());
        const { items: qItems, downPayment: dp, creditType: ct } = JSON.parse(quoteInput);
        if (qItems.length === 0) {
            setQuote(null);
            setQuoteError('');
            return undefined;
        }
        let cancelled = false;
        creditsApi
            .quote({ credit_type: ct, proposed_down_payment: ct === 'EXCEPCIONAL_CONTADO' ? '0' : dp || '0', items: qItems })
            .then((r) => !cancelled && (setQuote(r.data), setQuoteError('')))
            .catch((e) => !cancelled && (setQuote(null), setQuoteError(e.fullMessage)));
        return () => {
            cancelled = true;
        };
    }, [quoteInput]);

    function addProduct(product) {
        setLines((prev) => [
            ...prev,
            { key: newRequestKey(), product, quantity: 1, financing_type: 'PREDEFINIDO', installments_count: 12, proposed_price: '' },
        ]);
    }
    const updateLine = (key, patch) => setLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)));
    const removeLine = (key) => setLines((prev) => prev.filter((l) => l.key !== key));

    async function save() {
        if (!customer || lines.length === 0 || saving) return;
        setSaving(true);
        setErrors({});
        try {
            const body = {
                customer_id: customer.id,
                credit_type: creditType,
                proposed_down_payment: exceptional ? '0' : downPayment || '0',
                items,
                ...Object.fromEntries(Object.entries(declared).filter(([, v]) => v !== '')),
            };
            const res = await creditsApi.create(body, requestKey);
            toast.success(res.message);
            navigate(`/creditos/${res.data.id}`);
        } catch (err) {
            if (err.details?.reason === 'CUSTOMER_RECONFIRMATION_REQUIRED') {
                toast.error(err.message);
                setConfirming(true);
            } else {
                setErrors(err.fieldErrors);
                toast.error(err.fullMessage);
            }
        } finally {
            setSaving(false);
        }
    }

    const quoteLine = (index) => quote?.items?.[index];

    return (
        <div className="page">
            <div className="page__head">
                <div>
                    <h1>Nueva solicitud de crédito</h1>
                    <p className="page__sub">
                        La solicitud no es una venta: no mueve inventario ni genera deuda. El enganche propuesto no es un pago.
                    </p>
                </div>
            </div>

            <div className="sale-layout">
                <div className="sale-main">
                    <section className="panel">
                        <h2 className="panel__title">1. Cliente</h2>
                        {customer ? (
                            <div className="picked">
                                <div>
                                    <strong>{customer.full_name}</strong>
                                    <span className="muted"> · DPI {customer.dpi} · {customer.phone}</span>
                                    <div className="muted small">{customer.address}</div>
                                </div>
                                <div>
                                    <button className="btn btn--ghost btn--sm" onClick={() => setConfirming(true)}>
                                        Actualizar / reconfirmar datos
                                    </button>{' '}
                                    <button className="btn btn--ghost btn--sm" onClick={() => setCustomer(null)}>
                                        Cambiar
                                    </button>
                                </div>
                            </div>
                        ) : (
                            <CustomerPicker onPick={setCustomer} />
                        )}
                    </section>

                    <section className="panel">
                        <h2 className="panel__title">2. Tipo de crédito y productos</h2>
                        <div className="modes">
                            {[
                                ['NORMAL', 'Crédito normal', 'Plazos predefinidos o especiales, con verificación'],
                                ['EXCEPCIONAL_CONTADO', 'Excepcional a precio de contado', 'Enganche Q0 · 1 pago al mes siguiente · decide Administración/Gerencia'],
                            ].map(([key, label, hint]) => (
                                <button key={key} type="button" className={`mode ${creditType === key ? 'mode--active' : ''}`} onClick={() => setCreditType(key)}>
                                    <strong>{label}</strong>
                                    <span>{hint}</span>
                                </button>
                            ))}
                        </div>

                        <CreditProductPicker onPick={addProduct} />

                        {lines.length > 0 && (
                            <div className="table-wrap sale-items">
                                <table className="table">
                                    <thead>
                                        <tr>
                                            <th>Producto</th>
                                            <th className="center">Cant.</th>
                                            {!exceptional && <th>Plan</th>}
                                            {!exceptional && <th className="center">Cuotas</th>}
                                            <th className="right">Precio unitario</th>
                                            <th className="right">Mínimo</th>
                                            <th className="right">Cuota línea</th>
                                            <th />
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {lines.map((l, index) => {
                                            const q = quoteLine(index);
                                            const below = q && (q.requires_price_exception || q.requires_installment_exception);
                                            return (
                                                <tr key={l.key} className={below ? 'row--error' : ''}>
                                                    <td>
                                                        <span className="mono">{l.product.code}</span> {l.product.name}
                                                        {below && <div className="small text-danger">Bajo el mínimo: requerirá autorización en la decisión</div>}
                                                    </td>
                                                    <td className="center">
                                                        <input className="input input--qty" type="number" min="1" value={l.quantity} onChange={(e) => updateLine(l.key, { quantity: e.target.value })} />
                                                    </td>
                                                    {!exceptional && (
                                                        <td>
                                                            <select className="input input--select" value={l.financing_type} onChange={(e) => updateLine(l.key, { financing_type: e.target.value })}>
                                                                <option value="PREDEFINIDO">{FINANCING_TYPE_LABELS.PREDEFINIDO}</option>
                                                                <option value="ESPECIAL">{FINANCING_TYPE_LABELS.ESPECIAL}</option>
                                                            </select>
                                                        </td>
                                                    )}
                                                    {!exceptional && (
                                                        <td className="center">
                                                            {l.financing_type === 'PREDEFINIDO' ? (
                                                                <select className="input input--select" value={l.installments_count} onChange={(e) => updateLine(l.key, { installments_count: e.target.value })}>
                                                                    {PREDEFINED_TERMS.map((t) => (
                                                                        <option key={t} value={t}>
                                                                            {t}
                                                                        </option>
                                                                    ))}
                                                                </select>
                                                            ) : (
                                                                <input className="input input--qty" type="number" min="6" value={l.installments_count} onChange={(e) => updateLine(l.key, { installments_count: e.target.value })} />
                                                            )}
                                                        </td>
                                                    )}
                                                    <td className="right">
                                                        {exceptional ? (
                                                            money(q?.proposed_price)
                                                        ) : (
                                                            <input className="input" inputMode="decimal" placeholder="0.00" value={l.proposed_price} onChange={(e) => updateLine(l.key, { proposed_price: e.target.value })} />
                                                        )}
                                                    </td>
                                                    <td className="right">{q ? money(q.minimum_price_snapshot) : '—'}</td>
                                                    <td className="right">
                                                        {q ? money(q.proposed_installment) : '—'}
                                                        {q && <div className="muted small">mín. {money(q.minimum_installment_snapshot)}</div>}
                                                    </td>
                                                    <td className="right">
                                                        <button className="btn btn--ghost btn--sm" onClick={() => removeLine(l.key)}>
                                                            Quitar
                                                        </button>
                                                    </td>
                                                </tr>
                                            );
                                        })}
                                    </tbody>
                                </table>
                            </div>
                        )}
                    </section>

                    <section className="panel">
                        <h2 className="panel__title">3. Información declarada por el cliente</h2>
                        {DECLARED_FIELDS.map(([title, fields]) => (
                            <fieldset key={title} className="fieldset">
                                <legend className="muted small">{title}</legend>
                                <div className="form-grid">
                                    {fields.map(([key, label]) => (
                                        <Field key={key} label={label} error={errors[key]} className="span-1">
                                            <input className="input" value={declared[key] ?? ''} onChange={(e) => setDeclared({ ...declared, [key]: e.target.value })} />
                                        </Field>
                                    ))}
                                </div>
                            </fieldset>
                        ))}
                    </section>
                </div>

                <aside className="sale-side">
                    <div className="summary">
                        <h2 className="panel__title">Resumen</h2>
                        {!exceptional && (
                            <Field label="Enganche propuesto (Q)" hint="Incluido dentro del total; no es un pago" error={errors.proposed_down_payment}>
                                <input className="input" inputMode="decimal" value={downPayment} onChange={(e) => setDownPayment(e.target.value)} />
                            </Field>
                        )}
                        {quoteError && <p className="alert alert--error">{quoteError}</p>}
                        {!quote ? (
                            <p className="muted">Agrega productos para ver el cálculo.</p>
                        ) : (
                            <>
                                <div className="summary__row">
                                    <span>Total</span>
                                    <strong>{money(quote.total)}</strong>
                                </div>
                                <div className="summary__row">
                                    <span>Enganche propuesto</span>
                                    <strong>{money(quote.proposed_down_payment)}</strong>
                                </div>
                                <div className="summary__row summary__row--total">
                                    <span>Financiado</span>
                                    <strong>{money(quote.financed_amount)}</strong>
                                </div>
                                {!quote.down_payment_valid && <p className="alert alert--error">El enganche debe ser menor que el total.</p>}
                            </>
                        )}
                        <button className="btn btn--primary btn--block" disabled={!customer || lines.length === 0 || saving || !quote} onClick={save}>
                            {saving ? 'Registrando…' : 'Registrar solicitud'}
                        </button>
                    </div>
                </aside>
            </div>

            {confirming && customer && (
                <CustomerConfirmModal
                    customer={customer}
                    onClose={() => setConfirming(false)}
                    onConfirmed={(data) => {
                        setCustomer(data.customer);
                        setConfirming(false);
                    }}
                />
            )}
        </div>
    );
}

export function CreditProductPicker({ onPick }) {
    const [term, setTerm] = useState('');
    const [results, setResults] = useState([]);
    const debounced = useDebounce(term, 250);

    useEffect(() => {
        if (debounced.trim().length < 2) {
            setResults([]);
            return;
        }
        productsApi
            .list({ search: debounced, status: 'active', pageSize: 8 })
            .then((r) => setResults(r.data))
            .catch(() => setResults([]));
    }, [debounced]);

    return (
        <div className="picker">
            <input className="input" placeholder="Agregar producto: código o nombre…" value={term} onChange={(e) => setTerm(e.target.value)} />
            {results.length > 0 && (
                <ul className="picker__list">
                    {results.map((p) => (
                        <li key={p.id}>
                            <button
                                type="button"
                                onClick={() => {
                                    onPick(p);
                                    setTerm('');
                                    setResults([]);
                                }}
                            >
                                <strong>
                                    <span className="mono">{p.code}</span> {p.name}
                                </strong>
                                <span className="muted">existencia total {p.stock}</span>
                            </button>
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}
