import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRightLeft, CreditCard, HandCoins, Lock, LockOpen, Pencil, PiggyBank, Plus, ShoppingBag, Wallet } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { get, post, put } from '../../app/api';
import type { Balance, SavingsBucket } from '../../app/types';
import { Combobox } from '../../components/Combobox';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../../components/ui/dialog';
import { Input } from '../../components/ui/input';
import { Field } from '../../components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../components/ui/tabs';
import { Bar, Kpi, Money, money, today, useToast } from '../../components/ui';
import { AccountForm, Empty, StatementView } from '../accounts/AccountsPage';
import { TransferDialog, type TransferMode } from '../accounts/TransferDialog';
import { LedgerView, type LedgerLabels } from '../loans/LedgerView';
import { PersonCard, SavingsMovements } from './SavingsMovements';
import type { SavingsMove, SavingsOverview, SavingsPerson } from '../../app/types';

const ALL_KEYS = ['accounts', 'statement', 'ledger', 'savings-overview', 'buckets', 'transactions', 'health'];
const CARD_LABELS: LedgerLabels = { plus: 'Pago o abono (libera cupo)', minus: 'Compra o cargo (usa cupo)', grid: 'Movimientos de la tarjeta' };
const SAVINGS_LABELS: LedgerLabels = { plus: 'Aporte (suma)', minus: 'Retiro (resta)', grid: 'Aportes del ahorro' };

interface TransferState { open: boolean; mode: TransferMode; from?: string; to?: string }

/** Estado y diálogos compartidos por las páginas de Tarjetas y de Ahorro. */
function useKit() {
  const qc = useQueryClient();
  const accounts = useQuery({ queryKey: ['accounts'], queryFn: () => get<Balance[]>('/api/accounts') });
  const [transfer, setTransfer] = useState<TransferState>({ open: false, mode: 'transfer' });
  const [creating, setCreating] = useState<'card' | 'savings' | 'receivable' | null>(null);
  const [editing, setEditing] = useState<Balance | null>(null);
  const list = (accounts.data ?? []).filter((a) => !a.archived);
  const refresh = () => Promise.all(ALL_KEYS.map((k) => qc.invalidateQueries({ queryKey: [k] })));
  const openTransfer = (t: Omit<TransferState, 'open'>) => setTransfer({ open: true, ...t });
  const dialogs = (
    <>
      <TransferDialog open={transfer.open} onOpenChange={(o) => setTransfer((t) => ({ ...t, open: o }))} accounts={accounts.data ?? []} initialMode={transfer.mode} initialFrom={transfer.from} initialTo={transfer.to} />
      <AccountForm open={!!creating} onOpenChange={(o) => !o && setCreating(null)} types={[creating ?? 'card']} />
      <AccountForm open={!!editing} onOpenChange={(o) => !o && setEditing(null)} account={editing ?? undefined} />
    </>
  );
  return { list, refresh, openTransfer, setCreating, setEditing, dialogs };
}

/** Tarjetas de crédito: cupo, compras y pagos. */
export function CardsPage() {
  const k = useKit();
  const [charging, setCharging] = useState<Balance | null>(null);
  const cards = k.list.filter((a) => a.type === 'card');
  const cardDebt = cards.reduce((s, a) => s + a.owed, 0);
  const cardLimit = cards.reduce((s, a) => s + (a.creditLimit ?? 0), 0);
  const cardAvail = cards.reduce((s, a) => s + a.balance, 0);

  return (
    <div className="flex flex-col gap-8 pb-10">
      <div className="page-head !mb-0">
        <div className="max-w-2xl">
          <h1>Tarjetas</h1>
          <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">Carga tus compras con tarjeta, mira cuánto cupo te queda y paga lo que debes.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => k.openTransfer({ mode: 'transfer' })}><ArrowRightLeft /> Transferir</Button>
          <Button onClick={() => k.setCreating('card')}><Plus /> Nueva tarjeta</Button>
        </div>
      </div>
      <div className="grid-cards !mb-0">
        <Kpi label="Deuda de tarjetas" value={<Money v={cardDebt} />} tone={cardDebt > 0 ? 'neg' : undefined} sub="Lo que debes hoy" />
        <Kpi label="Cupo disponible" value={<Money v={cardAvail} />} tone="pos" sub={cardLimit ? `de ${money(cardLimit)} en total` : undefined} />
      </div>
      {cards.length ? (
        <CardsSection cards={cards} onCharge={setCharging} onPay={(a) => k.openTransfer({ mode: 'transfer', to: a.accountId })} onEdit={k.setEditing} onChanged={k.refresh} />
      ) : <Empty>No tienes tarjetas cargadas. Crea una con “Nueva tarjeta”.</Empty>}
      <ChargeDialog card={charging} onClose={() => setCharging(null)} onDone={k.refresh} />
      {k.dialogs}
    </div>
  );
}

