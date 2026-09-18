import { useState } from 'react';
import { customersApi } from '../services/api.js';
import { useToast } from '../context/ToastContext.jsx';
import { Field, Modal } from './ui.jsx';

const FIELDS = [
    ['full_name', 'Nombre completo', 'span-2'],
    ['phone', 'Teléfono', 'span-1'],
    ['phone_alt', 'Teléfono alterno', 'span-1'],
    ['email', 'Correo', 'span-2'],
    ['address', 'Dirección', 'span-3'],
    ['address_ref', 'Referencia', 'span-3'],
    ['municipality', 'Municipio', 'span-1'],
    ['department', 'Departamento', 'span-1'],
];

/**
 * Actualización y reconfirmación de datos del cliente (regla 9).
 * Obligatoria antes de una nueva solicitud de crédito de un cliente que ya
 * tiene operaciones. Se envían solo los campos que cambiaron; el backend
 * guarda una copia fechada de la ficha resultante.
 */
export function CustomerConfirmModal({ customer, onClose, onConfirmed }) {
    const toast = useToast();
    const [form, setForm] = useState(() => Object.fromEntries(FIELDS.map(([k]) => [k, customer[k] ?? ''])));
    const [notes, setNotes] = useState('');
    const [errors, setErrors] = useState({});
    const [busy, setBusy] = useState(false);

    async function submit(e) {
        e.preventDefault();
        setBusy(true);
        setErrors({});
        const changes = Object.fromEntries(
            FIELDS.map(([k]) => k)
                .filter((k) => (form[k] ?? '') !== (customer[k] ?? ''))
                .map((k) => [k, form[k]])
        );
        try {
            const res = await customersApi.confirm(customer.id, { ...changes, confirmation_notes: notes || '' });
            toast.success(res.message);
            onConfirmed?.(res.data);
        } catch (err) {
            setErrors(err.fieldErrors);
            toast.error(err.fullMessage);
        } finally {
            setBusy(false);
        }
    }

    return (
        <Modal open wide title={`Actualizar y reconfirmar datos — ${customer.full_name}`} onClose={onClose}>
            <form onSubmit={submit}>
                <p className="muted">
                    Revisa cada dato con el cliente. Al guardar queda constancia de la reconfirmación con fecha y usuario.
                </p>
                <div className="form-grid">
                    {FIELDS.map(([key, label, span]) => (
                        <Field key={key} label={label} error={errors[key]} className={span}>
                            <input className="input" value={form[key]} onChange={(e) => setForm({ ...form, [key]: e.target.value })} />
                        </Field>
                    ))}
                    <Field label="Observaciones de la reconfirmación" className="span-3" error={errors.confirmation_notes}>
                        <input className="input" value={notes} onChange={(e) => setNotes(e.target.value)} />
                    </Field>
                </div>
                <div className="form-actions">
                    <button type="button" className="btn btn--ghost" onClick={onClose}>
                        Cancelar
                    </button>
                    <button className="btn btn--primary" disabled={busy}>
                        {busy ? 'Guardando…' : 'Datos confirmados'}
                    </button>
                </div>
            </form>
        </Modal>
    );
}
