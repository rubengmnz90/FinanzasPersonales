import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { del, get, patch, post, qs } from '../../app/api';
import type { Ledger, LedgerEntry } from '../../app/types';
import { DataGrid, type Column } from '../../components/DataGrid';
import { Button } from '../../components/ui/button';
import { Input, NativeSelect } from '../../components/ui/input';
import { Field } from '../../components/ui/label';
import { Money, RangePicker, money, today, type Range } from '../../components/ui';

export interface LedgerLabels {
  /** Opción que suma (monto positivo) y la que resta (monto negativo). */
  plus: string;
  minus: string;
  grid: string;
}

export const DEBT_LABELS: LedgerLabels = { plus: 'Pago (reduce)', minus: 'Cargo (aumenta)', grid: 'Movimientos de la deuda' };
export const BOX_LABELS: LedgerLabels = { plus: 'Ingreso (suma)', minus: 'Egreso (resta)', grid: 'Movimientos de la caja' };

/** Historial editable de una cuenta con movimientos propios (deudas, cajas, fondos y ahorros). */
export function LedgerView({
  accountId, labels, showBucket, onChanged, onError,
}: {
  accountId: string;
  labels: LedgerLabels;
  /** Muestra la columna editable "Objetivo" (ahorros). */
  showBucket?: boolean;
  onChanged: () => unknown;
  onError: (e: unknown) => void;
}) {
  const qc = useQueryClient();
  const [range, setRange] = useState<Range>({ from: '', to: '' });
  const q = useQuery({ queryKey: ['ledger', accountId, range], queryFn: () => get<Ledger>(`/api/accounts/${accountId}` + qs({ from: range.from, to: range.to })) });
  const l = q.data;
  // Más nuevo arriba (como el flujo); el saldo de cada fila sigue siendo el acumulado a esa fecha.
  const rows = l ? [...l.entries].reverse() : [];
  const refresh = async () => { await qc.invalidateQueries({ queryKey: ['ledger'] }); await onChanged(); };
  if (!l) return null;

  const columns: Column<LedgerEntry>[] = [
    { key: 'date', label: 'Fecha', width: 120, kind: 'date', editable: true, value: (r) => r.date },
    { key: 'concept', label: 'Concepto', width: 280, editable: true, value: (r) => r.concept },
    ...(showBucket ? [{ key: 'bucket', label: 'Objetivo', width: 140, editable: true, value: (r: LedgerEntry) => r.bucket ?? '' } as Column<LedgerEntry>] : []),
    ...(showBucket ? [{ key: 'person', label: 'Persona', width: 150, editable: true, value: (r: LedgerEntry) => r.person ?? '' } as Column<LedgerEntry>] : []),
    { key: 'amount', label: 'Monto', width: 140, align: 'right', kind: 'money', editable: true, value: (r) => r.amount, display: (r) => <Money v={r.amount} signed /> },
    { key: 'balance', label: 'Saldo', width: 140, align: 'right', value: (r) => r.balance, display: (r) => <Money v={r.balance} /> },
    {
      key: 'del', label: '', width: 46, value: () => '',
      display: (r) => (
        <button
          className="grid size-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-rose-100 hover:text-rose-700 dark:hover:bg-rose-950"
          aria-label={`Eliminar ${r.concept}`}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={async () => {
            if (!confirm(`¿Eliminar "${r.concept}"?`)) return;
            try { await del(`/api/entries/${r.id}`); await refresh(); } catch (e) { onError(e); }
          }}
        >
          <Trash2 className="size-4" />
        </button>
      ),
    },
  ];

  return (
    <>
      <div className="page-head">
        <h2 className="!mb-0">{l.account.name}{l.account.counterparty ? ` · ${l.account.counterparty}` : ''}</h2>
        <RangePicker value={range} onChange={setRange} />
      </div>
      <p className="mb-3 text-sm">
        Saldo: <b><Money v={l.balance} signed /></b>{l.owed > 0 && <> · Debes <b className="neg">{money(l.owed)}</b></>}
      </p>
      <AddEntry accountId={l.account.id} labels={labels} showBucket={showBucket} onAdded={refresh} onError={onError} />
      <DataGrid
        ariaLabel={labels.grid}
        columns={columns}
        rows={rows}
        rowId={(r) => r.id}
        onError={onError}
        height={Math.min(520, 34 * (rows.length + 2))}
        onCommit={async (id, col, raw) => {
          await patch(`/api/entries/${id}`, col === 'amount' ? { rawAmount: raw } : col === 'bucket' ? { bucket: raw.trim() || null } : col === 'person' ? { person: raw.trim() || null } : { [col]: raw });
          await refresh();
        }}
      />
    </>
  );
}