/** Ahorros por objetivo (con lo intocable separado de lo que se puede usar) y lo que me deben de él. */
export function SavingsPage() {
  const k = useKit();
  const savings = k.list.filter((a) => a.type === 'savings');
  const debtors = k.list.filter((a) => a.type === 'receivable');
  const overview = useQuery({ queryKey: ['savings-overview', savings[0]?.accountId], enabled: !!savings[0], queryFn: () => get<SavingsOverview>(`/api/accounts/${savings[0].accountId}/savings-overview`) });
  const owing = (overview.data?.people ?? []).filter((p) => p.pending !== 0);
  const total = savings.reduce((s, a) => s + a.balance, 0);
  const locked = savings.reduce((s, a) => s + a.untouchable, 0);
  const free = savings.reduce((s, a) => s + a.touchable, 0);
  const lent = savings.reduce((s, a) => s + a.loansPending, 0);
  const owedToMe = debtors.reduce((s, a) => s + a.balance, 0) + owing.reduce((s, p) => s + p.pending, 0);
  const peopleCount = debtors.length + owing.length;

  return (
    <div className="flex flex-col gap-8 pb-10">
      <div className="page-head !mb-0">
        <div className="max-w-2xl">
          <h1>Ahorro</h1>
          <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">Organiza tus ahorros por objetivo. Lo intocable queda separado de lo que sí puedes usar.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => k.openTransfer({ mode: 'transfer' })}><ArrowRightLeft /> Transferir</Button>
          <Button onClick={() => k.setCreating('savings')}><Plus /> Nuevo ahorro</Button>
        </div>
      </div>
      <div className="grid-cards !mb-0">
        <Kpi label="Ahorros totales" value={<Money v={total} />} tone="pos" />
        <Kpi label="Monto intocable" value={<Money v={locked} />} sub="Aguinaldo, vacaciones y otros marcados" />
        <Kpi label="Saldo que puedo tocar" value={<Money v={free} signed />} tone={free < 0 ? 'neg' : 'pos'} sub={free < 0 ? 'Ya usaste parte de lo intocable' : 'Ahorros − intocable'} />
        <Kpi label="Prestado del ahorro" value={<Money v={lent} />} tone={lent > 0 ? 'neg' : undefined} sub={lent > 0 ? 'Pendiente de devolver' : 'Nada pendiente'} />
        {peopleCount > 0 && <Kpi label="Me deben de mi ahorro" value={<Money v={owedToMe} />} tone={owedToMe > 0 ? 'neg' : 'pos'} sub={`${peopleCount} persona${peopleCount === 1 ? '' : 's'}`} />}
      </div>
      {savings.map((a) => (
        <SavingsPanel key={a.accountId} a={a} onChanged={k.refresh} onEdit={() => k.setEditing(a)}
          onSave={() => k.openTransfer({ mode: 'saving' })}
          onLoan={() => k.openTransfer({ mode: 'loan', from: a.accountId })}
          onRepay={() => k.openTransfer({ mode: 'repay' })} />
      ))}
      {!savings.length && <Empty>Crea una cuenta de ahorro para empezar.</Empty>}
      <DebtorsSection debtors={debtors} owing={owing} moves={overview.data?.moves ?? []} hasSavings={savings.length > 0}
        onAdd={() => k.setCreating('receivable')}
        onLend={(d) => k.openTransfer({ mode: 'loan', from: savings[0]?.accountId, to: d?.accountId })}
        onCollect={(d) => k.openTransfer({ mode: 'transfer', from: d.accountId })}
        onReturn={() => k.openTransfer({ mode: 'repay' })}
        onRepayDirect={(d) => k.openTransfer({ mode: 'repay', from: d.accountId })}
        onEdit={k.setEditing} />
      {k.dialogs}
    </div>
  );
}

