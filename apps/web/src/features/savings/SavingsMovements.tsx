import { useQuery } from '@tanstack/react-query';
import { ArrowDownToLine, ArrowUpFromLine, Copy, HandCoins, Undo2, Users } from 'lucide-react';
import { useState } from 'react';
import { get } from '../../app/api';
import type { SavingsMove, SavingsMoveKind, SavingsOverview, SavingsPerson } from '../../app/types';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { Kpi, Money, money, useToast } from '../../components/ui';

const KIND: Record<SavingsMoveKind, { label: string; plural: string; variant: 'ok' | 'warn' | 'info' | 'bad'; icon: typeof HandCoins; help: string }> = {
  deposit: { label: 'Depósito', plural: 'Depósitos', variant: 'ok', icon: ArrowDownToLine, help: 'Plata que pusiste en tu ahorro' },
  withdrawal: { label: 'Extracción', plural: 'Extracciones', variant: 'bad', icon: ArrowUpFromLine, help: 'Sacaste tu ahorro (meta cumplida u otro motivo); no se devuelve' },
  loan: { label: 'Préstamo', plural: 'Préstamos', variant: 'warn', icon: HandCoins, help: 'Sale de tu ahorro pero hay que devolverlo' },
  return: { label: 'Devolución', plural: 'Devoluciones', variant: 'info', icon: Undo2, help: 'Plata que vuelve a tu ahorro' },
};
const KIND_ORDER: SavingsMoveKind[] = ['deposit', 'withdrawal', 'loan', 'return'];

