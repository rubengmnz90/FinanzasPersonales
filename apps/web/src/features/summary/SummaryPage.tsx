import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { get, qs } from '../../app/api';
import type { PlanSummary, RangeSummary } from '../../app/types';
import { Kpi, MONTH_NAMES, Money, RangePicker, money, type Range } from '../../components/ui';
import { HealthTab } from './HealthTab';

const y = new Date().getFullYear();

export function SummaryPage() {
  const [range, setRange] = useState<Range>({ from: `${y}-01-01`, to: `${y}-12-31` });
  const [tab, setTab] = useState<'health' | 'range' | 'annual' | 'plan'>('health');
  return (
    <>
      <div className="page-head">
        <h1>Resúmenes</h1>
        <div className="chips" role="tablist">
          {([['health', 'Sanidad'], ['range', 'Por rango'], ['annual', 'Anual por mes'], ['plan', 'Plan vs real']] as const).map(([k, l]) => (
            <button key={k} role="tab" className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}</button>
          ))}
        </div>
      </div>
      {tab === 'health' && <HealthTab />}
      {tab === 'range' && <RangeTab range={range} setRange={setRange} />}
      {tab === 'annual' && <AnnualTab />}
      {tab === 'plan' && <PlanVsActual />}
    </>
  );
}

function RangeTab({ range, setRange }: { range: Range; setRange: (r: Range) => void }) {
  const ok = !!range.from && !!range.to;
  const q = useQuery({
    queryKey: ['summary-range', range],
    enabled: ok,
    queryFn: () => get<RangeSummary>('/api/summary/range' + qs({ from: range.from, to: range.to })),
  });
  const s = q.data;
  const [open, setOpen] = useState<Record<string, boolean>>({});
  return (
    <>
      <div style={{ marginBottom: 14 }}><RangePicker value={range} onChange={setRange} /></div>
      {!ok && <div className="empty">Elige fecha de inicio y de fin (o un atajo distinto de "Todo").</div>}
      {s && (
        <>
          <div className="grid-cards">
            <Kpi label="Ingresos" value={<Money v={s.income} />} tone="pos" />
            <Kpi label="Egresos" value={<Money v={s.expense} />} tone="neg" />
            <Kpi label="Neto" value={<Money v={s.net} signed />} />
          </div>
          <table className="simple card">
            <thead><tr><th>Grupo / categoría</th><th className="r">Total</th><th className="r">% de egresos</th></tr></thead>
            <tbody>
              {s.groups.map((g) => (
                <GroupRows key={g.group} g={g} expense={s.expense} open={!!open[g.group]} toggle={() => setOpen({ ...open, [g.group]: !open[g.group] })} />
              ))}
              {!s.groups.length && <tr><td colSpan={3} className="empty">Sin movimientos en este rango.</td></tr>}
            </tbody>
          </table>
        </>
      )}
    </>
  );
}

function GroupRows({ g, expense, open, toggle }: { g: RangeSummary['groups'][number]; expense: number; open: boolean; toggle: () => void }) {
  const pct = (v: number) => (g.group !== 'Ingresos' && expense > 0 ? `${((v / expense) * 100).toFixed(1)}%` : '');
  return (
    <>
      <tr style={{ cursor: 'pointer', background: 'var(--muted)' }} onClick={toggle} aria-expanded={open}>
        <td><b>{open ? '▾' : '▸'} {g.group}</b></td>
        <td className="r"><b><Money v={g.total} /></b></td>
        <td className="r muted">{pct(g.total)}</td>
      </tr>
      {open && [...g.categories].sort((a, b) => b.total - a.total).map((c) => (
        <tr key={c.name}><td style={{ paddingLeft: 28 }}>{c.name}</td><td className="r"><Money v={c.total} /></td><td className="r muted">{pct(c.total)}</td></tr>
      ))}
    </>
  );
}

