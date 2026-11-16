import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Archive, ArchiveRestore, Check, Pencil, Plus, Trash2, X } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { del, get, patch, post } from '../../app/api';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { Input, NativeSelect } from '../../components/ui/input';
import { Field } from '../../components/ui/label';
import { useToast } from '../../components/ui';

const GROUPS = ['Ingresos', 'Egresos', 'Gasto', 'Inversion', 'Otros'] as const;
type Group = (typeof GROUPS)[number];

interface CatUsage { id: string; name: string; groupName: Group; archived: boolean; uses: number; lastUsed: string | null; examples: string[] }

/** Alta, edición, archivado y borrado (o fusión) de los rubros. */
export function CategoriesPage() {
  const toast = useToast();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['categories-usage'], queryFn: () => get<CatUsage[]>('/api/categories/usage') });
  const [name, setName] = useState('');
  const [group, setGroup] = useState<Group>('Gasto');
  const [showArchived, setShowArchived] = useState(false);
  const cats = q.data ?? [];

  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: ['categories-usage'] }), qc.invalidateQueries({ queryKey: ['categories'] })]);

  async function add(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    try {
      await post('/api/categories', { name: name.trim(), groupName: group });
      toast.ok(`Rubro «${name.trim()}» creado`);
      setName('');
      await refresh();
    } catch (err) { toast.error(err); }
  }

  const visible = cats.filter((c) => showArchived || !c.archived);
  const archivedCount = cats.filter((c) => c.archived).length;

  return (
    <div className="flex flex-col gap-6">
      <div className="page-head !mb-0"><h1>Categorías</h1></div>

      <form onSubmit={add} className="grid gap-3 rounded-2xl border bg-card p-5 shadow-sm md:grid-cols-[1fr_200px_auto] md:items-end" aria-label="Nueva categoría">
        <Field label="Nueva categoría"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Ej.: Reintegros" /></Field>
        <Field label="Tipo"><NativeSelect value={group} onChange={(e) => setGroup(e.target.value as Group)} aria-label="Tipo">{GROUPS.map((g) => <option key={g}>{g}</option>)}</NativeSelect></Field>
        <Button type="submit" disabled={!name.trim()}><Plus /> Crear</Button>
      </form>

      {q.isLoading && <p className="text-muted-foreground">Cargando…</p>}
      {GROUPS.map((g) => {
        const rows = visible.filter((c) => c.groupName === g);
        if (!rows.length) return null;
        return (
          <section key={g} className="rounded-2xl border bg-card p-5 shadow-sm" aria-label={g}>
            <h2 className="!mb-3 text-base">{g} <span className="text-sm font-normal text-muted-foreground">· {rows.length}</span></h2>
            <ul className="divide-y">
              {rows.map((c) => <CategoryRow key={c.id} cat={c} others={cats.filter((o) => o.id !== c.id && !o.archived)} onChanged={refresh} />)}
            </ul>
          </section>
        );
      })}
      {archivedCount > 0 && (
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> Mostrar archivadas ({archivedCount})
        </label>
      )}
    </div>
  );
}

function CategoryRow({ cat, others, onChanged }: { cat: CatUsage; others: CatUsage[]; onChanged: () => Promise<unknown> }) {
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(cat.name);
  const [group, setGroup] = useState<Group>(cat.groupName);
  const [deleting, setDeleting] = useState(false);
  const [moveTo, setMoveTo] = useState('');

  async function run(fn: () => Promise<unknown>, okMsg?: string) {
    try { await fn(); if (okMsg) toast.ok(okMsg); await onChanged(); } catch (err) { toast.error(err); }
  }
  const save = () => run(async () => { await patch(`/api/categories/${cat.id}`, { name: name.trim(), groupName: group }); setEditing(false); }, 'Guardado');
  const remove = () => run(async () => {
    await del(`/api/categories/${cat.id}`, moveTo ? { moveToId: moveTo } : {});
    setDeleting(false);
  }, cat.uses ? `«${cat.name}» borrada; ${cat.uses} movimiento(s) pasaron a otro rubro` : `«${cat.name}» borrada`);

  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-2 py-2.5">
      {editing ? (
        <>
          <Input className="max-w-xs" value={name} onChange={(e) => setName(e.target.value)} aria-label="Nombre" autoFocus onKeyDown={(e) => e.key === 'Enter' && save()} />
          <NativeSelect className="w-40" value={group} onChange={(e) => setGroup(e.target.value as Group)} aria-label="Tipo">{GROUPS.map((g) => <option key={g}>{g}</option>)}</NativeSelect>
          <Button size="sm" onClick={save} disabled={!name.trim()}><Check /> Guardar</Button>
          <Button size="sm" variant="ghost" onClick={() => { setEditing(false); setName(cat.name); setGroup(cat.groupName); }}><X /> Cancelar</Button>
        </>
      ) : (
        <>
          <div className="min-w-[200px] flex-1">
            <span className="font-medium">{cat.name}</span> {cat.archived && <Badge variant="outline">archivada</Badge>}
            <div className="truncate text-xs text-muted-foreground">
              {cat.uses ? `${cat.uses} movimiento${cat.uses === 1 ? '' : 's'}${cat.examples.length ? ` · ${cat.examples.slice(0, 3).join(', ')}` : ''}` : 'Sin movimientos'}
            </div>
          </div>
          <Button size="sm" variant="ghost" onClick={() => setEditing(true)} aria-label={`Editar ${cat.name}`}><Pencil /> Editar</Button>
          <Button size="sm" variant="ghost" onClick={() => run(() => patch(`/api/categories/${cat.id}`, { archived: !cat.archived }))} aria-label={`${cat.archived ? 'Desarchivar' : 'Archivar'} ${cat.name}`}>
            {cat.archived ? <><ArchiveRestore /> Desarchivar</> : <><Archive /> Archivar</>}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setDeleting((d) => !d)} aria-label={`Borrar ${cat.name}`}><Trash2 /> Borrar</Button>
        </>
      )}
      {deleting && (
        <div className="flex w-full flex-wrap items-center gap-3 rounded-lg border border-destructive/40 p-3 text-sm">
          {cat.uses > 0 ? (
            <>
              <span>Tiene {cat.uses} movimiento{cat.uses === 1 ? '' : 's'}. Pásalos a:</span>
              <NativeSelect className="w-60" value={moveTo} onChange={(e) => setMoveTo(e.target.value)} aria-label="Rubro destino">
                <option value="">Elegir rubro…</option>
                {others.map((o) => <option key={o.id} value={o.id}>{o.name} · {o.groupName}</option>)}
              </NativeSelect>
            </>
          ) : <span>¿Borrar «{cat.name}»?</span>}
          <Button size="sm" variant="destructive" onClick={remove} disabled={cat.uses > 0 && !moveTo}>Confirmar borrado</Button>
          <Button size="sm" variant="ghost" onClick={() => setDeleting(false)}>Cancelar</Button>
        </div>
      )}
    </li>
  );
}
