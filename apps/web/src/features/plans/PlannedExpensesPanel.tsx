import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { del, get, patch, post, qs } from '../../app/api';
import type { PlannedExpense } from '../../app/types';
import { DataGrid, type Column } from '../../components/DataGrid';
import { Money, RangePicker, money, useToast, type Range } from '../../components/ui';

export function PlannedExpensesPanel({ year, periods, onChanged }: { year: number; periods: string[]; onChanged: () => Promise<unknown> }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [range, setRange] = useState<Range>({ from: `${year}-01-01`, to: `${year}-12-31` });
  const [onlyPending, setOnlyPending] = useState(false);
  const q = useQuery({
    queryKey: ['planned', range, onlyPending],
    queryFn: () => get<PlannedExpense[]>('/api/planned-expenses' + qs({ from: range.from, to: range.to, done: onlyPending ? 'false' : undefined })),
  });
  const rows = q.data ?? [];
  const refresh = async () => { await qc.invalidateQueries({ queryKey: ['planned'] }); await onChanged(); };

  const columns: Column<PlannedExpense>[] = [
    { key: 'dueDate', label: 'Fecha de pago', width: 130, kind: 'date', editable: true, value: (r) => r.dueDate },
    { key: 'concept', label: 'Concepto', width: 230, editable: true, value: (r) => r.concept },
    { key: 'periodLabel', label: 'Cobro', width: 130, kind: 'select', editable: true, options: periods.map((p) => ({ value: p, label: p })), value: (r) => r.periodLabel },
    { key: 'amount', label: 'Monto', width: 130, align: 'right', kind: 'money', editable: true, value: (r) => r.amount, display: (r) => money(r.amount) },
    {
      key: 'done', label: 'Estado', width: 190, value: () => '',
      display: (r) =>
        r.done ? (
          <span className="badge ok">Realizado{r.transactionId ? ' · en el flujo' : ''}</span>
        ) : (
          <span style={{ display: 'inline-flex', gap: 4 }} onMouseDown={(e) => e.stopPropagation()}>
            <button className="btn sm" onClick={async () => {
              try { await post(`/api/planned-expenses/${r.id}/done`, { createTransaction: true }); await refresh(); await qc.invalidateQueries({ queryKey: ['transactions'] }); toast.ok('Marcado y registrado en el flujo'); } catch (e) { toast.error(e); }
            }}>Pagado + flujo</button>
            <button className="btn sm" title="Solo marcar, sin crear movimiento" onClick={async () => {
              try { await post(`/api/planned-expenses/${r.id}/done`, { createTransaction: false }); await refresh(); } catch (e) { toast.error(e); }
            }}>✓</button>
          </span>
        ),
    },
    {
      key: 'del', label: '', width: 50, value: () => '',
      display: (r) => (
        <button className="btn sm danger" aria-label={`Eliminar ${r.concept}`} onMouseDown={(e) => e.stopPropagation()} onClick={async () => {
          if (!confirm(`¿Eliminar "${r.concept}"?`)) return;
          try { await del(`/api/planned-expenses/${r.id}`); await refresh(); } catch (e) { toast.error(e); }
        }}>✕</button>
      ),
    },
  ];

  const pendingTotal = rows.filter((r) => !r.done).reduce((s, r) => s + r.amount, 0);

  return (
    <>
      <div className="toolbar" style={{ marginBottom: 10 }}>
        <RangePicker value={range} onChange={setRange} />
        <label className="toolbar"><input type="checkbox" checked={onlyPending} onChange={(e) => setOnlyPending(e.target.checked)} /> Solo pendientes</label>
        <span className="muted">Pendiente en el rango: <Money v={pendingTotal} /></span>
      </div>
      <AddPlanned periods={periods} year={year} onAdded={refresh} />
      <DataGrid
        ariaLabel="Otros gastos"
        columns={columns}
        rows={rows}
        rowId={(r) => r.id}
        onError={toast.error}
        height={Math.min(420, 34 * (rows.length + 2))}
        onCommit={async (id, col, raw) => {
          await patch(`/api/planned-expenses/${id}`, col === 'amount' ? { rawAmount: raw } : { [col]: raw });
          await refresh();
        }}
      />
    </>
  );
}

function AddPlanned({ periods, year, onAdded }: { periods: string[]; year: number; onAdded: () => Promise<unknown> }) {
  const toast = useToast();
  const [concept, setConcept] = useState('');
  const [amount, setAmount] = useState('');
  const [dueDate, setDueDate] = useState(`${year}-${String(new Date().getMonth() + 1).padStart(2, '0')}-15`);
  const [periodLabel, setPeriodLabel] = useState(periods[0] ?? '');
  async function submit(e: FormEvent) {
    e.preventDefault();
    try {
      await post('/api/planned-expenses', { concept, rawAmount: amount, dueDate, periodLabel: periodLabel || periods[0] });
      setConcept(''); setAmount('');
      await onAdded();
    } catch (err) { toast.error(err); }
  }
  return (
    <form className="toolbar card" style={{ marginBottom: 10, padding: 10 }} onSubmit={submit} aria-label="Nuevo gasto puntual">
      <input className="field" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} required aria-label="Fecha de pago" />
      <input className="field" placeholder="Concepto" value={concept} onChange={(e) => setConcept(e.target.value)} required style={{ flex: '1 1 160px' }} />
      <select className="field" value={periodLabel} onChange={(e) => setPeriodLabel(e.target.value)} aria-label="Cobro">
        {periods.map((p) => <option key={p}>{p}</option>)}
      </select>
      <input className="field num" placeholder="Monto o =fórmula" value={amount} onChange={(e) => setAmount(e.target.value)} required style={{ width: 150, textAlign: 'right' }} />
      <button className="btn primary">Agregar</button>
    </form>
  );
}
