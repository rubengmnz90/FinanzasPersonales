import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Pencil, Plus, Trash2, Undo2 } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { del, get, patch, post } from '../../app/api';
import type { Balance, Installment, Loan } from '../../app/types';
import { Combobox } from '../../components/Combobox';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../../components/ui/dialog';
import { Input } from '../../components/ui/input';
import { Field } from '../../components/ui/label';
import { Bar, Kpi, Money, money, today, useToast } from '../../components/ui';

const num = (v: string) => Number(v.replace(/[^\d]/g, '')) || 0;

/** Préstamos con cuotas (Coomecipar, equipos de Vibra Lejana, nuevos): marcar pagadas y proyectar las pendientes. */
export function FormalLoans() {
  const qc = useQueryClient();
  const toast = useToast();
  const loans = useQuery({ queryKey: ['loans'], queryFn: () => get<Loan[]>('/api/loans') });
  const accounts = useQuery({ queryKey: ['accounts'], queryFn: () => get<Balance[]>('/api/accounts') });
  const [creating, setCreating] = useState(false);
  const [paying, setPaying] = useState<{ loan: Loan; inst: Installment } | null>(null);
  const [editing, setEditing] = useState<{ loan: Loan; inst?: Installment } | null>(null);
  const [settings, setSettings] = useState<Loan | null>(null);

  const list = loans.data ?? [];
  const refresh = () => Promise.all(['loans', 'accounts', 'transactions', 'ledger', 'planned', 'plan', 'health'].map((k) => qc.invalidateQueries({ queryKey: [k] })));
  const act = async (fn: () => Promise<unknown>, ok?: string) => {
    try { await fn(); await refresh(); if (ok) toast.ok(ok); } catch (e) { toast.error(e); }
  };

  const pending = list.reduce((s, l) => s + l.pendingTotal, 0);
  const next = list.flatMap((l) => l.installments.filter((i) => !i.paid).slice(0, 1).map((i) => ({ l, i }))).sort((a, b) => (a.i.dueDate < b.i.dueDate ? -1 : 1))[0];

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-wrap items-center justify-end gap-3">
        <Button onClick={() => setCreating(true)}><Plus /> Nuevo préstamo</Button>
      </div>

      <div className="grid-cards !mb-0">
        <Kpi label="Cuotas pendientes" value={<Money v={pending} />} tone={pending > 0 ? 'neg' : 'pos'} sub={`${list.reduce((s, l) => s + l.pendingCount, 0)} cuotas`} />
        <Kpi label="Próximo vencimiento" value={next ? next.i.dueDate : '—'} sub={next ? `${next.l.name} · ${money(next.i.amount)}` : 'Sin cuotas pendientes'} />
      </div>

      {list.map((l) => {
        const total = l.paidCount + l.pendingCount;
        return (
          <section key={l.id} className="rounded-2xl border bg-card p-6 shadow-sm" aria-label={`Préstamo ${l.name}`}>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="!mb-1 flex items-center gap-2 text-lg">{l.name}
                  {l.inProjection ? <Badge variant="ok">En la proyección</Badge> : <Badge variant="info">Fuera de la proyección</Badge>}
                </h2>
                <p className="text-sm text-muted-foreground">
                  {[l.lender, l.principal ? `préstamo de ${money(l.principal)}` : null, `cuota ${money(l.installmentAmount)}`].filter(Boolean).join(' · ')}
                </p>
                {l.note && <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">{l.note}</p>}
              </div>
              <div className="flex gap-2">
                <Button size="sm" variant="outline" onClick={() => setEditing({ loan: l })}><Plus /> Agregar cuota</Button>
                <Button size="sm" variant="ghost" aria-label={`Ajustes de ${l.name}`} onClick={() => setSettings(l)}><Pencil /></Button>
              </div>
            </div>
            <div className="my-6">
              <div className="mb-1 flex justify-between text-sm"><span>{l.paidCount} de {total} cuotas pagadas</span><span className="num">{money(l.paidTotal)} pagado · {money(l.pendingTotal)} pendiente</span></div>
              <Bar pct={total ? (l.paidCount / total) * 100 : 0} />
            </div>
            <div className="overflow-x-auto">
              <table className="simple">
                <thead><tr><th>N°</th><th>Vence</th><th className="r">Monto</th><th>Estado</th><th aria-label="Acciones" /></tr></thead>
                <tbody>
                  {l.installments.map((i) => (
                    <tr key={i.id}>
                      <td className="num">{i.number}</td>
                      <td className="num whitespace-nowrap">{i.dueDate}</td>
                      <td className="r num">{money(i.amount)}</td>
                      <td>{i.paid ? <Badge variant="ok">Pagada {i.paidDate}</Badge> : i.dueDate < today() ? <Badge variant="bad">Vencida</Badge> : <Badge variant="info">Pendiente</Badge>}</td>
                      <td className="whitespace-nowrap text-right">
                        {i.paid ? (
                          <Button size="sm" variant="ghost" aria-label={`Deshacer pago cuota ${i.number} de ${l.name}`} onClick={() => act(() => post(`/api/installments/${i.id}/unpay`), 'Pago deshecho')}><Undo2 /> Deshacer</Button>
                        ) : (
                          <>
                            <Button size="sm" variant="outline" aria-label={`Marcar pagada cuota ${i.number} de ${l.name}`} onClick={() => setPaying({ loan: l, inst: i })}><Check /> Marcar pagada</Button>
                            <Button size="sm" variant="ghost" aria-label={`Editar cuota ${i.number} de ${l.name}`} onClick={() => setEditing({ loan: l, inst: i })}><Pencil /></Button>
                          </>
                        )}
                        <Button size="sm" variant="ghost" aria-label={`Eliminar cuota ${i.number} de ${l.name}`} onClick={() => confirm(`¿Eliminar la cuota ${i.number}?`) && act(() => del(`/api/installments/${i.id}`))}><Trash2 /></Button>
                      </td>
                    </tr>
                  ))}
                  {!l.installments.length && <tr><td colSpan={5} className="empty">Sin cuotas todavía.</td></tr>}
                </tbody>
              </table>
            </div>
          </section>
        );
      })}
      {!list.length && !loans.isLoading && <div className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">Sin préstamos cargados.</div>}

      <NewLoan open={creating} onOpenChange={setCreating} accounts={accounts.data ?? []} onDone={refresh} />
      <PayDialog target={paying} onClose={() => setPaying(null)} accounts={accounts.data ?? []} onDone={refresh} />
      <InstallmentDialog target={editing} onClose={() => setEditing(null)} onDone={refresh} />
      <LoanSettings loan={settings} onClose={() => setSettings(null)} onDone={refresh} onDelete={(l) => act(() => del(`/api/loans/${l.id}`), 'Préstamo eliminado')} />
    </div>
  );
}

function NewLoan({ open, onOpenChange, accounts, onDone }: { open: boolean; onOpenChange: (o: boolean) => void; accounts: Balance[]; onDone: () => unknown }) {
  const toast = useToast();
  const [name, setName] = useState('');
  const [lender, setLender] = useState('');
  const [principal, setPrincipal] = useState('');
  const [amount, setAmount] = useState('');
  const [count, setCount] = useState('12');
  const [first, setFirst] = useState(today());
  const [inProjection, setInProjection] = useState(true);
  const [pay, setPay] = useState('');
  useEffect(() => { if (open) { setName(''); setLender(''); setPrincipal(''); setAmount(''); setCount('12'); setFirst(today()); setInProjection(true); setPay(''); } }, [open]);
  async function submit(e: FormEvent) {
    e.preventDefault();
    try {
      await post('/api/loans', {
        name, lender: lender || null, principal: num(principal), installmentAmount: num(amount), installments: num(count), firstDue: first,
        inProjection, payAccountId: pay || null,
      });
      await onDone();
      toast.ok('Préstamo creado');
      onOpenChange(false);
    } catch (err) { toast.error(err); }
  }
  const flow = accounts.filter((a) => a.inFlow && !a.archived);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Nuevo préstamo</DialogTitle>
          <DialogDescription>Cuotas iguales y mensuales. Si lo dejas en la proyección, las cuotas pendientes se suman a los gastos de cada mes. (Para préstamos que amortizan distinto, crea la primera cuota y agrega las demás a mano.)</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="grid gap-3" aria-label="Nuevo préstamo">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Nombre"><Input value={name} onChange={(e) => setName(e.target.value)} required aria-label="Nombre del préstamo" /></Field>
            <Field label="Prestamista"><Input value={lender} onChange={(e) => setLender(e.target.value)} aria-label="Prestamista" /></Field>
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Monto prestado"><Input className="num text-right" value={principal} onChange={(e) => setPrincipal(e.target.value)} aria-label="Monto prestado" /></Field>
            <Field label="Cuota"><Input className="num text-right" value={amount} onChange={(e) => setAmount(e.target.value)} required aria-label="Monto de la cuota" /></Field>
            <Field label="Cuotas"><Input className="num text-right" value={count} onChange={(e) => setCount(e.target.value)} required aria-label="Cantidad de cuotas" /></Field>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Primer vencimiento"><Input type="date" value={first} onChange={(e) => setFirst(e.target.value)} required aria-label="Primer vencimiento" /></Field>
            <Field label="Se paga desde"><Combobox ariaLabel="Cuenta de pago" value={pay} onChange={setPay} allowClear options={flow.map((a) => ({ value: a.accountId, label: a.name }))} placeholder="Predeterminada" /></Field>
          </div>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={inProjection} onChange={(e) => setInProjection(e.target.checked)} /> Incluir en la proyección</label>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancelar</Button>
            <Button type="submit">Crear</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function PayDialog({ target, onClose, accounts, onDone }: { target: { loan: Loan; inst: Installment } | null; onClose: () => void; accounts: Balance[]; onDone: () => unknown }) {
  const toast = useToast();
  const [date, setDate] = useState(today());
  const [acct, setAcct] = useState('');
  const [record, setRecord] = useState(true);
  useEffect(() => { if (target) { setDate(today()); setAcct(target.loan.payAccountId ?? ''); setRecord(true); } }, [target]);
  if (!target) return null;
  const { loan, inst } = target;
  const fromBox = !!loan.ledgerAccountId;
  const flow = accounts.filter((a) => a.inFlow && !a.archived);
  async function submit(e: FormEvent) {
    e.preventDefault();
    try {
      await post(`/api/installments/${inst.id}/pay`, { date, accountId: acct || null, record });
      await onDone();
      toast.ok('Cuota marcada como pagada');
      onClose();
    } catch (err) { toast.error(err); }
  }
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Cuota {inst.number} de {loan.name}</DialogTitle>
          <DialogDescription>{money(inst.amount)} · vence {inst.dueDate}</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="grid gap-3" aria-label="Pagar cuota">
          <Field label="Fecha de pago"><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} required aria-label="Fecha de pago" /></Field>
          {record && !fromBox && (
            <Field label="Pagada desde"><Combobox ariaLabel="Cuenta desde la que se paga" value={acct} onChange={setAcct} allowClear options={flow.map((a) => ({ value: a.accountId, label: a.name }))} placeholder="Predeterminada" /></Field>
          )}
          {fromBox && record && <p className="text-sm text-muted-foreground">Se anota como egreso en la caja de este préstamo.</p>}
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={!record} onChange={(e) => setRecord(!e.target.checked)} /> Ya estaba registrada: solo marcar como pagada</label>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>Cancelar</Button>
            <Button type="submit">Marcar pagada</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function InstallmentDialog({ target, onClose, onDone }: { target: { loan: Loan; inst?: Installment } | null; onClose: () => void; onDone: () => unknown }) {
  const toast = useToast();
  const [date, setDate] = useState(today());
  const [amount, setAmount] = useState('');
  useEffect(() => { if (target) { setDate(target.inst?.dueDate ?? today()); setAmount(String(target.inst?.amount ?? target.loan.installmentAmount ?? '')); } }, [target]);
  if (!target) return null;
  const { loan, inst } = target;
  async function submit(e: FormEvent) {
    e.preventDefault();
    try {
      if (inst) await patch(`/api/installments/${inst.id}`, { dueDate: date, rawAmount: amount });
      else await post(`/api/loans/${loan.id}/installments`, { dueDate: date, rawAmount: amount });
      await onDone();
      onClose();
    } catch (err) { toast.error(err); }
  }
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{inst ? `Editar cuota ${inst.number}` : 'Agregar cuota'} · {loan.name}</DialogTitle>
          <DialogDescription>Útil cuando el banco te avisa una cuota distinta (amortización).</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="grid gap-3" aria-label="Cuota">
          <Field label="Monto"><Input className="num text-right" value={amount} onChange={(e) => setAmount(e.target.value)} required aria-label="Monto de la cuota" /></Field>
          <Field label="Vencimiento"><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} required aria-label="Vencimiento" /></Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>Cancelar</Button>
            <Button type="submit">Guardar</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function LoanSettings({ loan, onClose, onDone, onDelete }: { loan: Loan | null; onClose: () => void; onDone: () => unknown; onDelete: (l: Loan) => unknown }) {
  const toast = useToast();
  const [name, setName] = useState('');
  const [lender, setLender] = useState('');
  const [principal, setPrincipal] = useState('');
  const [inProjection, setInProjection] = useState(false);
  useEffect(() => { if (loan) { setName(loan.name); setLender(loan.lender ?? ''); setPrincipal(String(loan.principal)); setInProjection(loan.inProjection); } }, [loan]);
  if (!loan) return null;
  async function submit(e: FormEvent) {
    e.preventDefault();
    try {
      await patch(`/api/loans/${loan!.id}`, { name, lender: lender || null, principal: num(principal), inProjection });
      await onDone();
      toast.ok('Préstamo actualizado');
      onClose();
    } catch (err) { toast.error(err); }
  }
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Ajustes de {loan.name}</DialogTitle>
          <DialogDescription>Con "en la proyección" las cuotas pendientes se suman a los gastos planeados de cada mes.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="grid gap-3" aria-label="Ajustes del préstamo">
          <Field label="Nombre"><Input value={name} onChange={(e) => setName(e.target.value)} required aria-label="Nombre del préstamo" /></Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Prestamista"><Input value={lender} onChange={(e) => setLender(e.target.value)} aria-label="Prestamista" /></Field>
            <Field label="Monto prestado"><Input className="num text-right" value={principal} onChange={(e) => setPrincipal(e.target.value)} aria-label="Monto prestado" /></Field>
          </div>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={inProjection} onChange={(e) => setInProjection(e.target.checked)} /> Incluir en la proyección</label>
          <DialogFooter className="sm:justify-between">
            <Button type="button" variant="ghost" className="text-rose-600" onClick={() => { if (confirm(`¿Eliminar el préstamo "${loan.name}" y sus cuotas?`)) { onDelete(loan); onClose(); } }}><Trash2 /> Eliminar</Button>
            <div className="flex gap-2">
              <Button type="button" variant="outline" onClick={onClose}>Cancelar</Button>
              <Button type="submit">Guardar</Button>
            </div>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