// ── Tarjetas ──
function CardsSection({ cards, onCharge, onPay, onEdit, onChanged }: {
  cards: Balance[]; onCharge: (a: Balance) => void; onPay: (a: Balance) => void; onEdit: (a: Balance) => void; onChanged: () => unknown;
}) {
  const toast = useToast();
  const [selId, setSelId] = useState(cards[0].accountId);
  const sel = cards.find((c) => c.accountId === selId) ?? cards[0];
  return (
    <div className="flex flex-col gap-6">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {cards.map((a) => {
          const pct = a.creditLimit ? (a.owed / a.creditLimit) * 100 : 0;
          const on = a.accountId === sel.accountId;
          return (
            <button
              type="button"
              key={a.accountId}
              aria-label={`Abrir ${a.name}`}
              aria-pressed={on}
              onClick={() => setSelId(a.accountId)}
              className={`rounded-2xl border bg-card p-5 text-left shadow-sm transition-all hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${on ? 'border-primary ring-2 ring-primary/30' : ''}`}
            >
              <div className="flex items-center gap-2 text-sm font-medium"><CreditCard className="size-4 text-muted-foreground" /><span className="truncate">{a.name}</span></div>
              <div className="mt-4 text-xs text-muted-foreground">Disponible</div>
              <div className="num text-2xl font-semibold tracking-tight"><Money v={a.balance} /></div>
              <div className="mb-2 mt-3 flex justify-between text-xs text-muted-foreground">
                <span>Debes <b className="neg">{money(a.owed)}</b></span><span>Cupo {money(a.creditLimit)}</span>
              </div>
              <Bar pct={pct} />
            </button>
          );
        })}
      </div>

      <section className="rounded-2xl border bg-card p-6 shadow-sm" aria-label={`Panel de ${sel.name}`}>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 className="!mb-1 text-lg">{sel.name}</h2>
            <p className="text-sm text-muted-foreground">Debes <b className="neg">{money(sel.owed)}</b> · disponible <b>{money(sel.balance)}</b> de {money(sel.creditLimit)}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => onCharge(sel)}><ShoppingBag /> Cargar compra</Button>
            <Button variant="outline" onClick={() => onPay(sel)}><Wallet /> Pagar tarjeta</Button>
            <Button variant="ghost" onClick={() => onEdit(sel)}><Pencil /> Editar</Button>
          </div>
        </div>
        <Tabs defaultValue="mov" className="mt-6">
          <TabsList>
            <TabsTrigger value="mov">Movimientos</TabsTrigger>
            <TabsTrigger value="rel">Relatorio</TabsTrigger>
          </TabsList>
          <TabsContent value="mov" className="!mt-5">
            <LedgerView key={sel.accountId} accountId={sel.accountId} labels={CARD_LABELS} onChanged={onChanged} onError={toast.error} />
          </TabsContent>
          <TabsContent value="rel" className="!mt-5">
            <StatementView accounts={[sel]} accountId={sel.accountId} onAccount={() => undefined} asOf={today()} />
          </TabsContent>
        </Tabs>
      </section>
    </div>
  );
}

