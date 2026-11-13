import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent } from 'react';
import { del, get, patch, post } from '../../app/api';
import type { SplitView } from '../../app/types';
import { DataGrid, type Column } from '../../components/DataGrid';
import { Kpi, Money, money, today, useToast } from '../../components/ui';

interface Row { id: string; label: string; total: number; discountPct: number; shares: Record<string, number>; net: number; byPerson: Record<string, number>; sumShares: number }

const pctStr = (f: number) => String(Math.round(f * 10000) / 100);
const toFraction = (raw: string) => {
  const n = Number(raw.replace('%', '').replace(',', '.'));
  if (!Number.isFinite(n) || n < 0 || n > 100) throw new Error('Ingresa un porcentaje entre 0 y 100');
  return n / 100;
};

export function SplitsPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const list = useQuery({ queryKey: ['splits'], queryFn: () => get<{ id: string; name: string; date: string }[]>('/api/splits') });
  const [id, setId] = useState('');
  const [creating, setCreating] = useState(false);
  useEffect(() => { if (!id && list.data?.length) setId(list.data[0].id); }, [list.data, id]);
  const q = useQuery({ queryKey: ['split', id], enabled: !!id, queryFn: () => get<SplitView>(`/api/splits/${id}`) });
  const s = q.data;
  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: ['split'] }), qc.invalidateQueries({ queryKey: ['splits'] })]);

  const rows: Row[] = (s?.items ?? []).map((it, i) => ({
    ...it, net: s!.result.items[i].net, byPerson: s!.result.items[i].byPerson,
    sumShares: Object.values(it.shares).reduce((a, b) => a + b, 0),
  }));

  const columns: Column<Row>[] = s ? [
    { key: 'label', label: 'Ítem', width: 170, editable: true, value: (r) => r.label },
    { key: 'total', label: 'Total', width: 110, align: 'right', kind: 'money', editable: true, value: (r) => r.total, display: (r) => money(r.total) },
    { key: 'discount', label: 'Desc. %', width: 80, align: 'right', kind: 'number', editable: true, value: (r) => pctStr(r.discountPct) },
    { key: 'net', label: 'Neto', width: 110, align: 'right', value: (r) => r.net, display: (r) => money(r.net) },
    ...s.participants.map((p): Column<Row> => ({ key: `share:${p}`, label: `${p} %`, width: 88, align: 'right', kind: 'number', editable: true, value: (r) => pctStr(r.shares[p] ?? 0), cellClass: (r) => (Math.abs(r.sumShares - 1) > 1e-9 ? 'warn' : '') })),
    ...s.participants.map((p): Column<Row> => ({ key: `amt:${p}`, label: p, width: 110, align: 'right', value: (r) => r.byPerson[p], display: (r) => <b>{money(r.byPerson[p])}</b> })),
    { key: 'chk', label: '', width: 90, value: () => '', display: (r) => (Math.abs(r.sumShares - 1) > 1e-9 ? <span className="badge warn" title="Los porcentajes de esta fila no suman 100">{pctStr(r.sumShares)}%</span> : '') },
    { key: 'del', label: '', width: 46, value: () => '', display: (r) => <button className="btn sm danger" aria-label={`Quitar ${r.label || 'ítem'}`} onMouseDown={(e) => e.stopPropagation()} onClick={async () => { try { await del(`/api/split-items/${r.id}`); await refresh(); } catch (e) { toast.error(e); } }}>✕</button> },
  ] : [];

  async function onCommit(itemId: string, col: string, raw: string) {
    const row = rows.find((r) => r.id === itemId)!;
    if (col === 'label') await patch(`/api/split-items/${itemId}`, { label: raw });
    else if (col === 'total') await patch(`/api/split-items/${itemId}`, { total: Math.max(0, Number(raw.replace(/\./g, '').replace(',', '.')) || 0) });
    else if (col === 'discount') await patch(`/api/split-items/${itemId}`, { discountPct: toFraction(raw) });
    else if (col.startsWith('share:')) await patch(`/api/split-items/${itemId}`, { shares: { ...row.shares, [col.slice(6)]: toFraction(raw) } });
    await refresh();
  }

  const warnCount = s?.shareErrors.length ?? 0;

  return (
    <>
      <div className="page-head">
        <h1>Distribución de compras</h1>
        <div className="toolbar">
          <select className="field" value={id} onChange={(e) => setId(e.target.value)} aria-label="Reparto">
            {(list.data ?? []).map((x) => <option key={x.id} value={x.id}>{x.name} · {x.date}</option>)}
          </select>
          <button className="btn primary" onClick={() => setCreating(!creating)}>+ Nuevo reparto</button>
        </div>
      </div>
      {creating && <NewSplit onDone={async (newId) => { await refresh(); setId(newId); setCreating(false); }} />}

      {s && (
        <>
          <div className="grid-cards">
            {s.participants.map((p) => <Kpi key={p} label={`Total ${p}`} value={<Money v={s.result.totals[p] ?? 0} />} />)}
            <Kpi label="Suma de todos" value={<Money v={Object.values(s.result.totals).reduce((a, b) => a + b, 0)} />} sub={s.result.roundingDiff ? `Diferencia por redondeo: ${s.result.roundingDiff}` : 'Sin diferencia de redondeo'} />
          </div>
          {warnCount > 0 && <p className="warn" role="alert">{warnCount} ítem(s) tienen porcentajes que no suman 100%.</p>}
          <DataGrid
            ariaLabel="Ítems del reparto"
            columns={columns}
            rows={rows}
            rowId={(r) => r.id}
            onCommit={onCommit}
            onError={toast.error}
            height={Math.min(560, 34 * (rows.length + 2))}
            footer={
              <>
                <div className="dg-cell" style={{ width: 170 + 110 + 80 + 110 + 88 * s.participants.length }}>Totales por persona</div>
                {s.participants.map((p) => <div key={p} className="dg-cell r" style={{ width: 110 }}>{money(s.result.totals[p] ?? 0)}</div>)}
              </>
            }
          />
          <AddItem split={s} onAdded={refresh} />
          <p className="muted">Porcentajes en 0–100. El redondeo es por persona (como en tu plantilla): puede quedar 1 guaraní de diferencia en la suma.</p>
        </>
      )}
      {!s && !list.isLoading && <div className="empty">Crea un reparto para dividir una compra entre personas con descuentos.</div>}
    </>
  );
}