/** Persona sin nombre = préstamos normales (los que no son de nadie en particular). */
export const personLabel = (p: string | null) => p ?? 'Préstamos normales';
const fmtDate = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}`;

/** Texto listo para mandarle a quien debe: qué se le prestó, cuándo y cuánto falta. */
function summaryText(p: SavingsPerson, moves: SavingsMove[]): string {
  const mine = moves.filter((m) => (m.kind === 'loan' || m.kind === 'return') && m.person === p.person).reverse();
  const lines = mine.map((m) => `• ${fmtDate(m.date)} ${m.concept}: ${m.kind === 'loan' ? '' : '− '}${money(Math.abs(m.amount))}${m.kind === 'return' ? ' (pagado)' : ''}`);
  const head = p.person ? `${p.person}, esto es lo que me debes de mi ahorro:` : 'Préstamos normales de mi ahorro:';
  return `${head}\n${lines.join('\n')}\nPrestado ${money(p.lent)} · devuelto ${money(p.returned)} · pendiente ${money(p.pending)}`;
}

/** Vista del ahorro pensada para usarse: depósitos, extracciones, préstamos y devoluciones, y cuánto debe cada persona. */
export function SavingsMovements({ accountId }: { accountId: string }) {
  const toast = useToast();
  const q = useQuery({ queryKey: ['savings-overview', accountId], queryFn: () => get<SavingsOverview>(`/api/accounts/${accountId}/savings-overview`) });
  const [kind, setKind] = useState<SavingsMoveKind | 'all'>('all');
  // undefined = todas las personas; null = préstamos normales; string = esa persona.
  const [person, setPerson] = useState<string | null | undefined>(undefined);
  const o = q.data;
  if (!o) return <p className="text-sm text-muted-foreground">Cargando movimientos…</p>;

  const counts = (k: SavingsMoveKind) => o.moves.filter((m) => m.kind === k).length;
  const rows = [...o.moves]
    .filter((m) => kind === 'all' || m.kind === kind)
    .filter((m) => person === undefined || ((m.kind === 'loan' || m.kind === 'return') && m.person === person))
    .reverse();
  const owing = o.people.filter((p) => p.pending !== 0);

  async function copy(p: SavingsPerson) {
    try {
      await navigator.clipboard.writeText(summaryText(p, o!.moves));
      toast.ok(`Resumen de ${personLabel(p.person)} copiado`);
    } catch (e) { toast.error(e); }
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="grid-cards !mb-0">
        <Kpi label="Depósitos" value={<Money v={o.totals.deposits} />} tone="pos" sub="lo que pusiste en tu ahorro" />
        <Kpi label="Extracciones" value={<Money v={o.totals.withdrawals} />} sub="lo que sacaste de tu ahorro" />
        <Kpi label="Prestado" value={<Money v={o.totals.lent} />} sub={`devuelto ${money(o.totals.returned)}`} />
        <Kpi label="Por devolver" value={<Money v={o.totals.pending} />} tone={o.totals.pending > 0 ? 'neg' : undefined} sub="falta que vuelva a tu ahorro" />
      </div>

      <section aria-label="Préstamos por persona">
        <h3 className="!mb-3 flex items-center gap-2 text-base"><Users className="size-4" /> Quién me debe</h3>
        {owing.length ? (
          <ul className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {owing.map((p) => {
              const on = person === p.person;
              return (
                <li key={p.person ?? '__normal'} className={`rounded-xl border p-4 transition-colors ${on ? 'border-primary bg-primary/5' : ''}`}>
                  <div className="flex items-start justify-between gap-2">
                    <div className="font-medium">{personLabel(p.person)}</div>
                    <Badge variant={p.pending > 0 ? 'warn' : 'ok'}>{p.pending > 0 ? 'Debe' : 'Saldado'}</Badge>
                  </div>
                  <div className={`num mt-2 text-2xl font-semibold ${p.pending > 0 ? 'neg' : ''}`}>{money(p.pending)}</div>
                  <div className="mt-1 text-xs text-muted-foreground">prestado {money(p.lent)} · devuelto {money(p.returned)}</div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Button size="sm" variant={on ? 'default' : 'outline'} onClick={() => { setPerson(on ? undefined : p.person); setKind('all'); }}>
                      {on ? 'Ver todos' : 'Ver detalle'}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => copy(p)} aria-label={`Copiar resumen de ${personLabel(p.person)}`}><Copy /> Copiar resumen</Button>
                  </div>
                </li>
              );
            })}
          </ul>
        ) : (
          <div className="rounded-xl border border-dashed p-5 text-center text-sm text-muted-foreground">Nadie te debe nada de tu ahorro.</div>
        )}
      </section>

      <section aria-label="Movimientos del ahorro">
        <div className="mb-3 flex flex-wrap items-center gap-2" role="group" aria-label="Filtrar por tipo">
          <button className={`rounded-full border px-3 py-1 text-sm ${kind === 'all' ? 'bg-primary text-primary-foreground' : ''}`} onClick={() => setKind('all')}>Todos ({o.moves.length})</button>
          {KIND_ORDER.map((k) => (
            <button key={k} title={KIND[k].help} className={`rounded-full border px-3 py-1 text-sm ${kind === k ? 'bg-primary text-primary-foreground' : ''}`} onClick={() => setKind(k)}>
              {KIND[k].plural} ({counts(k)})
            </button>
          ))}
          {person !== undefined && (
            <Badge variant="info" className="ml-2">Solo {personLabel(person)} <button className="ml-1" aria-label="Quitar filtro de persona" onClick={() => setPerson(undefined)}>✕</button></Badge>
          )}
        </div>
        <div className="overflow-x-auto rounded-xl border bg-card shadow-sm">
          <table className="simple">
            <thead>
              <tr><th>Fecha</th><th>Tipo</th><th>Concepto</th><th>Persona</th><th>Objetivo</th><th className="r">Monto</th><th className="r">Saldo</th></tr>
            </thead>
            <tbody>
              {rows.map((m) => {
                const K = KIND[m.kind];
                return (
                  <tr key={m.key}>
                    <td className="num whitespace-nowrap">{m.date}</td>
                    <td><Badge variant={K.variant}><K.icon className="size-3" /> {K.label}</Badge></td>
                    <td>{m.concept}</td>
                    <td>{m.kind === 'loan' || m.kind === 'return' ? <span className={m.person ? '' : 'text-muted-foreground'}>{personLabel(m.person)}</span> : ''}</td>
                    <td>{m.bucket ? <Badge variant="outline">{m.bucket}</Badge> : null}</td>
                    <td className="r"><Money v={m.amount} signed /></td>
                    <td className="r"><Money v={m.balance} /></td>
                  </tr>
                );
              })}
              {!rows.length && <tr><td colSpan={7} className="empty">Sin movimientos con este filtro.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
