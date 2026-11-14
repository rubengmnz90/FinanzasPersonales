import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRightLeft } from 'lucide-react';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { get, post } from '../../app/api';
import type { Balance, SavingsBucket } from '../../app/types';
import { Combobox } from '../../components/Combobox';
import { Button } from '../../components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../../components/ui/dialog';
import { Input } from '../../components/ui/input';
import { Field } from '../../components/ui/label';
import { today, useToast } from '../../components/ui';

export type TransferMode = 'transfer' | 'saving' | 'loan' | 'repay';

const MODES: { id: TransferMode; label: string; help: string }[] = [
  { id: 'transfer', label: 'Entre cuentas', help: 'Mover plata de una cuenta a otra, o pagar una tarjeta.' },
  { id: 'saving', label: 'Pasar a ahorro', help: 'Convertir dinero de un banco en ahorro y elegir para qué es.' },
  { id: 'loan', label: 'Préstamo del ahorro', help: 'Sacar del ahorro para el flujo, una tarjeta o para prestarle a otra persona; queda pendiente de devolver.' },
  { id: 'repay', label: 'Devolver al ahorro', help: 'Reponer el ahorro con plata de tu banco, o con lo que una persona te devolvió directo al ahorro.' },
];

const LIQUID = ['bank', 'cash'];

function allowed(mode: TransferMode, side: 'from' | 'to', type: Balance['type']): boolean {
  switch (mode) {
    case 'saving': return side === 'from' ? LIQUID.includes(type) : type === 'savings';
    case 'loan': return side === 'from' ? type === 'savings' : [...LIQUID, 'card', 'receivable'].includes(type);
    case 'repay': return side === 'from' ? [...LIQUID, 'receivable'].includes(type) : type === 'savings';
    default: return true;
  }
}