function NewSplit({ onDone }: { onDone: (id: string) => void }) {
  const toast = useToast();
  const [name, setName] = useState('');
  const [people, setPeople] = useState('Emma, Ali, Yo');
  return (
    <form className="card toolbar" style={{ marginBottom: 14 }} onSubmit={async (e: FormEvent) => {
      e.preventDefault();
      try { onDone((await post('/api/splits', { name, date: today(), participants: people.split(',').map((x) => x.trim()).filter(Boolean) })).id); } catch (err) { toast.error(err); }
    }}>
      <input className="field" placeholder="Nombre (p. ej. Super de noviembre)" value={name} onChange={(e) => setName(e.target.value)} required />
      <input className="field" value={people} onChange={(e) => setPeople(e.target.value)} style={{ minWidth: 220 }} aria-label="Participantes separados por coma" />
      <button className="btn primary">Crear</button>
    </form>
  );
}

function AddItem({ split, onAdded }: { split: SplitView; onAdded: () => unknown }) {
  const toast = useToast();
  const [label, setLabel] = useState('');
  const [total, setTotal] = useState('');
  const [disc, setDisc] = useState('20');
  const n = split.participants.length;
  return (
    <form className="toolbar card" style={{ margin: '10px 0', padding: 10 }} onSubmit={async (e) => {
      e.preventDefault();
      const shares = Object.fromEntries(split.participants.map((p) => [p, 1 / n]));
      try { await post(`/api/splits/${split.id}/items`, { label, total: Number(total.replace(/\./g, '').replace(',', '.')), discountPct: toFraction(disc), shares }); setLabel(''); setTotal(''); await onAdded(); } catch (err) { toast.error(err); }
    }}>
      <input className="field" placeholder="Ítem" value={label} onChange={(e) => setLabel(e.target.value)} aria-label="Ítem" />
      <input className="field num" placeholder="Total" value={total} onChange={(e) => setTotal(e.target.value)} required style={{ width: 130, textAlign: 'right' }} aria-label="Total" />
      <input className="field num" value={disc} onChange={(e) => setDisc(e.target.value)} style={{ width: 70, textAlign: 'right' }} aria-label="Descuento %" /> %
      <button className="btn primary">Agregar (reparto parejo)</button>
    </form>
  );
}
