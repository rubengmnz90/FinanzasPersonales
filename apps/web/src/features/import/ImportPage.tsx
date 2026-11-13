import { useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, FileSpreadsheet, TriangleAlert, Upload, XCircle } from 'lucide-react';
import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { upload } from '../../app/api';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { useToast } from '../../components/ui';

interface Report {
  created: Record<string, number>;
  skipped: { sheet: string; row: number; reason: string }[];
  warnings: string[];
  reconciliation: { name: string; excel: number; app: number; ok: boolean; note?: string }[];
}

type Phase = 'idle' | 'analyzing' | 'ready' | 'importing' | 'done';

const fmt = (n: number) => new Intl.NumberFormat('es-PY').format(n);
const kb = (n: number) => (n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/** Importa el Excel (Administracion 2026.xlsx) cuando quieras: simulación primero, luego confirmar. El archivo no se guarda en el servidor. */
export function ImportPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [report, setReport] = useState<Report | null>(null);

  const reset = () => {
    setFile(null); setReport(null); setPhase('idle');
    if (input.current) input.current.value = '';
  };

  async function analyze(f: File) {
    setFile(f); setReport(null); setPhase('analyzing');
    try {
      setReport(await upload<Report>('/api/import?dryRun=1', f));
      setPhase('ready');
    } catch (e) {
      toast.error(e);
      reset();
    }
  }

  async function confirm() {
    if (!file) return;
    setPhase('importing');
    try {
      setReport(await upload<Report>('/api/import?dryRun=0', file));
      setPhase('done');
      await qc.invalidateQueries(); // todas las pantallas cambian
      toast.ok('Importación lista');
    } catch (e) {
      toast.error(e);
      setPhase('ready');
    }
  }

  const created = report ? Object.entries(report.created).filter(([, n]) => n > 0) : [];
  const total = created.reduce((s, [, n]) => s + n, 0);
  const bad = report?.reconciliation.filter((r) => !r.ok) ?? [];
  const busy = phase === 'analyzing' || phase === 'importing';

  return (
    <div className="flex flex-col gap-8 pb-10">
      <div className="page-head !mb-0">
        <div className="max-w-2xl">
          <h1>Importar Excel</h1>
          <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
            Sube tu <b>Administracion 2026.xlsx</b> cuando quieras. Primero ves una simulación (no guarda nada) y recién después confirmas.
            Puedes repetirlo sin duplicar: solo se agrega lo que falta. El archivo <b>no se guarda en el servidor</b>: se lee y se borra al terminar.
          </p>
        </div>
      </div>

      {phase === 'idle' || phase === 'analyzing' ? (
        <label
          className="flex cursor-pointer flex-col items-center gap-3 rounded-2xl border-2 border-dashed bg-card p-12 text-center transition-colors hover:bg-muted/40 focus-within:ring-2 focus-within:ring-ring"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files?.[0]; if (f && !busy) void analyze(f); }}
        >
          <span className="grid size-14 place-items-center rounded-full bg-muted"><Upload className="size-6 text-muted-foreground" /></span>
          <span className="font-medium">{phase === 'analyzing' ? `Analizando ${file?.name}…` : 'Elige el archivo o arrástralo aquí'}</span>
          <span className="text-sm text-muted-foreground">Archivo .xlsx, hasta 20 MB</span>
          <input
            ref={input}
            type="file"
            accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            className="sr-only"
            aria-label="Archivo Excel"
            disabled={busy}
            onChange={(e) => { const f = e.target.files?.[0]; if (f) void analyze(f); }}
          />
        </label>
      ) : (
        <section className="flex flex-col gap-6 rounded-2xl border bg-card p-6 shadow-sm" aria-label="Resultado de la importación">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="flex items-center gap-3">
              <span className="grid size-10 place-items-center rounded-lg bg-muted"><FileSpreadsheet className="size-5" /></span>
              <div>
                <div className="font-medium">{file?.name}</div>
                <div className="text-xs text-muted-foreground">{file ? kb(file.size) : ''}</div>
              </div>
            </div>
            {phase === 'done' ? (
              <Badge variant="ok"><CheckCircle2 className="size-3" /> Importado</Badge>
            ) : (
              <Badge variant="warn">Simulación: todavía no se guardó nada</Badge>
            )}
          </div>

          <div>
            <h2 className="!mb-3 text-base">{phase === 'done' ? 'Se agregó' : 'Se agregaría'}: {fmt(total)} registros</h2>
            {created.length ? (
              <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4" aria-label="Registros por tipo">
                {created.map(([k, n]) => (
                  <li key={k} className="rounded-xl bg-muted/50 p-4">
                    <div className="num text-xl font-semibold">{fmt(n)}</div>
                    <div className="text-xs text-muted-foreground">{k}</div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="rounded-xl bg-muted/50 p-4 text-sm text-muted-foreground">No hay nada nuevo: todo lo del Excel ya estaba cargado.</p>
            )}
          </div>

          <div>
            <h2 className="!mb-3 flex items-center gap-2 text-base">
              Conciliación con el Excel
              {bad.length ? <Badge variant="bad"><XCircle className="size-3" /> {bad.length} con diferencia</Badge> : <Badge variant="ok"><CheckCircle2 className="size-3" /> Todo cuadra</Badge>}
            </h2>
            <div className="overflow-x-auto rounded-xl border">
              <table className="simple" aria-label="Conciliación">
                <thead><tr><th>Control</th><th className="r">Excel</th><th className="r">App</th><th>Estado</th></tr></thead>
                <tbody>
                  {report?.reconciliation.map((r) => (
                    <tr key={r.name}>
                      <td>{r.name}{r.note ? <span className="text-xs text-muted-foreground"> · {r.note}</span> : null}</td>
                      <td className="r num">{fmt(r.excel)}</td>
                      <td className="r num">{fmt(r.app)}</td>
                      <td>{r.ok ? (r.note ? <Badge variant="info">Info</Badge> : <Badge variant="ok">OK</Badge>) : <Badge variant="bad">Diferencia</Badge>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {(report?.warnings.length || report?.skipped.length) ? (
            <details className="rounded-xl border p-4 text-sm">
              <summary className="flex cursor-pointer items-center gap-2 font-medium"><TriangleAlert className="size-4" /> {(report?.warnings.length ?? 0) + (report?.skipped.length ?? 0)} avisos y filas omitidas</summary>
              <ul className="mt-3 flex flex-col gap-1.5 text-xs text-muted-foreground">
                {report?.warnings.map((w, i) => <li key={`w${i}`}>{w}</li>)}
                {report?.skipped.slice(0, 50).map((s, i) => <li key={`s${i}`}>{s.sheet}, fila {s.row}: {s.reason}</li>)}
              </ul>
            </details>
          ) : null}

          <div className="flex flex-wrap items-center gap-3">
            {phase === 'done' ? (
              <>
                <Button asChild><Link to="/historial">Ver en el historial</Link></Button>
                <Button variant="outline" onClick={reset}>Importar otro archivo</Button>
                <span className="text-sm text-muted-foreground">Si algo no te gusta, deshazlo desde el Historial.</span>
              </>
            ) : (
              <>
                <Button onClick={confirm} disabled={busy}>{phase === 'importing' ? 'Importando…' : 'Importar ahora'}</Button>
                <Button variant="ghost" onClick={reset} disabled={busy}>Cancelar</Button>
                {bad.length > 0 && <span className="text-sm text-amber-700 dark:text-amber-300">Hay diferencias con el Excel. Es normal si ya cargaste movimientos nuevos en la app; si es la primera importación, revísalas antes de confirmar.</span>}
              </>
            )}
          </div>
        </section>
      )}
    </div>
  );
}
