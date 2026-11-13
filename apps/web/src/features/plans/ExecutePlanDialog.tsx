import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, Plus, Play, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { get, post, qs } from '../../app/api';
import type { Balance, ExecPreview, PlanView } from '../../app/types';
import { Combobox } from '../../components/Combobox';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../../components/ui/dialog';
import { Input, NativeSelect } from '../../components/ui/input';
import { Field } from '../../components/ui/label';
import { MONTH_NAMES, Money, money, useToast } from '../../components/ui';

interface Sel { on: boolean; accountId: string; amount: string }
interface Move { from: string; to: string; amount: string }

/** "Ejecutar plan": registra de una vez el honorario y los pagos de un cobro (quincena / fin de mes) y mueve plata entre cuentas. */
export function ExecutePlanDialog({ open, onOpenChange, view, periodId: initialPeriod }: { open: boolean; onOpenChange: (o: boolean) => void; view: PlanView; periodId?: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [periodId, setPeriodId] = useState('');
  const [month, setMonth] = useState(new Date().getMonth() + 1);
  const [sel, setSel] = useState<Record<string, Sel>>({});
  const [moves, setMoves] = useState<Move[]>([]);
  const [busy, setBusy] = useState(false);

  const accounts = useQuery({ queryKey: ['accounts'], queryFn: () => get<Balance[]>('/api/accounts'), enabled: open });
  const liquid = (accounts.data ?? []).filter((a) => ['bank', 'cash', 'card'].includes(a.type) && !a.archived);
  const moveOpts = (accounts.data ?? []).filter((a) => ['bank', 'cash'].includes(a.type) && !a.archived).map((a) => ({ value: a.accountId, label: a.name }));
  const defaultAcc = liquid.find((a) => a.isDefault)?.accountId ?? liquid[0]?.accountId ?? '';

  useEffect(() => {
    if (!open) return;
    setPeriodId(initialPeriod ?? view.periods[0]?.id ?? '');
    setMonth(view.plan.year === new Date().getFullYear() ? new Date().getMonth() + 1 : 1);
    setMoves([]);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const preview = useQuery({
    queryKey: ['execution', view.plan.id, periodId, month],
    enabled: open && !!periodId,
    queryFn: () => get<ExecPreview>(`/api/plans/${view.plan.id}/execution` + qs({ periodId, month })),
  });
  const p = preview.data;

  useEffect(() => {
    if (!p) return;
    setSel(Object.fromEntries(p.lines.map((l) => [l.key, { on: !l.executed, accountId: defaultAcc, amount: String(l.amount) }])));
  }, [p, defaultAcc]);

  const picked = useMemo(() => (p?.lines ?? []).filter((l) => sel[l.key]?.on && !l.executed), [p, sel]);
  const num = (v: string) => Number(String(v).replace(/[^\d]/g, '')) || 0;
  const income = picked.filter((l) => l.kind === 'income').reduce((s, l) => s + num(sel[l.key].amount), 0);
  const expense = picked.filter((l) => l.kind === 'expense').reduce((s, l) => s + num(sel[l.key].amount), 0);

  async function run() {
    if (!p) return;
    setBusy(true);
    try {
      const r = await post<{ created: number; skipped: number; transfers: number }>(`/api/plans/${view.plan.id}/execute`, {
        periodId, month,
        lines: picked.map((l) => ({ key: l.key, accountId: sel[l.key].accountId, amount: sel[l.key].amount })),
        transfers: moves.filter((m) => m.from && m.to && m.amount).map((m) => ({ date: p.date, fromAccountId: m.from, toAccountId: m.to, rawAmount: m.amount, note: `Plan ${p.periodLabel} ${MONTH_NAMES[month - 1]}` })),
      });
      await Promise.all(['transactions', 'accounts', 'statement', 'planned', 'plan', 'execution', 'health'].map((k) => qc.invalidateQueries({ queryKey: [k] })));
      toast.ok(`Plan ejecutado: ${r.created} movimientos${r.transfers ? ` y ${r.transfers} transferencias` : ''}`);
      onOpenChange(false);
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent wide>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Play className="size-5" /> Ejecutar plan</DialogTitle>
          <DialogDescription>Carga tu honorario y registra los pagos del período como movimientos reales del flujo. Lo ya ejecutado no se repite.</DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap items-end gap-3">
          <Field label="Cobro" className="w-48">
            <NativeSelect value={periodId} onChange={(e) => setPeriodId(e.target.value)} aria-label="Cobro a ejecutar">
              {view.periods.map((x) => <option key={x.id} value={x.id}>{x.label} ({/fin de mes/i.test(x.label) ? 'se registra el día 1' : `día ${x.dayOfMonth}`})</option>)}
            </NativeSelect>
          </Field>
          <Field label="Mes" className="w-40">
            <NativeSelect value={month} onChange={(e) => setMonth(Number(e.target.value))} aria-label="Mes a ejecutar">
              {MONTH_NAMES.map((m, i) => <option key={m} value={i + 1}>{m} {view.plan.year}</option>)}
            </NativeSelect>
          </Field>
          {p && <p className="pb-2 text-sm text-muted-foreground">Fecha de los movimientos: <b>{p.date}</b></p>}
        </div>

        <div className="overflow-hidden rounded-lg border">
          <table className="simple" aria-label="Líneas del plan">
            <thead><tr><th className="w-8"></th><th>Concepto</th><th>Cuenta</th><th className="r w-36">Monto</th></tr></thead>
            <tbody>
              {(p?.lines ?? []).map((l) => {
                const s = sel[l.key];
                if (!s) return null;
                return (
                  <tr key={l.key} className={l.executed ? 'opacity-55' : ''}>
                    <td><input type="checkbox" checked={s.on && !l.executed} disabled={l.executed} onChange={(e) => setSel({ ...sel, [l.key]: { ...s, on: e.target.checked } })} aria-label={`Incluir ${l.concept}`} /></td>
                    <td>
                      <span className={l.kind === 'income' ? 'pos' : ''}>{l.concept}</span>{' '}
                      <Badge variant={l.kind === 'income' ? 'ok' : 'default'}>{l.kind === 'income' ? 'Ingreso' : l.source === 'planned' ? `Pago ${l.date.slice(5)}` : 'Gasto'}</Badge>
                      {l.executed && <Badge variant="info" className="ml-1">Ya ejecutado</Badge>}
                    </td>
                    <td className="w-52">
                      <Combobox ariaLabel={`Cuenta de ${l.concept}`} value={s.accountId} onChange={(v) => setSel({ ...sel, [l.key]: { ...s, accountId: v } })} options={liquid.map((a) => ({ value: a.accountId, label: a.name }))} disabled={l.executed} />
                    </td>
                    <td className="r"><Input className="num h-8 text-right" value={s.amount} onChange={(e) => setSel({ ...sel, [l.key]: { ...s, amount: e.target.value } })} disabled={l.executed} aria-label={`Monto de ${l.concept}`} /></td>
                  </tr>
                );
              })}
              {p && !p.lines.length && <tr><td colSpan={4} className="empty">No hay ingresos ni gastos planificados para {p.periodLabel} en {MONTH_NAMES[month - 1]}.</td></tr>}
              {!p && <tr><td colSpan={4} className="empty">Cargando…</td></tr>}
            </tbody>
          </table>
        </div>

        <div>
          <div className="mb-2 flex items-center justify-between">
            <h3>Mover plata entre cuentas (opcional)</h3>
            <Button type="button" variant="ghost" size="sm" onClick={() => setMoves([...moves, { from: '', to: '', amount: '' }])}><Plus /> Agregar</Button>
          </div>
          {moves.map((m, i) => (
            <div key={i} className="mb-2 flex flex-wrap items-center gap-2">
              <div className="w-44"><Combobox ariaLabel="Mover desde" value={m.from} onChange={(v) => setMoves(moves.map((x, j) => (j === i ? { ...x, from: v } : x)))} options={moveOpts} placeholder="Desde" /></div>
              <ArrowRight className="size-4 text-muted-foreground" />
              <div className="w-44"><Combobox ariaLabel="Mover hacia" value={m.to} onChange={(v) => setMoves(moves.map((x, j) => (j === i ? { ...x, to: v } : x)))} options={moveOpts.filter((o) => o.value !== m.from)} placeholder="Hacia" /></div>
              <Input className="num h-9 w-40 text-right" placeholder="Monto" value={m.amount} onChange={(e) => setMoves(moves.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))} aria-label="Monto a mover" />
              <Button type="button" variant="ghost" size="icon" aria-label="Quitar" onClick={() => setMoves(moves.filter((_, j) => j !== i))}><X /></Button>
            </div>
          ))}
          {!moves.length && <p className="text-sm text-muted-foreground">Por ejemplo, pasar el honorario de Familiar a GNB.</p>}
        </div>

        <DialogFooter className="items-center sm:justify-between">
          <p className="text-sm">
            Ingresos <b className="pos num"><Money v={income} /></b> · Gastos <b className="neg num"><Money v={expense} /></b> · Neto <b className="num"><Money v={income - expense} signed /></b>
            <span className="hidden text-muted-foreground sm:inline"> ({money(picked.length)} líneas)</span>
          </p>
          <div className="flex gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancelar</Button>
            <Button type="button" onClick={run} disabled={busy || (!picked.length && !moves.some((m) => m.from && m.to && m.amount))}>Ejecutar</Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