export function TransferDialog({
  open, onOpenChange, accounts, initialMode = 'transfer', initialFrom, initialTo,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  accounts: Balance[];
  initialMode?: TransferMode;
  initialFrom?: string;
  initialTo?: string;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const [mode, setMode] = useState<TransferMode>(initialMode);
  const [amount, setAmount] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [bucket, setBucket] = useState('');
  const [date, setDate] = useState(today());
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [useLocked, setUseLocked] = useState(false);
  const buckets = useQuery({ queryKey: ['buckets'], queryFn: () => get<SavingsBucket[]>('/api/buckets'), enabled: open });

  const live = useMemo(() => accounts.filter((a) => !a.archived), [accounts]);
  const defaultBank = live.find((a) => a.isDefault)?.accountId ?? live.find((a) => a.type === 'bank')?.accountId ?? '';

  useEffect(() => {
    if (!open) return;
    setMode(initialMode);
    setAmount(''); setNote(''); setBucket(''); setDate(today()); setUseLocked(false);
    setFrom(initialFrom ?? '');
    setTo(initialTo ?? '');
  }, [open, initialMode, initialFrom, initialTo]);

  // Al cambiar de modo se proponen origen/destino coherentes (GNB como origen habitual).
  useEffect(() => {
    if (!open) return;
    const ok = (id: string, side: 'from' | 'to') => { const a = live.find((x) => x.accountId === id); return !!a && allowed(mode, side, a.type); };
    if (!ok(from, 'from')) setFrom(mode === 'loan' ? (live.find((a) => a.type === 'savings')?.accountId ?? '') : (ok(defaultBank, 'from') ? defaultBank : ''));
    if (!ok(to, 'to')) setTo(mode === 'saving' || mode === 'repay' ? (live.find((a) => a.type === 'savings')?.accountId ?? '') : mode === 'loan' || live.find((x) => x.accountId === from)?.type === 'receivable' ? defaultBank : '');
  }, [mode, open]); // eslint-disable-line react-hooks/exhaustive-deps

  const opts = (side: 'from' | 'to') =>
    live.filter((a) => allowed(mode, side, a.type)).map((a) => ({ value: a.accountId, label: a.name, hint: a.type === 'card' ? 'tarjeta' : a.type === 'savings' ? 'ahorro' : a.type === 'receivable' ? 'me debe' : a.alias ?? undefined }));
  const toAcc = live.find((a) => a.accountId === to);
  const fromAcc = live.find((a) => a.accountId === from);
  const needsBucket = toAcc?.type === 'savings' || fromAcc?.type === 'savings';
  const locked = mode === 'loan' && !!buckets.data?.find((b) => b.name === bucket)?.untouchable;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!from || !to) return toast.error(new Error('Elige la cuenta de origen y la de destino'));
    if (needsBucket && !bucket) return toast.error(new Error('Elige para qué es el ahorro (colchón, vacaciones, aguinaldo…)'));
    if (locked && !useLocked) return toast.error(new Error(`"${bucket}" es intocable: confirma que quieres usarlo`));
    setBusy(true);
    try {
      await post('/api/transfers', {
        date, fromAccountId: from, toAccountId: to, rawAmount: amount,
        kind: mode === 'loan' ? 'loan' : mode === 'repay' ? 'repayment' : 'transfer',
        bucket: needsBucket ? bucket : null, note: note || null, ...(locked ? { useUntouchable: true } : {}),
      });
      await Promise.all(['transactions', 'accounts', 'statement', 'buckets', 'health'].map((k) => qc.invalidateQueries({ queryKey: [k] })));
      toast.ok('Transferencia registrada');
      onOpenChange(false);
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><ArrowRightLeft className="size-5" /> Transferir</DialogTitle>
          <DialogDescription>{MODES.find((m) => m.id === mode)!.help}</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="grid gap-4" aria-label="Transferencia">
          <div className="chips w-full flex-wrap" role="group" aria-label="Tipo de transferencia">
            {MODES.map((m) => (
              <button type="button" key={m.id} className={mode === m.id ? 'on' : ''} onClick={() => setMode(m.id)}>{m.label}</button>
            ))}
          </div>
          <Field label="Monto">
            <Input autoFocus inputMode="text" className="num text-right text-lg" placeholder="0 o =fórmula" value={amount} onChange={(e) => setAmount(e.target.value)} required aria-label="Monto" />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Desde"><Combobox ariaLabel="Cuenta de origen" value={from} onChange={setFrom} options={opts('from')} placeholder="Cuenta de origen" /></Field>
            <Field label="Hacia"><Combobox ariaLabel="Cuenta de destino" value={to} onChange={setTo} options={opts('to').filter((o) => o.value !== from)} placeholder="Cuenta de destino" /></Field>
          </div>
          {needsBucket && (
            <Field label="¿Para qué es el ahorro?">
              <Combobox
                ariaLabel="Objetivo del ahorro"
                value={bucket}
                onChange={setBucket}
                options={(buckets.data ?? []).map((b) => ({ value: b.name, label: b.name, hint: b.untouchable ? 'intocable' : undefined }))}
                placeholder="Ahorro, aguinaldo, vacaciones…"
                onCreate={(name) => { setBucket(name); qc.setQueryData<SavingsBucket[]>(['buckets'], (old) => [...(old ?? []), { name, untouchable: false }]); }}
              />
            </Field>
          )}
          {locked && (
            <label className="flex items-start gap-2 rounded-md bg-amber-50 p-3 text-sm dark:bg-amber-950/40">
              <input type="checkbox" className="mt-0.5" checked={useLocked} onChange={(e) => setUseLocked(e.target.checked)} aria-label="Confirmo usar un objetivo intocable" />
              <span>“{bucket}” está marcado como intocable. Confirmo que decidí usarlo.</span>
            </label>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Fecha"><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} required aria-label="Fecha" /></Field>
            <Field label="Nota (opcional)"><Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Ej. cuota de la casa" aria-label="Nota" /></Field>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancelar</Button>
            <Button type="submit" disabled={busy}>Registrar</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
