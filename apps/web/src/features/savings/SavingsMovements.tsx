import { useQuery } from '@tanstack/react-query';
import { ArrowDownToLine, ArrowUpFromLine, Copy, HandCoins, Undo2, Users } from 'lucide-react';
import { useMemo, useState } from 'react';
import { get, friendly } from '../../app/api';
import type { SavingsMove, SavingsMoveKind, SavingsOverview, SavingsPerson } from '../../app/types';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { Kpi, Money, money, useToast } from '../../components/ui';

export const KIND: Record<SavingsMoveKind, { label: string; plural: string; variant: 'ok' | 'warn' | 'info' | 'bad'; icon: typeof HandCoins; help: string }> = {
  deposit: { label: 'Depósito', plural: 'Depósitos', variant: 'ok', icon: ArrowDownToLine, help: 'Plata que pusiste en tu ahorro' },
  withdrawal: { label: 'Extracción', plural: 'Extracciones', variant: 'bad', icon: ArrowUpFromLine, help: 'Sacaste tu ahorro (meta cumplida u otro motivo); no se devuelve' },
  loan: { label: 'Préstamo', plural: 'Préstamos', variant: 'warn', icon: HandCoins, help: 'Sale de tu ahorro pero hay que devolverlo' },
  return: { label: 'Devolución', plural: 'Devoluciones', variant: 'info', icon: Undo2, help: 'Plata que vuelve a tu ahorro' },
};
const KIND_ORDER: SavingsMoveKind[] = ['deposit', 'withdrawal', 'loan', 'return'];

/** Persona sin nombre = préstamos normales (los que no son de nadie en particular). */
export const personLabel = (p: string | null) => p ?? 'Préstamos normales';
const fmtDate = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}`;
export const NO_BUCKET = 'Sin asignar';

/** Texto listo para mandarle a quien debe: qué se le prestó, cuándo y cuánto falta. */
function summaryText(p: SavingsPerson, moves: SavingsMove[]): string {
  const mine = moves.filter((m) => (m.kind === 'loan' || m.kind === 'return') && m.person === p.person).reverse();
  const lines = mine.map((m) => `• ${fmtDate(m.date)} ${m.concept}: ${m.kind === 'loan' ? '' : '− '}${money(Math.abs(m.amount))}${m.kind === 'return' ? ' (pagado)' : ''}`);
  const head = p.person ? `${p.person}, esto es lo que me debes de mi ahorro:` : 'Préstamos normales de mi ahorro:';
  return `${head}\n${lines.join('\n')}\nPrestado ${money(p.lent)} · devuelto ${money(p.returned)} · pendiente ${money(p.pending)}`;
}

/** Carga el resumen del ahorro; sirve a todas las pestañas para que compartan los datos. */
export function useSavingsOverview(accountId: string) {
  return useQuery({ queryKey: ['savings-overview', accountId], queryFn: () => get<SavingsOverview>(`/api/accounts/${accountId}/savings-overview`) });
}

/** Contenedor que muestra carga y, sobre todo, el error real si algo falla (en vez de quedarse "cargando"). */
export function WithOverview({ accountId, children }: { accountId: string; children: (o: SavingsOverview) => React.ReactNode }) {
  const q = useSavingsOverview(accountId);
  if (q.isError) {
    return (
      <div className="rounded-xl border border-rose-300 bg-rose-50 p-4 text-sm dark:bg-rose-950/40">
        <p className="font-medium">No se pudieron cargar los movimientos del ahorro.</p>
        <p className="mt-1 text-muted-foreground">{friendly(q.error)}</p>
        <Button className="mt-3" size="sm" variant="outline" onClick={() => q.refetch()}>Reintentar</Button>
      </div>
    );
  }
  if (!q.data) return <p className="text-sm text-muted-foreground">Cargando…</p>;
  return <>{children(q.data)}</>;
}

/** Tarjeta de una persona que me debe del ahorro (usada en Préstamos y en "Me deben de mi ahorro"). */
export function PersonCard({ p, moves, on, onPick }: { p: SavingsPerson; moves: SavingsMove[]; on?: boolean; onPick?: () => void }) {
  const toast = useToast();
  async function copy() {
    try {
      await navigator.clipboard.writeText(summaryText(p, moves));
      toast.ok(`Resumen de ${personLabel(p.person)} copiado`);
    } catch (e) { toast.error(e); }
  }
  return (
    <li className={`rounded-xl border p-4 transition-colors ${on ? 'border-primary bg-primary/5' : ''}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="font-medium">{personLabel(p.person)}</div>
        <Badge variant={p.pending > 0 ? 'warn' : 'ok'}>{p.pending > 0 ? 'Debe' : 'Saldado'}</Badge>
      </div>
      <div className={`num mt-2 text-2xl font-semibold ${p.pending > 0 ? 'neg' : ''}`}>{money(p.pending)}</div>
      <div className="mt-1 text-xs text-muted-foreground">prestado {money(p.lent)} · devuelto {money(p.returned)}</div>
      <div className="mt-3 flex flex-wrap gap-2">
        {onPick && <Button size="sm" variant={on ? 'default' : 'outline'} onClick={onPick}>{on ? 'Ver todos' : 'Ver detalle'}</Button>}
        <Button size="sm" variant="ghost" onClick={copy} aria-label={`Copiar resumen de ${personLabel(p.person)}`}><Copy /> Copiar resumen</Button>
      </div>
    </li>
  );
}

