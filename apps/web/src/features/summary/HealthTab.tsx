import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, Info, XCircle } from 'lucide-react';
import { useState } from 'react';
import { get, qs } from '../../app/api';
import type { Health, HealthCheck } from '../../app/types';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Kpi, Money, money, today } from '../../components/ui';
import { cn } from '../../lib/utils';

const STATUS = {
  ok: { label: 'Bien', variant: 'ok', Icon: CheckCircle2, ring: 'border-emerald-300/60 dark:border-emerald-800' },
  warn: { label: 'Atención', variant: 'warn', Icon: AlertTriangle, ring: 'border-amber-300/70 dark:border-amber-800' },
  bad: { label: 'Riesgo', variant: 'bad', Icon: XCircle, ring: 'border-rose-300/70 dark:border-rose-800' },
  info: { label: 'Sin datos', variant: 'info', Icon: Info, ring: '' },
} as const;

function fmt(c: HealthCheck): string {
  switch (c.unit) {
    case 'pyg': return `${money(c.value)} Gs.`;
    case 'months': return `${c.value.toFixed(1)} meses`;
    case 'pct': return `${c.value.toFixed(0)}%`;
    default: return String(Math.round(c.value));
  }
}

/** Reporte de sanidad de los estados financieros con semáforo por indicador. */
export function HealthTab() {
  const [asOf, setAsOf] = useState(today());
  const q = useQuery({ queryKey: ['health', asOf], queryFn: () => get<Health>('/api/summary/health' + qs({ asOf })) });
  const h = q.data;
  if (!h) return <div className="empty">Calculando…</div>;
  const tone = h.scorePct >= 75 ? 'text-emerald-600' : h.scorePct >= 50 ? 'text-amber-600' : 'text-rose-600';
  const counts = { ok: 0, warn: 0, bad: 0, info: 0 };
  h.checks.forEach((c) => counts[c.status]++);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          Al día
          <Input type="date" className="w-40" value={asOf} onChange={(e) => setAsOf(e.target.value || today())} aria-label="Reporte al día" />
        </label>
        {asOf !== today() && <Button variant="ghost" size="sm" onClick={() => setAsOf(today())}>Hoy</Button>}
      </div>

      <div className="grid gap-4 lg:grid-cols-[280px_1fr]">
        <div className="rounded-xl border bg-card p-5 shadow-sm">
          <div className="text-xs font-medium text-muted-foreground">Salud financiera</div>
          <div className={cn('num mt-1 text-6xl font-bold tracking-tight', tone)} aria-label="Puntaje">{h.scorePct}%</div>
          <div className="bar mt-3"><i style={{ width: `${h.scorePct}%` }} /></div>
          <div className="mt-3 flex flex-wrap gap-1.5">
            {counts.ok > 0 && <Badge variant="ok">{counts.ok} bien</Badge>}
            {counts.warn > 0 && <Badge variant="warn">{counts.warn} atención</Badge>}
            {counts.bad > 0 && <Badge variant="bad">{counts.bad} riesgo</Badge>}
          </div>
          <p className="mt-3 text-xs text-muted-foreground">Promedio de 3 meses: ingresas {money(h.avgMonthlyIncome)} y gastas {money(h.avgMonthlyExpense)} por mes.</p>
        </div>
        <div className="grid-cards !mb-0 content-start">
          <Kpi label="Disponible" value={<Money v={h.summary.liquid} signed />} />
          <Kpi label="Ahorro" value={<Money v={h.summary.savings} />} tone="pos" />
          <Kpi label="Tarjetas" value={<Money v={h.summary.cardDebt} />} tone={h.summary.cardDebt > 0 ? 'neg' : undefined} />
          <Kpi label="Deudas externas" value={<Money v={h.summary.externalDebt} />} tone={h.summary.externalDebt > 0 ? 'neg' : undefined} />
          <Kpi label="Patrimonio neto" value={<Money v={h.summary.netWorth} signed />} sub="Lo que tienes menos lo que debes" />
          <Kpi label="Prestado del ahorro" value={<Money v={h.summary.loansFromSavings} />} tone={h.summary.loansFromSavings > 0 ? 'neg' : undefined} />
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-2" role="list" aria-label="Indicadores">
        {h.checks.map((c) => {
          const s = STATUS[c.status];
          return (
            <div key={c.key} role="listitem" className={cn('rounded-xl border bg-card p-4 shadow-sm', s.ring)}>
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-center gap-2 font-medium"><s.Icon className="size-4 shrink-0" /> {c.label}</div>
                <Badge variant={s.variant}>{s.label}</Badge>
              </div>
              <div className="num mt-2 text-2xl font-semibold tracking-tight">{fmt(c)}</div>
              <p className="mt-1 text-sm text-muted-foreground">{c.hint}</p>
            </div>
          );
        })}
      </div>
    </div>
  );
}