/** Tipos de movimiento de un ahorro: el signo y la marca que lo distingue de un préstamo. */
const SAVINGS_KINDS: { id: string; label: string; sign: 1 | -1; tag?: string }[] = [
  { id: 'deposit', label: 'Depósito (aporte a mi ahorro)', sign: 1 },
  { id: 'withdrawal', label: 'Extracción (saqué mi ahorro)', sign: -1 },
  { id: 'loan', label: 'Préstamo (sale, hay que devolver)', sign: -1, tag: 'temp_withdrawal' },
  { id: 'return', label: 'Devolución (vuelve a mi ahorro)', sign: 1, tag: 'return' },
];

function AddEntry({ accountId, labels, showBucket, onAdded, onError }: { accountId: string; labels: LedgerLabels; showBucket?: boolean; onAdded: () => Promise<unknown>; onError: (e: unknown) => void }) {
  const [date, setDate] = useState(today());
  const [concept, setConcept] = useState('');
  const [amount, setAmount] = useState('');
  const [bucket, setBucket] = useState('');
  const [flow, setFlow] = useState<string>('plus');
  const [person, setPerson] = useState('');
  const kinds = showBucket ? SAVINGS_KINDS : [{ id: 'plus', label: labels.plus, sign: 1 }, { id: 'minus', label: labels.minus, sign: -1 }];
  const kind = kinds.find((k) => k.id === flow) ?? kinds[0];
  async function submit(e: FormEvent) {
    e.preventDefault();
    try {
      const raw = amount.trim();
      const rawAmount = kind.sign < 0 ? `=-(${raw.replace(/^=/, '')})` : raw;
      await post(`/api/accounts/${accountId}/entries`, {
        date, concept, rawAmount,
        ...(showBucket && bucket ? { bucket } : {}),
        ...('tag' in kind && kind.tag ? { tag: kind.tag } : {}),
        ...('tag' in kind && kind.tag && person.trim() ? { person: person.trim() } : {}),
      });
      setConcept(''); setAmount('');
      await onAdded();
    } catch (err) { onError(err); }
  }
  return (
    <form className="mb-3 flex flex-wrap items-end gap-3 rounded-xl border bg-card p-4 shadow-sm" onSubmit={submit} aria-label="Nuevo movimiento de cuenta">
      <Field label="Monto" className="w-40"><Input className="num text-right" placeholder="0 o =fórmula" value={amount} onChange={(e) => setAmount(e.target.value)} required aria-label="Monto" /></Field>
      <Field label="Concepto" className="min-w-48 flex-1"><Input value={concept} onChange={(e) => setConcept(e.target.value)} required aria-label="Concepto" /></Field>
      {showBucket && <Field label="Objetivo" className="w-36"><Input value={bucket} onChange={(e) => setBucket(e.target.value)} placeholder="Ahorro…" aria-label="Objetivo" /></Field>}
      {showBucket && 'tag' in kind && !!kind.tag && <Field label="Persona" className="w-40"><Input value={person} onChange={(e) => setPerson(e.target.value)} placeholder="Charlie… (vacío = normal)" aria-label="Persona" /></Field>}
      <Field label="Tipo" className="w-60">
        <NativeSelect value={kind.id} onChange={(e) => setFlow(e.target.value)} aria-label="Tipo de movimiento">
          {kinds.map((k) => <option key={k.id} value={k.id}>{k.label}</option>)}
        </NativeSelect>
      </Field>
      <Field label="Fecha" className="w-40"><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} required aria-label="Fecha" /></Field>
      <Button type="submit"><Plus /> Agregar</Button>
    </form>
  );
}
