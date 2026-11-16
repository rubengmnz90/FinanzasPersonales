import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CloudUpload, Database, Download, ShieldCheck, Upload } from 'lucide-react';
import { useState } from 'react';
import { get, post } from '../../app/api';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { useToast } from '../../components/ui';

interface AutoCopy { key: string; name: string; at: string; size: number; tiers: ('reciente' | 'diaria' | 'semanal' | 'mensual')[] }
interface AutoStatus {
  configured: boolean; running: boolean; bucket?: string; endpoint?: string; prefix?: string; hours?: number[];
  policy?: { recentDays: number; daily: number; weekly: number; monthly: number; tz: string };
  lastSuccess: { at: string; key: string; size: number; deleted: number } | null;
  lastError: { at: string; message: string } | null;
}
const TIER_LABEL = { reciente: 'reciente', diaria: 'diaria', semanal: 'semanal', mensual: 'mensual' } as const;
const kb = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const fmt = (iso: string, tz = 'America/Asuncion') =>
  new Intl.DateTimeFormat('es', { timeZone: tz, dateStyle: 'short', timeStyle: 'short' }).format(new Date(iso));

/** Respaldo automático a un almacenamiento externo (Backblaze B2 u otro S3): estado, copias y "respaldar ahora". */
function AutoBackupSection() {
  const toast = useToast();
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['backup-auto'],
    queryFn: () => get<{ status: AutoStatus; copies: AutoCopy[]; copiesError: string | null }>('/api/backup/auto'),
    retry: false,
    refetchInterval: (query) => (query.state.data?.status.running ? 3000 : false),
  });
  const [busy, setBusy] = useState(false);
  const st = q.data?.status;
  const tz = st?.policy?.tz;

  async function runNow() {
    setBusy(true);
    try {
      const r = await post<{ key: string; size: number; deleted: string[] }>('/api/backup/auto/run');
      toast.ok(`Copia subida (${kb(r.size)})${r.deleted.length ? ` · ${r.deleted.length} antigua${r.deleted.length === 1 ? '' : 's'} retirada${r.deleted.length === 1 ? '' : 's'}` : ''}`);
      await qc.invalidateQueries({ queryKey: ['backup-auto'] });
    } catch (e) { toast.error(e); } finally { setBusy(false); }
  }

  return (
    <section className="rounded-2xl border bg-card p-6 shadow-sm" aria-label="Respaldo automático">
      <h2 className="!mb-2 flex items-center gap-2 text-lg"><CloudUpload className="size-5" /> Respaldo automático en la nube</h2>
      {q.isError && <p className="text-sm text-muted-foreground">Esta sección es solo para el administrador.</p>}
      {st && !st.configured && (
        <div className="text-sm leading-relaxed text-muted-foreground">
          <p>Está <b>apagado</b>: falta conectar un almacenamiento. Crea un bucket privado en Backblaze B2 (o cualquier S3) y define en el <code>.env</code> del servidor:
            {' '}<code>BACKUP_S3_ENDPOINT</code>, <code>BACKUP_S3_KEY_ID</code>, <code>BACKUP_S3_SECRET</code> y <code>BACKUP_S3_BUCKET</code>. La guía paso a paso está en <code>docs/respaldo-automatico.md</code>.</p>
        </div>
      )}
      {st?.configured && (
        <>
          <p className="text-sm leading-relaxed text-muted-foreground">
            Cada día se suben <b>{st.hours?.length} copias completas (.zip)</b> a <code>{st.bucket}/{st.prefix}</code>, a las {st.hours?.map((h) => `${String(h).padStart(2, '0')}:00`).join(', ')} ({st.policy?.tz}).
            Se conservan con el método <b>GFS</b>: todas las de los últimos {st.policy?.recentDays} días, la última de cada día ({st.policy?.daily} días),
            una por semana ({st.policy?.weekly} semanas) y una por mes ({st.policy?.monthly} meses). Lo demás se borra solo.
          </p>
          <div className="mt-4 flex flex-wrap items-center gap-3 text-sm">
            {st.lastSuccess
              ? <Badge variant="ok">Última copia: {fmt(st.lastSuccess.at, tz)} · {kb(st.lastSuccess.size)}</Badge>
              : <Badge variant="warn">Aún no hay copia hecha</Badge>}
            {st.running && <Badge variant="info">Respaldando…</Badge>}
            <Button variant="outline" onClick={runNow} disabled={busy || st.running}><CloudUpload /> {busy ? 'Respaldando…' : 'Respaldar ahora'}</Button>
          </div>
          {st.lastError && (
            <p className="mt-3 rounded-lg border border-destructive/40 p-3 text-sm neg">
              Falló el último intento ({fmt(st.lastError.at, tz)}): {st.lastError.message}. Se reintenta solo cada 30 minutos.
            </p>
          )}
          {q.data?.copiesError && <p className="mt-3 text-sm neg">No se pudo leer el bucket: {q.data.copiesError}</p>}
          {!!q.data?.copies.length && (
            <div className="mt-4 max-h-72 overflow-y-auto rounded-lg border">
              <table className="simple">
                <thead><tr><th>Copia</th><th>Fecha ({tz})</th><th className="r">Tamaño</th><th>Se conserva como</th></tr></thead>
                <tbody>
                  {q.data.copies.map((c) => (
                    <tr key={c.key}>
                      <td className="num text-xs">{c.name}</td>
                      <td className="whitespace-nowrap">{fmt(c.at, tz)}</td>
                      <td className="r num">{kb(c.size)}</td>
                      <td>{c.tiers.length ? c.tiers.map((t) => <Badge key={t} variant={t === 'mensual' ? 'ok' : t === 'semanal' ? 'info' : 'default'} className="mr-1">{TIER_LABEL[t]}</Badge>) : <span className="text-xs text-muted-foreground">se retira en la próxima copia</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="mt-4 text-xs leading-relaxed text-muted-foreground">
            Para recuperar: baja el .zip desde tu bucket (por ejemplo desde la web de Backblaze) y súbelo en “Restaurar desde un respaldo” más abajo.
            Cada copia incluye todos los usuarios y contraseñas (hash): mantén el bucket privado.
          </p>
        </>
      )}
    </section>
  );
}

/** Descarga de todos tus datos en un archivo, para guardarlo fuera del servidor. */
export function BackupPage() {
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  const [file, setFile] = useState<File | null>(null);
  const [confirmText, setConfirmText] = useState('');
  const [restoring, setRestoring] = useState(false);

  async function restore() {
    if (!file) return;
    setRestoring(true);
    try {
      const res = await fetch('/api/backup/restore?confirm=RESTAURAR', {
        method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/zip' }, body: file,
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.detail || 'No se pudo restaurar');
      }
      toast.ok('Base restaurada. Inicia sesión de nuevo…');
      setTimeout(() => { window.location.href = '/'; }, 1500);
    } catch (e) { toast.error(e); setRestoring(false); }
  }

  async function download(endpoint = '/api/backup', fallback = 'finanzas-respaldo.json') {
    setBusy(true);
    try {
      const res = await fetch(endpoint, { credentials: 'same-origin' });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.detail || 'No se pudo generar el respaldo');
      }
      const blob = await res.blob();
      const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? fallback;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      a.click();
      URL.revokeObjectURL(url);
      toast.ok(`Respaldo descargado: ${name}`);
    } catch (e) { toast.error(e); } finally { setBusy(false); }
  }

  return (
    <div className="flex max-w-3xl flex-col gap-6 pb-10">
      <div className="page-head !mb-0"><h1>Respaldo</h1></div>
      <section className="rounded-2xl border bg-card p-6 shadow-sm">
        <h2 className="!mb-2 flex items-center gap-2 text-lg"><ShieldCheck className="size-5" /> Descargar mis datos</h2>
        <p className="text-sm leading-relaxed text-muted-foreground">
          Baja un archivo <b>.json</b> con todo lo tuyo: cuentas, movimientos, transferencias, ahorro y personas, préstamos y cuotas,
          deudas, planes, gastos puntuales y distribuciones. No incluye contraseñas, sesiones ni conexiones de IA.
        </p>
        <div className="mt-4"><Button onClick={() => download()} disabled={busy}><Download /> {busy ? 'Generando…' : 'Descargar respaldo'}</Button></div>
        <p className="mt-4 text-xs leading-relaxed text-muted-foreground">
          El archivo no está cifrado: guárdalo en un lugar privado. Cada descarga es una copia completa al momento de hacer clic.
        </p>
      </section>
      <section className="rounded-2xl border bg-card p-6 shadow-sm">
        <h2 className="!mb-2 flex items-center gap-2 text-lg"><Database className="size-5" /> Respaldo completo de la base (ZIP)</h2>
        <p className="text-sm leading-relaxed text-muted-foreground">
          Un <b>dump real de PostgreSQL</b> (<code>pg_dump</code>) comprimido en .zip: toda la base, restaurable con <code>psql</code>.
          Solo para el administrador. También se puede bajar por API con el token <code>BACKUP_TOKEN</code> para una rutina en tu PC
          (<code>GET /api/backup/full</code>, ver README).
        </p>
        <div className="mt-4"><Button variant="outline" onClick={() => download('/api/backup/full', 'finanzas.zip')} disabled={busy}><Download /> {busy ? 'Generando…' : 'Descargar dump completo (.zip)'}</Button></div>
        <p className="mt-4 text-xs leading-relaxed text-muted-foreground">
          Atención: incluye contraseñas (hash), sesiones, conexiones de IA y los datos de todos los usuarios, y no está cifrado. Guárdalo en un lugar privado.
        </p>
      </section>
      <AutoBackupSection />
      <section className="rounded-2xl border border-destructive/40 bg-card p-6 shadow-sm">
        <h2 className="!mb-2 flex items-center gap-2 text-lg"><Upload className="size-5" /> Restaurar desde un respaldo (ZIP)</h2>
        <p className="text-sm leading-relaxed text-muted-foreground">
          Sube el <b>.zip</b> que descargaste arriba. <b>Reemplaza TODA la base actual</b> (datos, usuarios y sesiones) por la del archivo.
          Es todo o nada: si algo falla, la base queda como estaba. Al terminar tendrás que iniciar sesión de nuevo con la clave que tenía el respaldo.
          Solo para el administrador. Descarga un respaldo actual antes de restaurar.
        </p>
        <div className="mt-4 flex flex-col gap-3">
          <input type="file" accept=".zip,application/zip" onChange={(e) => setFile(e.target.files?.[0] ?? null)} disabled={restoring}
            className="text-sm file:mr-3 file:rounded-md file:border file:bg-background file:px-3 file:py-1.5 file:text-sm" />
          <label className="text-sm">Escribe <code>RESTAURAR</code> para confirmar
            <input value={confirmText} onChange={(e) => setConfirmText(e.target.value)} disabled={restoring} autoComplete="off"
              className="mt-1 block w-full max-w-xs rounded-md border bg-background px-3 py-1.5 text-sm" />
          </label>
          <div><Button variant="destructive" onClick={restore} disabled={restoring || !file || confirmText !== 'RESTAURAR'}>
            <Upload /> {restoring ? 'Restaurando…' : 'Restaurar base'}
          </Button></div>
        </div>
      </section>
    </div>
  );
}
