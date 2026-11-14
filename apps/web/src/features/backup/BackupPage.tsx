import { Database, Download, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { Button } from '../../components/ui/button';
import { useToast } from '../../components/ui';

/** Descarga de todos tus datos en un archivo, para guardarlo fuera del servidor. */
export function BackupPage() {
  const toast = useToast();
  const [busy, setBusy] = useState(false);

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
    <div className="flex max-w-2xl flex-col gap-6 pb-10">
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
    </div>
  );
}
