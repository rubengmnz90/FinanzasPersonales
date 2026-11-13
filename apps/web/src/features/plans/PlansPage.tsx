import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { del, get, patch, post, put, qs } from '../../app/api';
import type { PlanItem, PlanPeriod, PlanSummary, PlanView } from '../../app/types';
import { DataGrid, type Column } from '../../components/DataGrid';
import { Kpi, MONTH_NAMES, Money, money, today, useToast } from '../../components/ui';
import { Play } from 'lucide-react';
import { Button } from '../../components/ui/button';
import { ExecutePlanDialog } from './ExecutePlanDialog';
import { PlannedExpensesPanel } from './PlannedExpensesPanel';

type Action = null | 'new' | 'clone' | 'compare' | 'adjust' | 'rollover';

interface PRow {
  id: string;
  type: 'section' | 'item' | 'total' | 'net';
  label: string;
  item?: PlanItem;
  cells: number[];
}

const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);

function buildRows(p: PlanPeriod): PRow[] {
  const exp = p.items.filter((i) => i.kind === 'expense');
  const inc = p.items.filter((i) => i.kind === 'income');
  const rows: PRow[] = [{ id: 's-exp', type: 'section', label: 'GASTOS', cells: [] }];
  exp.forEach((i) => rows.push({ id: i.id, type: 'item', label: i.concept, item: i, cells: i.cells }));
  rows.push({ id: 't-exp', type: 'total', label: 'Total gastos', cells: p.totals.expense });
  rows.push({ id: 's-inc', type: 'section', label: 'INGRESOS', cells: [] });
  inc.forEach((i) => rows.push({ id: i.id, type: 'item', label: i.concept, item: i, cells: i.cells }));
  rows.push({ id: 't-inc', type: 'total', label: 'Total ingresos', cells: p.totals.income });
  rows.push({ id: 'net', type: 'net', label: 'Neto', cells: p.totals.net });
  return rows;
}

