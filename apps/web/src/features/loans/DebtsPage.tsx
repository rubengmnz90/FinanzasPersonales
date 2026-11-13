import { useQuery, useQueryClient } from '@tanstack/react-query';
import { HandCoins, Plus } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { get, post } from '../../app/api';
import type { Balance } from '../../app/types';
import { Button } from '../../components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../../components/ui/dialog';
import { Input } from '../../components/ui/input';
import { Field } from '../../components/ui/label';
import { Kpi, Money, money, useToast } from '../../components/ui';
import { cn } from '../../lib/utils';
import { DEBT_LABELS, LedgerView } from './LedgerView';

const NO_LENDER = 'Sin indicar';

/** Deudas personales, agrupadas por quién me presta (hoy, mi esposa): casa, casamiento, boda… */
export function DebtsPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const balances = useQuery({ queryKey: ['accounts'], queryFn: () => get<Balance[]>('/api/accounts') });
  const debts = (balances.data ?? []).filter((a) => a.type === 'debt' && !a.archived);
  const [sel, setSel] = useState('');
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (!sel && debts.length) setSel(debts[0].accountId);
  }, [debts.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const groups = new Map<string, Balance[]>();
  for (const d of debts) {
    const who = d.counterparty?.trim() || NO_LENDER;
    groups.set(who, [...(groups.get(who) ?? []), d]);
  }
  // Neto: las devoluciones (saldo a favor) restan de lo adeudado, igual que el resumen del Excel.
  const netOf = (list: Balance[]) => -list.reduce((s, a) => s + a.balance, 0);
  const total = netOf(debts);

  return (
    <div className="flex flex-col gap-8 pb-10">
      <div className="page-head !mb-0">
        <div className="max-w-2xl">
          <h1>Deudas personales</h1>
          <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">Lo que le debes a quien te presta. Cada deuda tiene su historial de cargos y pagos.</p>
        </div>
        <Button onClick={() => setCreating(true)}><Plus /> Nueva deuda</Button>
      </div>

      <div className="grid-cards !mb-0">
        <Kpi label="Total que debes" value={<Money v={total} />} tone={total > 0 ? 'neg' : 'pos'} sub={`${debts.filter((a) => a.owed > 0).length} deudas con saldo`} />
        {[...groups].map(([who, list]) => (
          <Kpi key={who} label={`Le debo a ${who}`} value={<Money v={netOf(list)} />} tone={netOf(list) > 0 ? 'neg' : 'pos'} sub={`${list.length} deuda${list.length === 1 ? '' : 's'}`} />
        ))}
      </div>

      {[...groups].map(([who, list]) => (
        <section key={who} className="flex flex-col gap-4" aria-label={`Deudas con ${who}`}>
          <div>
            <h2 className="!mb-0 text-lg">Quién me presta: {who}</h2>
            <p className="text-sm text-muted-foreground">{list.length} deuda{list.length === 1 ? '' : 's'} · debes {money(netOf(list))}</p>
          </div>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {list.map((a) => (
              <button
                key={a.accountId}
                type="button"
                onClick={() => setSel(a.accountId)}
                aria-pressed={sel === a.accountId}
                className={cn('rounded-2xl border bg-card p-5 text-left shadow-sm transition-all hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring', sel === a.accountId && 'border-primary ring-2 ring-primary/30')}
              >
                <div className="flex items-center gap-2 text-sm font-medium"><HandCoins className="size-4 text-muted-foreground" /> {a.name}</div>
                <div className="num mt-4 text-2xl font-semibold tracking-tight">
                  {a.balance > 0 ? <span className="pos">{money(a.balance)} a favor</span> : <Money v={a.owed} />}
                </div>
                <div className="mt-1 text-xs text-muted-foreground">{a.balance > 0 ? 'Saldo a tu favor' : 'Debes'}</div>
              </button>
            ))}
          </div>
        </section>
      ))}
      {!debts.length && !balances.isLoading && <div className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">Sin deudas cargadas. Crea una con “Nueva deuda”.</div>}

      {sel && debts.some((d) => d.accountId === sel) && (
        <section className="rounded-2xl border bg-card p-6 shadow-sm" aria-label="Historial de la deuda">
          <LedgerView key={sel} accountId={sel} labels={DEBT_LABELS} onChanged={() => qc.invalidateQueries({ queryKey: ['accounts'] })} onError={toast.error} />
        </section>
      )}

      <NewDebt open={creating} onOpenChange={setCreating} lenders={[...groups.keys()].filter((w) => w !== NO_LENDER)} onDone={(id) => { setSel(id); qc.invalidateQueries({ queryKey: ['accounts'] }); }} />
    </div>
  );
}

function NewDebt({ open, onOpenChange, lenders, onDone }: { open: boolean; onOpenChange: (o: boolean) => void; lenders: string[]; onDone: (id: string) => void }) {
  const toast = useToast();
  const [name, setName] = useState('');
  const [who, setWho] = useState('Esposa');
  async function submit(e: FormEvent) {
    e.preventDefault();
    try {
      const a = await post('/api/accounts', { type: 'debt', name, counterparty: who.trim() || null });
      setName('');
      onDone(a.id);
      onOpenChange(false);
    } catch (err) { toast.error(err); }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Nueva deuda</DialogTitle>
          <DialogDescription>Después cargas los cargos y pagos en su historial.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="grid gap-4">
          <Field label="Nombre de la deuda"><Input value={name} onChange={(e) => setName(e.target.value)} required aria-label="Nombre de la deuda" /></Field>
          <Field label="Quién me presta">
            <Input value={who} onChange={(e) => setWho(e.target.value)} list="lenders" aria-label="Quién me presta" />
            <datalist id="lenders">{[...new Set(['Esposa', ...lenders])].map((l) => <option key={l} value={l} />)}</datalist>
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancelar</Button>
            <Button type="submit">Crear</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