function ChargeDialog({ card, onClose, onDone }: { card: Balance | null; onClose: () => void; onDone: () => unknown }) {
  const toast = useToast();
  const [amount, setAmount] = useState('');
  const [concept, setConcept] = useState('');
  const [date, setDate] = useState(today());
  const [busy, setBusy] = useState(false);
  const n = Number(amount.replace(/[.\s]/g, '').replace(',', '.'));
  const after = card && Number.isFinite(n) && n > 0 ? card.balance - n : null;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!card) return;
    setBusy(true);
    try {
      await post(`/api/accounts/${card.accountId}/entries`, { date, concept, rawAmount: `=-(${amount.trim().replace(/^=/, '')})` });
      await onDone();
      toast.ok(`Compra cargada a ${card.name}`);
      setAmount(''); setConcept(''); setDate(today());
      onClose();
    } catch (err) { toast.error(err); } finally { setBusy(false); }
  }

  return (
    <Dialog open={!!card} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><ShoppingBag className="size-5" /> Cargar compra</DialogTitle>
          <DialogDescription>Registra un gasto hecho con {card?.name}. Usa cupo y sube tu deuda.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="grid gap-5" aria-label="Cargar compra a la tarjeta">
          <Field label="Monto"><Input autoFocus className="num h-12 text-right text-xl" placeholder="0" value={amount} onChange={(e) => setAmount(e.target.value)} required aria-label="Monto de la compra" /></Field>
          <Field label="Concepto"><Input value={concept} onChange={(e) => setConcept(e.target.value)} placeholder="Supermercado, nafta, farmacia…" required aria-label="Concepto de la compra" /></Field>
          <Field label="Fecha"><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} required aria-label="Fecha de la compra" /></Field>
          {card && (
            <div className="rounded-lg bg-muted/60 p-3 text-sm">
              Disponible hoy <b>{money(card.balance)}</b>{after !== null && <> → después <b className={after < 0 ? 'neg' : ''}>{money(after)}</b></>}
            </div>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>Cancelar</Button>
            <Button type="submit" disabled={busy}>Cargar compra</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ── Personas a las que presté del ahorro ──
function DebtorsSection({ debtors, owing, moves, hasSavings, onAdd, onLend, onCollect, onReturn, onRepayDirect, onEdit }: {
  debtors: Balance[]; owing: SavingsPerson[]; moves: SavingsMove[]; hasSavings: boolean; onAdd: () => void; onLend: (d?: Balance) => void; onCollect: (d: Balance) => void;
  onReturn: () => void; onRepayDirect: (d: Balance) => void; onEdit: (d: Balance) => void;
}) {
  return (
    <section className="rounded-2xl border bg-card p-6 shadow-sm" aria-label="Me deben de mi ahorro">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="max-w-2xl">
          <h2 className="!mb-1 flex items-center gap-2 text-lg"><HandCoins className="size-5" /> Me deben de mi ahorro</h2>
          <p className="text-sm leading-relaxed text-muted-foreground">
            Cuando le prestas a alguien (Charlie, Osky, Amor…) el dinero sale de tu ahorro y queda como deuda de esa persona.
            Cuando te paga, regístralo con <b>Recibí un pago</b>: entra a tu banco. Después usa <b>Devolver al ahorro</b> para reponer el objetivo.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={onAdd}><Plus /> Nueva persona</Button>
          {hasSavings && debtors.length > 0 && <Button variant="outline" onClick={onReturn}>Devolver al ahorro</Button>}
        </div>
      </div>
      {owing.length > 0 && (
        <ul className="mt-6 grid gap-4 md:grid-cols-2 xl:grid-cols-3" aria-label="Préstamos pendientes por persona">
          {owing.map((p) => <PersonCard key={p.person ?? '__normal'} p={p} moves={moves} />)}
        </ul>
      )}
      {debtors.length ? (
        <ul className="mt-6 grid gap-4 md:grid-cols-2 xl:grid-cols-3" aria-label="Personas que me deben">
          {debtors.map((d) => (
            <li key={d.accountId} className="rounded-xl border p-4">
              <div className="flex items-start justify-between gap-2">
                <div className="font-medium">{d.name}</div>
                <Button size="sm" variant="ghost" aria-label={`Editar ${d.name}`} onClick={() => onEdit(d)}><Pencil /></Button>
              </div>
              <div className="mt-1 text-xs text-muted-foreground">Me debe</div>
              <div className={`num mb-4 text-2xl font-semibold ${d.owed > 0 ? 'neg' : ''}`}>{money(d.owed)}</div>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" onClick={() => onCollect(d)} disabled={d.owed <= 0}>Recibí un pago</Button>
                <Button size="sm" variant="outline" onClick={() => onLend(d)} disabled={!hasSavings}>Prestarle</Button>
                <Button size="sm" variant="ghost" onClick={() => onRepayDirect(d)} disabled={d.owed <= 0} title="Me pagó directo a mi ahorro">Pagó al ahorro</Button>
              </div>
            </li>
          ))}
        </ul>
      ) : owing.length ? null : (
        <div className="mt-6 rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">
          Nadie te debe de tu ahorro. Agrega a la persona con “Nueva persona” y luego usa “Prestarle”.
        </div>
      )}
    </section>
  );
}

// ── Ahorro ──
function SavingsPanel({ a, onChanged, onEdit, onSave, onLoan, onRepay }: {
  a: Balance; onChanged: () => unknown; onEdit: () => void; onSave: () => void; onLoan: () => void; onRepay: () => void;
}) {
  const toast = useToast();
  const defs = useQuery({ queryKey: ['buckets'], queryFn: () => get<SavingsBucket[]>('/api/buckets') });
  const [newName, setNewName] = useState('');
  const [assign, setAssign] = useState('');
  const lockedOf = new Map((defs.data ?? []).map((b) => [b.name, b.untouchable]));
  const names = [...new Set([...(defs.data ?? []).map((b) => b.name), ...a.buckets.map((b) => b.bucket)])];
  const balanceOf = (n: string) => a.buckets.find((b) => b.bucket === n)?.balance ?? 0;
  const rows = names.map((n) => ({ name: n, balance: balanceOf(n), untouchable: lockedOf.get(n) ?? false, loose: n === 'Sin asignar' }));
  const max = Math.max(1, ...rows.map((r) => Math.abs(r.balance)));
  const unassigned = a.buckets.find((b) => b.bucket === 'Sin asignar');

  async function setLock(name: string, untouchable: boolean) {
    try { await put('/api/buckets', { name, untouchable }); await onChanged(); } catch (e) { toast.error(e); }
  }
  async function addBucket(e: FormEvent) {
    e.preventDefault();
    if (!newName.trim()) return;
    try { await put('/api/buckets', { name: newName.trim(), untouchable: false }); setNewName(''); await onChanged(); } catch (err) { toast.error(err); }
  }

  return (
    <section className="rounded-2xl border bg-card p-6 shadow-sm" aria-label={`Ahorro ${a.name}`}>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="!mb-1 flex items-center gap-2 text-lg"><PiggyBank className="size-5" /> {a.name}</h2>
          <p className="text-sm text-muted-foreground">{[a.institution, a.alias ? `alias ${a.alias}` : null].filter(Boolean).join(' · ') || 'Cuenta de ahorro'}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button onClick={onSave}>Pasar a ahorro</Button>
          <Button variant="outline" onClick={onLoan}>Prestar</Button>
          <Button variant="outline" onClick={onRepay}>Devolver</Button>
          <Button variant="ghost" onClick={onEdit}><Pencil /> Editar</Button>
        </div>
      </div>

      <div className="mt-6 grid gap-4 sm:grid-cols-3" aria-label={`Resumen de ${a.name}`}>
        <div className="rounded-xl bg-muted/50 p-4"><div className="text-xs text-muted-foreground">Saldo actual</div><div className="num mt-1 text-2xl font-semibold" aria-label={`Saldo de ${a.name}`}>{money(a.balance)}</div></div>
        <div className="rounded-xl bg-muted/50 p-4"><div className="text-xs text-muted-foreground">Intocable</div><div className="num mt-1 text-2xl font-semibold">{money(a.untouchable)}</div></div>
        <div className="rounded-xl bg-muted/50 p-4"><div className="text-xs text-muted-foreground">Puedo tocar</div><div className={`num mt-1 text-2xl font-semibold ${a.touchable < 0 ? 'neg' : ''}`}>{money(a.touchable)}</div></div>
      </div>
      {a.loansPending > 0 && <p className="mt-3 text-sm text-amber-700 dark:text-amber-300">Prestado y pendiente de devolver: <b>{money(a.loansPending)}</b></p>}

      <Tabs defaultValue="objetivos" className="mt-8">
        <TabsList>
          <TabsTrigger value="objetivos">Objetivos</TabsTrigger>
          <TabsTrigger value="mov">Movimientos</TabsTrigger>
          <TabsTrigger value="edit">Agregar o editar</TabsTrigger>
          <TabsTrigger value="rel">Relatorio</TabsTrigger>
        </TabsList>

        <TabsContent value="objetivos" className="!mt-6 flex flex-col gap-5">
          <ul className="grid gap-4 md:grid-cols-2 xl:grid-cols-3" aria-label={`Objetivos de ${a.name}`}>
            {rows.map((r) => (
              <li key={r.name} className="rounded-xl border p-4">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className={`truncate text-sm font-medium ${r.loose ? 'text-amber-700 dark:text-amber-300' : ''}`}>{r.loose && r.balance < 0 ? 'Retiros temporales por reponer' : r.name}</div>
                    {r.untouchable && <Badge variant="warn" className="mt-1"><Lock className="size-3" /> Intocable</Badge>}
                  </div>
                  {!r.loose && (
                    <Button size="sm" variant="ghost" aria-label={r.untouchable ? `Marcar ${r.name} como tocable` : `Marcar ${r.name} como intocable`} onClick={() => setLock(r.name, !r.untouchable)}>
                      {r.untouchable ? <><LockOpen /> Liberar</> : <><Lock /> Hacer intocable</>}
                    </Button>
                  )}
                </div>
                <div className="num mb-3 mt-3 text-xl font-semibold">{money(r.balance)}</div>
                <Bar pct={(Math.abs(r.balance) / max) * 100} />
              </li>
            ))}
          </ul>

          <form className="flex flex-wrap items-center gap-3" onSubmit={addBucket} aria-label="Nuevo objetivo">
            <Input className="w-72" placeholder="Nuevo objetivo (p. ej. Moto)" value={newName} onChange={(e) => setNewName(e.target.value)} aria-label="Nombre del objetivo" />
            <Button type="submit" variant="outline"><Plus /> Agregar objetivo</Button>
          </form>

          {unassigned && unassigned.balance > 0 && (
            <div className="flex flex-wrap items-center gap-3 rounded-xl bg-amber-50 p-4 dark:bg-amber-950/40">
              <span className="text-sm">Hay {money(unassigned.balance)} sin objetivo. Asignar a:</span>
              <div className="w-44">
                <Combobox ariaLabel="Objetivo para lo sin asignar" value={assign} onChange={setAssign} options={names.filter((n) => n !== 'Sin asignar').map((n) => ({ value: n, label: n }))} placeholder="Elegir…" onCreate={(n) => setAssign(n)} />
              </div>
              <Button disabled={!assign} onClick={async () => {
                try { await post(`/api/accounts/${a.accountId}/assign-bucket`, { bucket: assign }); toast.ok('Objetivo asignado'); await onChanged(); } catch (e) { toast.error(e); }
              }}>Aplicar</Button>
            </div>
          )}
        </TabsContent>

        <TabsContent value="mov" className="!mt-6">
          <SavingsMovements accountId={a.accountId} />
        </TabsContent>
        <TabsContent value="edit" className="!mt-6">
          <LedgerView accountId={a.accountId} labels={SAVINGS_LABELS} showBucket onChanged={onChanged} onError={toast.error} />
        </TabsContent>
        <TabsContent value="rel" className="!mt-6">
          <StatementView accounts={[a]} accountId={a.accountId} onAccount={() => undefined} asOf={today()} />
        </TabsContent>
      </Tabs>
    </section>
  );
}