export function PlansPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const plans = useQuery({ queryKey: ['plans'], queryFn: () => get<PlanSummary[]>('/api/plans') });
  const [planId, setPlanId] = useState('');
  const [tab, setTab] = useState<string>('');
  const [action, setAction] = useState<Action>(null);
  const [executing, setExecuting] = useState(false);

  useEffect(() => {
    if (!planId && plans.data?.length) {
      const y = new Date().getFullYear();
      setPlanId((plans.data.find((p) => p.year === y) ?? plans.data[0]).id);
    }
  }, [plans.data, planId]);

  const view = useQuery({ queryKey: ['plan', planId], enabled: !!planId, queryFn: () => get<PlanView>(`/api/plans/${planId}`) });
  const v = view.data;
  const period = v?.periods.find((p) => p.id === tab) ?? v?.periods[0];
  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: ['plan'] }), qc.invalidateQueries({ queryKey: ['plans'] }), qc.invalidateQueries({ queryKey: ['projection'] })]);

  const columns: Column<PRow>[] = useMemo(
    () => [
      { key: 'label', label: 'Concepto', width: 230, editable: (r) => r.type === 'item', value: (r) => r.label, cellClass: (r) => (r.type === 'section' ? 'muted' : '') },
      ...MONTH_NAMES.map((m, i): Column<PRow> => ({
        key: `m${i + 1}`,
        label: m,
        width: 104,
        align: 'right',
        kind: 'money',
        editable: (r) => r.type === 'item',
        value: (r) => (r.type === 'item' && r.item ? (r.item.overrides[i] || !r.item.auto ? (r.item.exprs[i] ?? r.item.cells[i]) : r.item.cells[i]) : ''),
        display: (r) => {
          if (r.type === 'section') return '';
          const val = r.cells[i] ?? 0;
          return <span className={r.type === 'net' ? (val < 0 ? 'neg' : 'pos') : val < 0 ? 'neg' : ''}>{money(val)}</span>;
        },
        cellClass: (r) => (r.item?.auto && r.item.overrides[i] ? 'ovr' : ''),
      })),
      { key: 'total', label: 'Total', width: 124, align: 'right', value: () => '', display: (r) => (r.type === 'section' ? '' : <Money v={sum(r.cells)} signed={r.type === 'net'} />) },
      {
        key: 'del', label: '', width: 50, value: () => '',
        display: (r) =>
          r.type === 'item' ? (
            <button
              className="btn sm danger"
              aria-label={`Eliminar fila ${r.label}`}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={async () => {
                if (!confirm(`¿Eliminar la fila "${r.label}" de este plan?`)) return;
                try { await del(`/api/plan-items/${r.id}`); await refresh(); } catch (e) { toast.error(e); }
              }}
            >✕</button>
          ) : '',
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  async function onCommit(rowId: string, col: string, raw: string) {
    const row = period && buildRows(period).find((r) => r.id === rowId);
    if (!row?.item) return;
    if (col === 'label') {
      if (!raw.trim()) return;
      await patch(`/api/plan-items/${rowId}`, { concept: raw.trim() });
    } else if (col.startsWith('m')) {
      const month = Number(col.slice(1));
      if (row.item.auto && raw.trim() === '') await del(`/api/plan-items/${rowId}/cells/${month}/override`);
      else await put(`/api/plan-items/${rowId}/cells/${month}`, { rawAmount: raw.trim() === '' ? 0 : raw });
    }
    await refresh();
  }

  return (
    <>
      <div className="page-head">
        <h1>Planes y proyección</h1>
        <div className="toolbar">
          <select className="field" value={planId} onChange={(e) => { setPlanId(e.target.value); setTab(''); }} aria-label="Plan">
            {(plans.data ?? []).map((p) => (
              <option key={p.id} value={p.id}>{p.year} · {p.name}</option>
            ))}
          </select>
          <Button disabled={!v} onClick={() => setExecuting(true)}><Play /> Ejecutar plan</Button>
          {(['new', 'clone', 'compare', 'adjust', 'rollover'] as const).map((a) => (
            <button key={a} className={`btn ${action === a ? 'primary' : ''}`} disabled={a !== 'new' && !v} onClick={() => setAction(action === a ? null : a)}>
              {{ new: '+ Nuevo plan', clone: 'Clonar (escenario)', compare: 'Comparar', adjust: 'Ajuste %', rollover: 'Preparar año nuevo' }[a]}
            </button>
          ))}
        </div>
      </div>

      {v && <ExecutePlanDialog open={executing} onOpenChange={setExecuting} view={v} periodId={period?.id} />}
      {action === 'new' && <NewPlan onDone={async (id) => { await refresh(); setPlanId(id); setTab(''); setAction(null); }} />}
      {action === 'clone' && v && <ClonePlan view={v} onDone={async (id) => { await refresh(); setPlanId(id); setAction(null); toast.ok('Escenario creado'); }} />}
      {action === 'compare' && v && <ComparePanel view={v} plans={plans.data ?? []} />}
      {action === 'adjust' && v && period && <AdjustPanel view={v} period={period} onDone={async () => { await refresh(); toast.ok('Ajuste aplicado'); }} />}
      {action === 'rollover' && v && <RolloverPanel view={v} onDone={async (id) => { await refresh(); setPlanId(id); setAction(null); }} />}

      {!plans.data?.length && !plans.isLoading && <div className="empty">Todavía no hay planes. Crea uno o importa tu Excel.</div>}

      {v && (
        <>
          <div className="grid-cards">
            <Kpi label="Ingresos del año" value={<Money v={v.grand.income} />} tone="pos" />
            <Kpi label="Gastos del año" value={<Money v={v.grand.expense} />} tone="neg" />
            <Kpi label="Neto del año" value={<Money v={v.grand.net} signed />} sub={`${v.periods.length === 1 ? 'Cobro mensual' : `${v.periods.length} cobros por mes`}`} />
          </div>

          <div className="tabs" role="tablist">
            {v.periods.map((p) => (
              <button key={p.id} role="tab" className={p.id === period?.id && tab !== '__total' ? 'on' : ''} onClick={() => setTab(p.id)}>
                {p.label} <span className="badge">día {p.dayOfMonth}</span>
              </button>
            ))}
            <button role="tab" className={tab === '__total' ? 'on' : ''} onClick={() => setTab('__total')}>Total y saldo proyectado</button>
          </div>

          {tab === '__total' ? (
            <TotalTab view={v} />
          ) : (
            period && (
              <>
                <DataGrid
                  ariaLabel={`Plan ${period.label}`}
                  columns={columns}
                  rows={buildRows(period)}
                  rowId={(r) => r.id}
                  rowClass={(r) => (r.type === 'total' ? 'total' : r.type === 'net' ? 'net' : '')}
                  onCommit={onCommit}
                  onError={toast.error}
                  height={Math.min(560, 34 * (buildRows(period).length + 2))}
                />
                <p className="muted" style={{ margin: '6px 2px' }}>
                  Edita cualquier mes y se recalculan totales y neto. Fórmulas con <b>=</b>. <b>Ctrl+D</b> copia hacia abajo. En "Otros gastos" un valor escrito pisa al calculado (marca naranja); <b>Supr</b> vuelve al calculado.
                </p>
                <AddRow plan={v} period={period} onDone={refresh} />
              </>
            )
          )}

          <h2 style={{ marginTop: 26 }}>Otros gastos (con fecha de pago)</h2>
          <PlannedExpensesPanel year={v.plan.year} periods={v.periods.map((p) => p.label)} onChanged={refresh} />
        </>
      )}
    </>
  );
}

function AddRow({ plan, period, onDone }: { plan: PlanView; period: PlanPeriod; onDone: () => Promise<unknown> }) {
  const toast = useToast();
  const [concept, setConcept] = useState('');
  const [kind, setKind] = useState<'expense' | 'income'>('expense');
  async function submit(e: FormEvent) {
    e.preventDefault();
    try {
      await post(`/api/plans/${plan.plan.id}/items`, { periodId: period.id, kind, concept });
      setConcept('');
      await onDone();
    } catch (err) { toast.error(err); }
  }
  return (
    <form className="toolbar" onSubmit={submit}>
      <input className="field" placeholder={`Nueva fila en ${period.label}`} value={concept} onChange={(e) => setConcept(e.target.value)} required />
      <select className="field" value={kind} onChange={(e) => setKind(e.target.value as any)} aria-label="Tipo de fila">
        <option value="expense">Gasto</option>
        <option value="income">Ingreso</option>
      </select>
      <button className="btn">Agregar fila</button>
    </form>
  );
}

function NewPlan({ onDone }: { onDone: (id: string) => void }) {
  const toast = useToast();
  const [name, setName] = useState('');
  const [year, setYear] = useState(new Date().getFullYear() + 1);
  const [mode, setMode] = useState<'monthly' | 'biweekly' | 'custom'>('biweekly');
  const [custom, setCustom] = useState('Semana 1:7, Semana 2:14, Semana 3:21, Fin de mes:30');

  async function submit(e: FormEvent) {
    e.preventDefault();
    const periods =
      mode === 'monthly'
        ? [{ label: 'Mensual', dayOfMonth: 30 }]
        : mode === 'biweekly'
          ? [{ label: 'Quincena', dayOfMonth: 15 }, { label: 'Fin de mes', dayOfMonth: 30 }]
          : custom.split(',').map((s) => {
              const [label, day] = s.split(':');
              return { label: label.trim(), dayOfMonth: Number(day) };
            });
    try {
      const p = await post('/api/plans', { year, name: name || `Plan ${year}`, periods });
      onDone(p.id);
    } catch (err) { toast.error(err); }
  }
  return (
    <form className="card toolbar" style={{ marginBottom: 14 }} onSubmit={submit}>
      <input className="field" placeholder="Nombre (p. ej. Plan B)" value={name} onChange={(e) => setName(e.target.value)} />
      <input className="field" type="number" value={year} onChange={(e) => setYear(Number(e.target.value))} style={{ width: 90 }} aria-label="Año" />
      <div className="chips" role="group" aria-label="Frecuencia de cobro">
        <button type="button" className={mode === 'monthly' ? 'on' : ''} onClick={() => setMode('monthly')}>Mensual</button>
        <button type="button" className={mode === 'biweekly' ? 'on' : ''} onClick={() => setMode('biweekly')}>Quincenal</button>
        <button type="button" className={mode === 'custom' ? 'on' : ''} onClick={() => setMode('custom')}>Personalizado</button>
      </div>
      {mode === 'custom' && <input className="field" style={{ minWidth: 320 }} value={custom} onChange={(e) => setCustom(e.target.value)} aria-label="Cobros (etiqueta:día, …)" />}
      <button className="btn primary">Crear plan</button>
    </form>
  );
}

function ClonePlan({ view, onDone }: { view: PlanView; onDone: (id: string) => void }) {
  const toast = useToast();
  const [name, setName] = useState(`${view.plan.name} (escenario)`);
  const [year, setYear] = useState(view.plan.year);
  return (
    <form className="card toolbar" style={{ marginBottom: 14 }} onSubmit={async (e) => {
      e.preventDefault();
      try { onDone((await post(`/api/plans/${view.plan.id}/clone`, { name, year })).id); } catch (err) { toast.error(err); }
    }}>
      <span className="muted">Copia filas y montos para jugar con los números sin tocar el original.</span>
      <input className="field" value={name} onChange={(e) => setName(e.target.value)} required aria-label="Nombre del escenario" />
      <input className="field" type="number" value={year} onChange={(e) => setYear(Number(e.target.value))} style={{ width: 90 }} aria-label="Año" />
      <button className="btn primary">Clonar</button>
    </form>
  );
}

function ComparePanel({ view, plans }: { view: PlanView; plans: PlanSummary[] }) {
  const others = plans.filter((p) => p.id !== view.plan.id);
  const [other, setOther] = useState(others[0]?.id ?? '');
  const cmp = useQuery({ queryKey: ['compare', view.plan.id, other], enabled: !!other, queryFn: () => get<{ month: number; netA: number; netB: number; diff: number }[]>(`/api/plans/${view.plan.id}/compare/${other}`) });
  return (
    <div className="card" style={{ marginBottom: 14 }}>
      <div className="toolbar">
        <b>{view.plan.name}</b> contra
        <select className="field" value={other} onChange={(e) => setOther(e.target.value)} aria-label="Plan a comparar">
          {others.map((p) => <option key={p.id} value={p.id}>{p.year} · {p.name}</option>)}
        </select>
      </div>
      {!others.length && <div className="empty">Necesitas otro plan para comparar (clona uno).</div>}
      {cmp.data && (
        <table className="simple" style={{ marginTop: 10 }}>
          <thead><tr><th>Mes</th><th className="r">Neto A</th><th className="r">Neto B</th><th className="r">Diferencia (B − A)</th></tr></thead>
          <tbody>
            {cmp.data.map((r) => (
              <tr key={r.month}><td>{MONTH_NAMES[r.month - 1]}</td><td className="r num">{money(r.netA)}</td><td className="r num">{money(r.netB)}</td><td className="r"><Money v={r.diff} signed /></td></tr>
            ))}
            <tr><td><b>Total</b></td><td className="r num"><b>{money(sum(cmp.data.map((r) => r.netA)))}</b></td><td className="r num"><b>{money(sum(cmp.data.map((r) => r.netB)))}</b></td><td className="r"><Money v={sum(cmp.data.map((r) => r.diff))} signed /></td></tr>
          </tbody>
        </table>
      )}
    </div>
  );
}

function AdjustPanel({ view, period, onDone }: { view: PlanView; period: PlanPeriod; onDone: () => Promise<unknown> }) {
  const toast = useToast();
  const [target, setTarget] = useState('__expenses');
  const [from, setFrom] = useState(1);
  const [to, setTo] = useState(12);
  const [pct, setPct] = useState(10);
  const manual = period.items.filter((i) => !i.auto);
  return (
    <form className="card toolbar" style={{ marginBottom: 14 }} onSubmit={async (e) => {
      e.preventDefault();
      const itemIds = target === '__expenses' ? manual.filter((i) => i.kind === 'expense').map((i) => i.id) : [target];
      const months = Array.from({ length: Math.max(0, to - from + 1) }, (_, i) => from + i);
      try { await post(`/api/plans/${view.plan.id}/adjust`, { itemIds, months, pct }); await onDone(); } catch (err) { toast.error(err); }
    }}>
      <span className="muted">En {period.label}:</span>
      <select className="field" value={target} onChange={(e) => setTarget(e.target.value)} aria-label="Filas a ajustar">
        <option value="__expenses">Todas las filas de gasto</option>
        {manual.map((i) => <option key={i.id} value={i.id}>{i.concept}</option>)}
      </select>
      <select className="field" value={from} onChange={(e) => setFrom(Number(e.target.value))} aria-label="Desde mes">{MONTH_NAMES.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}</select>
      <span className="muted">a</span>
      <select className="field" value={to} onChange={(e) => setTo(Number(e.target.value))} aria-label="Hasta mes">{MONTH_NAMES.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}</select>
      <input className="field num" type="number" value={pct} onChange={(e) => setPct(Number(e.target.value))} style={{ width: 80 }} aria-label="Porcentaje" /> %
      <button className="btn primary">Aplicar</button>
    </form>
  );
}

function RolloverPanel({ view, onDone }: { view: PlanView; onDone: (id: string) => void }) {
  const toast = useToast();
  const [toYear, setToYear] = useState(view.plan.year + 1);
  const [result, setResult] = useState<{ plan: { id: string; year: number }; openingBalance: number } | null>(null);
  const qc = useQueryClient();
  return (
    <div className="card" style={{ marginBottom: 14 }}>
      {!result ? (
        <form className="toolbar" onSubmit={async (e) => {
          e.preventDefault();
          try { setResult(await post(`/api/plans/${view.plan.id}/rollover`, { toYear })); await qc.invalidateQueries({ queryKey: ['plans'] }); } catch (err) { toast.error(err); }
        }}>
          <span>Clonar <b>{view.plan.name}</b> ({view.plan.year}) como plan del año</span>
          <input className="field" type="number" value={toYear} onChange={(e) => setToYear(Number(e.target.value))} style={{ width: 90 }} aria-label="Año nuevo" />
          <button className="btn primary">Preparar</button>
        </form>
      ) : (
        <div className="toolbar">
          <span>Plan {result.plan.year} creado. Saldo de cierre {view.plan.year}: <Money v={result.openingBalance} signed />.</span>
          {result.openingBalance !== 0 && (
            <button className="btn" onClick={async () => {
              try {
                await post('/api/transactions', {
                  date: `${result.plan.year}-01-01`, item: 'Saldo inicial',
                  kind: result.openingBalance >= 0 ? 'income' : 'expense', rawAmount: Math.abs(result.openingBalance),
                });
                toast.ok('Movimiento "Saldo inicial" creado');
              } catch (err) { toast.error(err); }
            }}>Crear movimiento "Saldo inicial"</button>
          )}
          <button className="btn primary" onClick={() => onDone(result.plan.id)}>Ir al plan {result.plan.year}</button>
        </div>
      )}
    </div>
  );
}

function TotalTab({ view }: { view: PlanView }) {
  const [from, setFrom] = useState(today());
  const proj = useQuery({
    queryKey: ['projection', view.plan.id, from],
    queryFn: () => get<{ date: string; period: string; income: number; expense: number; net: number; balance: number }[]>(`/api/plans/${view.plan.id}/projection${qs({ from })}`),
  });
  const g = view.grandByMonth;
  return (
    <>
      <table className="simple card" style={{ marginBottom: 18 }}>
        <thead><tr><th>Total del mes (todos los cobros)</th>{MONTH_NAMES.map((m) => <th key={m} className="r">{m}</th>)}<th className="r">Año</th></tr></thead>
        <tbody>
          {([['Ingresos', g.income, 'pos'], ['Gastos', g.expense, 'neg'], ['Neto', g.net, '']] as const).map(([l, arr, tone]) => (
            <tr key={l}><td><b>{l}</b></td>{arr.map((v, i) => <td key={i} className={`r num ${tone === 'pos' ? 'pos' : tone === 'neg' ? 'neg' : v < 0 ? 'neg' : 'pos'}`}>{money(v)}</td>)}<td className="r num"><b>{money(sum(arr))}</b></td></tr>
          ))}
        </tbody>
      </table>
      <div className="toolbar" style={{ marginBottom: 8 }}>
        <h2 style={{ margin: 0 }}>Saldo proyectado cobro a cobro</h2>
        <span className="muted">desde</span>
        <input className="field" type="date" value={from} onChange={(e) => setFrom(e.target.value)} aria-label="Proyectar desde" />
      </div>
      <table className="simple card">
        <thead><tr><th>Fecha</th><th>Cobro</th><th className="r">Entra</th><th className="r">Sale</th><th className="r">Neto</th><th className="r">Saldo</th></tr></thead>
        <tbody>
          {(proj.data ?? []).map((e) => (
            <tr key={e.date + e.period}><td>{e.date}</td><td>{e.period}</td><td className="r num pos">{money(e.income)}</td><td className="r num neg">{money(e.expense)}</td><td className="r"><Money v={e.net} signed /></td><td className="r"><b><Money v={e.balance} signed /></b></td></tr>
          ))}
          {proj.data?.length === 0 && <tr><td colSpan={6} className="empty">No hay cobros posteriores a esa fecha en este plan.</td></tr>}
        </tbody>
      </table>
    </>
  );
}
