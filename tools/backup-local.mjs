#!/usr/bin/env node
// Baja el dump completo (.zip) de Finanzas a una carpeta local y conserva solo los últimos KEEP.
// Sin dependencias (Node 18+). Variables de entorno:
//   FINANZAS_URL=https://finanzas.vibralejana.com   FINANZAS_BACKUP_TOKEN=<BACKUP_TOKEN del servidor>
//   BACKUP_DIR=./backups (opcional)   KEEP=30 (opcional; 0 = no borrar nada)
import { mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const url = (process.env.FINANZAS_URL || '').replace(/\/+$/, '');
const token = process.env.FINANZAS_BACKUP_TOKEN || '';
const dir = process.env.BACKUP_DIR || './backups';
const keep = Number(process.env.KEEP ?? 30);
if (!url || !token) { console.error('Falta FINANZAS_URL o FINANZAS_BACKUP_TOKEN'); process.exit(2); }

const res = await fetch(`${url}/api/backup/full`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10 * 60_000) });
if (!res.ok) { console.error(`Fallo ${res.status}: ${(await res.text()).slice(0, 300)}`); process.exit(1); }
const buf = Buffer.from(await res.arrayBuffer());
if (buf.length < 100 || buf[0] !== 0x50 || buf[1] !== 0x4b) { console.error('La respuesta no es un .zip válido'); process.exit(1); }

const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') || '')?.[1] || `finanzas-${Date.now()}.zip`;
await mkdir(dir, { recursive: true });
const tmp = join(dir, `${name}.part`);
await writeFile(tmp, buf, { mode: 0o600 });
await rename(tmp, join(dir, name)); // el archivo aparece completo o no aparece
console.log(`OK ${join(dir, name)} (${(buf.length / 1024).toFixed(0)} KB)`);

if (keep > 0) {
  const old = (await readdir(dir)).filter((f) => /^finanzas-\d{8}-\d{6}\.zip$/.test(f)).sort().reverse().slice(keep);
  for (const f of old) await rm(join(dir, f));
  if (old.length) console.log(`Borrados ${old.length} respaldos antiguos`);
}