/** Tabla de movimientos del ahorro, del más nuevo al más viejo. `moves` llega en orden cronológico. */
export function MovesTable({ moves, empty = 'Sin movimientos.', ariaLabel }: { moves: SavingsMove[]; empty?: string; ariaLabel: string }) {
  const rows = [...moves].reverse();
  return (
    <div className="overflow-x-auto rounded-xl border bg-card shadow-sm">
      <table className="simple" aria-label={ariaLabel}>
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
          {!rows.length && <tr><td colSpan={7} className="empty">{empty}</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

/** Chips para filtrar por tipo. */
function KindChips({ moves, value, onChange, kinds = KIND_ORDER }: { moves: SavingsMove[]; value: SavingsMoveKind | 'all'; onChange: (k: SavingsMoveKind | 'all') => void; kinds?: SavingsMoveKind[] }) {
  const on = 'bg-primary text-primary-foreground';
  return (
    <div className="mb-3 flex flex-wrap items-center gap-2" role="group" aria-label="Filtrar por tipo">
      <button className={`rounded-full border px-3 py-1 text-sm ${value === 'all' ? on : ''}`} onClick={() => onChange('all')}>Todos ({moves.length})</button>
      {kinds.map((k) => (
        <button key={k} title={KIND[k].help} className={`rounded-full border px-3 py-1 text-sm ${value === k ? on : ''}`} onClick={() => onChange(k)}>
          {KIND[k].plural} ({moves.filter((m) => m.kind === k).length})
        </button>
      ))}
    </div>
  );
}

/** Movimientos de un objetivo con su propio saldo acumulado (el relatorio del objetivo). */
export function bucketMoves(moves: SavingsMove[], bucket: string): SavingsMove[] {
  let bal = 0;
  return moves
    .filter((m) => (bucket === NO_BUCKET ? !m.bucket : m.bucket === bucket))
    .map((m) => { bal += m.amount; return { ...m, balance: bal }; });
}

export function ObjectiveMoves({ accountId, bucket, onClose }: { accountId: string; bucket: string; onClose: () => void }) {
  return (
    <WithOverview accountId={accountId}>
      {(o) => {
        const list = bucketMoves(o.moves, bucket);
        const total = list.reduce((s, m) => s + m.amount, 0);
        return (
          <section className="rounded-xl border bg-muted/20 p-4" aria-label={`Movimientos del objetivo ${bucket}`}>
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <h3 className="!mb-0 text-base">{bucket === NO_BUCKET ? 'Sin objetivo (préstamos por reponer)' : bucket} · <Money v={total} signed /></h3>
              <Button size="sm" variant="ghost" onClick={onClose}>Cerrar</Button>
            </div>
            <MovesTable moves={list} ariaLabel={`Relatorio de ${bucket}`} empty="Este objetivo no tiene movimientos." />
          </section>
        );
      }}
    </WithOverview>
  );
}

/** Todos los depósitos, con el total por objetivo. */
export function DepositsView({ accountId }: { accountId: string }) {
  return (
    <WithOverview accountId={accountId}>
      {(o) => {
        const list = o.moves.filter((m) => m.kind === 'deposit');
        const byBucket = new Map<string, number>();
        for (const m of list) byBucket.set(m.bucket ?? NO_BUCKET, (byBucket.get(m.bucket ?? NO_BUCKET) ?? 0) + m.amount);
        return (
          <div className="flex flex-col gap-5">
            <div className="grid-cards !mb-0">
              <Kpi label="Total depositado" value={<Money v={o.totals.deposits} />} tone="pos" sub={`${list.length} depósitos`} />
              {[...byBucket].map(([b, v]) => <Kpi key={b} label={b} value={<Money v={v} />} sub="depositado" />)}
            </div>
            <MovesTable moves={list} ariaLabel="Depósitos del ahorro" empty="Todavía no hay depósitos." />
          </div>
        );
      }}
    </WithOverview>
  );
}

/** Todos los movimientos, con filtro por tipo. */
export function AllMovesView({ accountId }: { accountId: string }) {
  const [kind, setKind] = useState<SavingsMoveKind | 'all'>('all');
  return (
    <WithOverview accountId={accountId}>
      {(o) => (
        <div className="flex flex-col gap-5">
          <div className="grid-cards !mb-0">
            <Kpi label="Depósitos" value={<Money v={o.totals.deposits} />} tone="pos" sub="lo que pusiste" />
            <Kpi label="Extracciones" value={<Money v={o.totals.withdrawals} />} sub="lo que sacaste de tu ahorro" />
            <Kpi label="Prestado" value={<Money v={o.totals.lent} />} sub={`devuelto ${money(o.totals.returned)}`} />
            <Kpi label="Por devolver" value={<Money v={o.totals.pending} />} tone={o.totals.pending > 0 ? 'neg' : undefined} sub="falta que vuelva" />
          </div>
          <div>
            <KindChips moves={o.moves} value={kind} onChange={setKind} />
            <MovesTable moves={o.moves.filter((m) => kind === 'all' || m.kind === kind)} ariaLabel="Movimientos del ahorro" empty="Sin movimientos con este filtro." />
          </div>
        </div>
      )}
    </WithOverview>
  );
}

/** Préstamos: quién me debe (general) y el detalle de cada préstamo y devolución. */
export function LoansView({ accountId }: { accountId: string }) {
  // undefined = todas las personas; null = préstamos normales; string = esa persona.
  const [person, setPerson] = useState<string | null | undefined>(undefined);
  const [kind, setKind] = useState<SavingsMoveKind | 'all'>('all');
  return (
    <WithOverview accountId={accountId}>
      {(o) => <LoansBody o={o} person={person} setPerson={setPerson} kind={kind} setKind={setKind} />}
    </WithOverview>
  );
}

function LoansBody({ o, person, setPerson, kind, setKind }: {
  o: SavingsOverview; person: string | null | undefined; setPerson: (p: string | null | undefined) => void;
  kind: SavingsMoveKind | 'all'; setKind: (k: SavingsMoveKind | 'all') => void;
}) {
  const loans = useMemo(() => o.moves.filter((m) => m.kind === 'loan' || m.kind === 'return'), [o.moves]);
  const list = loans.filter((m) => (kind === 'all' || m.kind === kind) && (person === undefined || m.person === person));
  const owing = o.people.filter((p) => p.pending !== 0);
  return (
    <div className="flex flex-col gap-6">
      <div className="grid-cards !mb-0">
        <Kpi label="Prestado en total" value={<Money v={o.totals.lent} />} sub={`${o.moves.filter((m) => m.kind === 'loan').length} préstamos`} />
        <Kpi label="Devuelto" value={<Money v={o.totals.returned} />} tone="pos" sub={`${o.moves.filter((m) => m.kind === 'return').length} devoluciones`} />
        <Kpi label="Por devolver" value={<Money v={o.totals.pending} />} tone={o.totals.pending > 0 ? 'neg' : 'pos'} sub={`${owing.length} persona${owing.length === 1 ? '' : 's'} con saldo`} />
      </div>

      <section aria-label="Préstamos por persona">
        <h3 className="!mb-3 flex items-center gap-2 text-base"><Users className="size-4" /> Quién me debe</h3>
        {owing.length ? (
          <ul className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {owing.map((p) => (
              <PersonCard key={p.person ?? '__normal'} p={p} moves={o.moves} on={person === p.person}
                onPick={() => { setPerson(person === p.person ? undefined : p.person); setKind('all'); }} />
            ))}
          </ul>
        ) : (
          <div className="rounded-xl border border-dashed p-5 text-center text-sm text-muted-foreground">Nadie te debe nada de tu ahorro.</div>
        )}
      </section>

      <section aria-label="Detalle de préstamos">
        <h3 className="!mb-3 text-base">Detalle {person !== undefined && <>de <b>{personLabel(person)}</b> <button className="ml-1 text-xs underline" onClick={() => setPerson(undefined)}>ver todos</button></>}</h3>
        <KindChips moves={loans.filter((m) => person === undefined || m.person === person)} value={kind} onChange={setKind} kinds={['loan', 'return']} />
        <MovesTable moves={list} ariaLabel="Detalle de préstamos y devoluciones" empty="Sin préstamos con este filtro." />
      </section>
    </div>
  );
}
