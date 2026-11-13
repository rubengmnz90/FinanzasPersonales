import { formatPyg } from '@finanzas/shared';
import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { Toaster, toast } from 'sonner';
import { friendly } from '../app/api';

// ── formato ──
export const money = (n: number | null | undefined) => (n === null || n === undefined ? '' : formatPyg(n));
export const Money = ({ v, signed = false }: { v: number; signed?: boolean }) => (
  <span className={`num ${signed ? (v < 0 ? 'neg' : v > 0 ? 'pos' : '') : v < 0 ? 'neg' : ''}`}>{formatPyg(v)}</span>
);

export const today = () => new Date().toISOString().slice(0, 10);
export const MONTH_NAMES = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];

export function monthRange(year: number, month: number): [string, string] {
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const mm = String(month).padStart(2, '0');
  return [`${year}-${mm}-01`, `${year}-${mm}-${String(last).padStart(2, '0')}`];
}

// ── avisos ──
interface ToastCtx {
  ok: (m: string) => void;
  error: (e: unknown) => void;
}
const Ctx = createContext<ToastCtx>({ ok: () => {}, error: () => {} });
export const useToast = () => useContext(Ctx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const value = useMemo<ToastCtx>(() => ({ ok: (m) => void toast.success(m), error: (e) => void toast.error(friendly(e), { duration: 6000 }) }), []);
  return (
    <Ctx.Provider value={value}>
      {children}
      <Toaster richColors position="bottom-right" closeButton />
    </Ctx.Provider>
  );
}

// ── controles ──
export function Kpi({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: ReactNode; tone?: 'pos' | 'neg' }) {
  return (
    <div className="kpi rounded-xl border bg-card p-4 shadow-sm">
      <div className="label">{label}</div>
      <div className={`value num ${tone ?? ''}`}>{value}</div>
      {sub && <div className="sub">{sub}</div>}
    </div>
  );
}

export interface Range {
  from: string;
  to: string;
}

/** Selector de rango de fechas con atajos (mes, año, todo) y fechas libres. */
export function RangePicker({ value, onChange }: { value: Range; onChange: (r: Range) => void }) {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth() + 1;
  const prev = m === 1 ? [y - 1, 12] : [y, m - 1];
  const presets: { label: string; range: () => Range }[] = [
    { label: 'Este mes', range: () => { const [from, to] = monthRange(y, m); return { from, to }; } },
    { label: 'Mes anterior', range: () => { const [from, to] = monthRange(prev[0], prev[1]); return { from, to }; } },
    { label: `Año ${y}`, range: () => ({ from: `${y}-01-01`, to: `${y}-12-31` }) },
    { label: 'Todo', range: () => ({ from: '', to: '' }) },
  ];
  return (
    <div className="toolbar">
      <div className="chips" role="group" aria-label="Rango rápido">
        {presets.map((p) => {
          const r = p.range();
          return (
            <button key={p.label} className={r.from === value.from && r.to === value.to ? 'on' : ''} onClick={() => onChange(r)}>
              {p.label}
            </button>
          );
        })}
      </div>
      <input className="field" type="date" aria-label="Desde" value={value.from} onChange={(e) => onChange({ ...value, from: e.target.value })} />
      <span className="muted">→</span>
      <input className="field" type="date" aria-label="Hasta" value={value.to} onChange={(e) => onChange({ ...value, to: e.target.value })} />
    </div>
  );
}

export function Bar({ pct }: { pct: number }) {
  return (
    <div className="bar" role="progressbar" aria-valuenow={Math.round(pct)}>
      <i style={{ width: `${Math.max(0, Math.min(100, pct))}%` }} />
    </div>
  );
}
