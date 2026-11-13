import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { Bot, ChevronDown, ChevronRight, Pencil, Plus, Trash2, Undo2, User } from 'lucide-react';
import { useState } from 'react';
import { get, post, qs } from '../../app/api';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { useToast } from '../../components/ui';

interface Change { column: string; before: unknown; after: unknown }
interface Entry { id: string; table: string; tableLabel: string; op: 'INSERT' | 'UPDATE' | 'DELETE'; label: string; changes: Change[] }
interface Action { txId: number; total: number; at: string; actor: string; reverted: boolean; summary: string; entries: Entry[] }
interface Page { actions: Action[]; nextBefore: number | null }

const OP = {
  INSERT: { icon: Plus, label: 'Creó', tone: 'text-emerald-700 dark:text-emerald-300' },
  UPDATE: { icon: Pencil, label: 'Editó', tone: 'text-amber-700 dark:text-amber-300' },
  DELETE: { icon: Trash2, label: 'Eliminó', tone: 'text-rose-700 dark:text-rose-300' },
} as const;

const FILTERS = [
  { id: '', label: 'Todo' },
  { id: 'ia', label: 'Hecho por la IA' },
  { id: 'web', label: 'Hecho por mí' },
] as const;

const show = (v: unknown) => (v === null || v === undefined || v === '' ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v));
const when = (iso: string) => new Date(iso).toLocaleString('es-PY', { dateStyle: 'medium', timeStyle: 'short' });

function Who({ actor }: { actor: string }) {
  if (actor.startsWith('ia')) return <Badge variant="info"><Bot className="size-3" /> {actor.replace(/^ia:?\s*/, '') || 'IA'}</Badge>;
  if (actor === 'web') return <Badge variant="outline"><User className="size-3" /> Yo</Badge>;
  if (actor.includes('deshacer')) return <Badge variant="warn"><Undo2 className="size-3" /> Deshacer</Badge>;
  return <Badge variant="outline">{actor}</Badge>;
}

/** Historial de cambios: quién creó, editó o borró qué, con la opción de deshacer cada acción. */
export function HistoryPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const [filter, setFilter] = useState<string>('');
  const [open, setOpen] = useState<number | null>(null);
  const [confirming, setConfirming] = useState<number | null>(null);

  const q = useInfiniteQuery({
    queryKey: ['audit', filter],
    initialPageParam: undefined as number | undefined,
    queryFn: ({ pageParam }) => get<Page>('/api/audit' + qs({ limit: 30, before: pageParam, actor: filter || undefined })),
    getNextPageParam: (p) => p.nextBefore ?? undefined,
  });
  const actions = (q.data?.pages ?? []).flatMap((p) => p.actions);

  async function undo(a: Action) {
    try {
      const r = await post<{ reverted: number }>(`/api/audit/${a.txId}/revert`);
      toast.ok(`Deshecho (${r.reverted} cambio${r.reverted === 1 ? '' : 's'})`);
      setConfirming(null);
      await qc.invalidateQueries(); // lo deshecho puede afectar cualquier pantalla
    } catch (e) { toast.error(e); }
  }

  return (
    <div className="flex flex-col gap-8 pb-10">
      <div className="page-head !mb-0">
        <div className="max-w-2xl">
          <h1>Historial</h1>
          <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
            Todo lo que se crea, edita o borra queda registrado, venga de la web o de la IA. Puedes deshacer cualquier acción; deshacer también queda anotado, así que siempre se puede volver atrás.
          </p>
        </div>
        <div className="chips" role="group" aria-label="Filtrar historial">
          {FILTERS.map((f) => (
            <button type="button" key={f.id} className={filter === f.id ? 'on' : ''} onClick={() => setFilter(f.id)}>{f.label}</button>
          ))}
        </div>
      </div>

      <ul className="flex flex-col gap-3" aria-label="Acciones del historial">
        {actions.map((a) => {
          const first = a.entries[0];
          const op = OP[first.op];
          const Icon = op.icon;
          const expanded = open === a.txId;
          return (
            <li key={a.txId} className={`rounded-2xl border bg-card p-5 shadow-sm ${a.reverted ? 'opacity-60' : ''}`}>
              <div className="flex flex-wrap items-start justify-between gap-4">
                <button type="button" className="flex min-w-0 flex-1 items-start gap-3 text-left" onClick={() => setOpen(expanded ? null : a.txId)} aria-expanded={expanded}>
                  <span className={`mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg bg-muted ${op.tone}`}><Icon className="size-4" /></span>
                  <span className="min-w-0">
                    <span className="block truncate font-medium">{a.summary}</span>
                    <span className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      {when(a.at)} <Who actor={a.actor} />
                      {a.reverted && <Badge variant="outline">Deshecho</Badge>}
                    </span>
                  </span>
                  {expanded ? <ChevronDown className="mt-1 size-4 shrink-0 text-muted-foreground" /> : <ChevronRight className="mt-1 size-4 shrink-0 text-muted-foreground" />}
                </button>
                {!a.reverted && (
                  confirming === a.txId ? (
                    <div className="flex items-center gap-2">
                      <span className="text-sm text-muted-foreground">¿Deshacer esta acción?</span>
                      <Button size="sm" onClick={() => undo(a)}>Sí, deshacer</Button>
                      <Button size="sm" variant="ghost" onClick={() => setConfirming(null)}>Cancelar</Button>
                    </div>
                  ) : (
                    <Button size="sm" variant="outline" aria-label={`Deshacer: ${a.summary}`} onClick={() => setConfirming(a.txId)}><Undo2 /> Deshacer</Button>
                  )
                )}
              </div>

              {expanded && (
                <ul className="mt-4 flex flex-col gap-2 border-t pt-4 text-sm">
                  {a.total > a.entries.length && <li className="text-xs text-muted-foreground">Mostrando {a.entries.length} de {a.total} cambios.</li>}
                  {a.entries.map((e) => (
                    <li key={e.id} className="rounded-lg bg-muted/50 p-3">
                      <div><b className={OP[e.op].tone}>{OP[e.op].label}</b> {e.tableLabel.toLowerCase()}{e.label ? `: ${e.label}` : ''}</div>
                      {e.changes.length > 0 && (
                        <ul className="mt-1.5 flex flex-col gap-1 text-xs text-muted-foreground">
                          {e.changes.map((c) => <li key={c.column}><span className="font-medium">{c.column}</span>: {show(c.before)} → <b>{show(c.after)}</b></li>)}
                        </ul>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ul>

      {!actions.length && !q.isLoading && <div className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">Todavía no hay cambios registrados.</div>}
      {q.hasNextPage && <div className="flex justify-center"><Button variant="outline" onClick={() => q.fetchNextPage()} disabled={q.isFetchingNextPage}>Cargar más</Button></div>}
    </div>
  );
}
