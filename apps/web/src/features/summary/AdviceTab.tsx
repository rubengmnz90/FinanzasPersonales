import { useQuery } from '@tanstack/react-query';
import { AlertOctagon, ArrowRight, CheckCircle2, Lightbulb, TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { get, qs } from '../../app/api';
import type { Advice, Recommendation } from '../../app/types';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { money, today } from '../../components/ui';
import { cn } from '../../lib/utils';

const PRIORITY = {
  urgent: { label: 'Urgente', variant: 'bad', Icon: AlertOctagon, ring: 'border-rose-300/70 dark:border-rose-800' },
  important: { label: 'Importante', variant: 'warn', Icon: TriangleAlert, ring: 'border-amber-300/70 dark:border-amber-800' },
  improve: { label: 'Mejora', variant: 'info', Icon: Lightbulb, ring: '' },
  good: { label: 'Buen momento', variant: 'ok', Icon: CheckCircle2, ring: 'border-emerald-300/60 dark:border-emerald-800' },
} as const;

function Card({ r, index }: { r: Recommendation; index: number }) {
  const p = PRIORITY[r.priority];
  return (
    <article className={cn('rounded-xl border bg-card p-5 shadow-sm', p.ring)} aria-label={r.title}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <h3 className="flex items-center gap-2 !text-base !font-semibold !normal-case !tracking-normal"><span className="num text-muted-foreground">{index}.</span><p.Icon className="size-4 shrink-0" /> {r.title}</h3>
        <div className="flex items-center gap-2">
          {r.amount !== undefined && r.amount > 0 && r.key !== 'uncategorized' && <span className="num text-sm font-medium">{money(r.amount)} Gs</span>}
          <Badge variant={p.variant}>{p.label}</Badge>
        </div>
      </div>
      <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{r.why}</p>
      <ol className="mt-3 list-decimal space-y-1.5 pl-5 text-sm leading-relaxed">
        {r.steps.map((s, i) => <li key={i}>{s}</li>)}
      </ol>
      {r.link && (
        <Button asChild variant="outline" size="sm" className="mt-4">
          <Link to={r.link.to}>{r.link.label} <ArrowRight /></Link>
        </Button>
      )}
    </article>
  );
}

/** Qué hacer ahora: pasos priorizados según el estado real de las finanzas. */
export function AdviceTab() {
  const [asOf, setAsOf] = useState(today());
  const q = useQuery({ queryKey: ['advice', asOf], queryFn: () => get<Advice>('/api/summary/advice' + qs({ asOf })) });
  if (q.isError) return <div className="empty">No pude calcular las recomendaciones. Inténtalo de nuevo.</div>;
  const a = q.data;
  if (!a) return <div className="empty">Analizando tus finanzas…</div>;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          Al día
          <Input type="date" className="w-40" value={asOf} onChange={(e) => setAsOf(e.target.value || today())} aria-label="Recomendaciones al día" />
        </label>
        {asOf !== today() && <Button variant="ghost" size="sm" onClick={() => setAsOf(today())}>Hoy</Button>}
      </div>
      <div className="rounded-xl border bg-card p-5 shadow-sm">
        <div className="text-xs font-medium text-muted-foreground">Qué hacer ahora</div>
        <p className="mt-1 text-lg font-semibold" role="status">{a.headline}</p>
        <p className="mt-1 text-xs text-muted-foreground">Calculado con tus movimientos, cuentas, plan, préstamos y tarjetas. Los pasos están ordenados por prioridad: empieza por el primero.</p>
      </div>
      {a.recommendations.map((r, i) => <Card key={r.key} r={r} index={i + 1} />)}
    </div>
  );
}