function AnnualTab() {
  const [year, setYear] = useState(y);
  const q = useQuery({ queryKey: ['summary-annual', year], queryFn: () => get<{ group: string; category: string; months: number[]; total: number }[]>(`/api/summary/annual?year=${year}`) });
  const rows = q.data ?? [];
  const groups = [...new Set(rows.map((r) => r.group))];
  return (
    <>
      <div className="toolbar" style={{ marginBottom: 14 }}>
        <button className="btn" onClick={() => setYear(year - 1)} aria-label="Año anterior">‹</button>
        <b>{year}</b>
        <button className="btn" onClick={() => setYear(year + 1)} aria-label="Año siguiente">›</button>
        <span className="muted">Ingresos en positivo; los demás grupos muestran lo gastado.</span>
      </div>
      <div style={{ overflow: 'auto' }}>
        <table className="simple card">
          <thead><tr><th>Categoría</th>{MONTH_NAMES.map((m) => <th key={m} className="r">{m}</th>)}<th className="r">Total</th></tr></thead>
          <tbody>
            {groups.map((g) => (
              <>
                <tr key={g} style={{ background: 'var(--muted)' }}><td colSpan={14}><b>{g}</b></td></tr>
                {rows.filter((r) => r.group === g).map((r) => (
                  <tr key={g + r.category}><td style={{ paddingLeft: 24 }}>{r.category}</td>{r.months.map((v, i) => <td key={i} className="r num">{v ? money(v) : <span className="muted">·</span>}</td>)}<td className="r num"><b>{money(r.total)}</b></td></tr>
                ))}
              </>
            ))}
            {!rows.length && <tr><td colSpan={14} className="empty">Sin movimientos en {year}.</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  );
}

interface VsRow { month: number; plannedIncome: number; actualIncome: number; plannedExpense: number; actualExpense: number; diffNet: number }

function PlanVsActual() {
  const plans = useQuery({ queryKey: ['plans'], queryFn: () => get<PlanSummary[]>('/api/plans') });
  const [id, setId] = useState('');
  useEffect(() => { if (!id && plans.data?.length) setId((plans.data.find((p) => p.year === y) ?? plans.data[0]).id); }, [plans.data, id]);
  const q = useQuery({ queryKey: ['vs', id], enabled: !!id, queryFn: () => get<VsRow[]>(`/api/plans/${id}/vs-actual`) });
  const rows = q.data ?? [];
  const max = Math.max(1, ...rows.flatMap((r) => [r.plannedExpense, r.actualExpense]));
  return (
    <>
      <div className="toolbar" style={{ marginBottom: 14 }}>
        <select className="field" value={id} onChange={(e) => setId(e.target.value)} aria-label="Plan">
          {(plans.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.year} · {p.name}</option>)}
        </select>
        <span className="muted">Planeado vs. lo registrado en el flujo</span>
      </div>
      <table className="simple card">
        <thead><tr><th>Mes</th><th className="r">Ingreso plan</th><th className="r">Ingreso real</th><th className="r">Gasto plan</th><th className="r">Gasto real</th><th style={{ width: 180 }}>Gasto: plan / real</th><th className="r">Diferencia neto</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.month}>
              <td>{MONTH_NAMES[r.month - 1]}</td>
              <td className="r num">{money(r.plannedIncome)}</td><td className="r num">{money(r.actualIncome)}</td>
              <td className="r num">{money(r.plannedExpense)}</td><td className="r num">{money(r.actualExpense)}</td>
              <td>
                <div className="bar" title="plan"><i style={{ width: `${(r.plannedExpense / max) * 100}%`, background: 'var(--input)' }} /></div>
                <div className="bar" style={{ marginTop: 3 }} title="real"><i style={{ width: `${(r.actualExpense / max) * 100}%`, background: r.actualExpense > r.plannedExpense ? 'var(--expense)' : 'var(--primary)' }} /></div>
              </td>
              <td className="r"><Money v={r.diffNet} signed /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
