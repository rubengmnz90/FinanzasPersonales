import { spawn } from 'node:child_process';
import { unzipSync } from 'fflate';
import { pgEnv } from './dump';

/** Fallo al restaurar: el archivo no sirve (BAD_FILE) o psql falló (RESTORE_FAILED; la base queda intacta). */
export class RestoreError extends Error {
  constructor(public code: 'BAD_FILE' | 'PSQL_MISSING' | 'RESTORE_FAILED', message: string) {
    super(message);
    this.name = 'RestoreError';
  }
}

export const MAX_ZIP = 200 * 1024 * 1024; // zip subido
export const MAX_SQL = 1024 * 1024 * 1024; // SQL descomprimido (misma cota que el dump)

/** Saca el único .sql del zip, sin descomprimir nada más (evita zip-bombs: se mira el tamaño declarado antes). */
export function extractSql(zip: Buffer): Buffer {
  if (zip.length < 4 || zip.readUInt32BE(0) !== 0x504b0304) throw new RestoreError('BAD_FILE', 'Sube el archivo .zip que descargaste del respaldo completo');
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(new Uint8Array(zip), { filter: (f) => f.name.toLowerCase().endsWith('.sql') && f.originalSize <= MAX_SQL });
  } catch {
    throw new RestoreError('BAD_FILE', 'El .zip está dañado o no se puede leer');
  }
  const names = Object.keys(files);
  if (names.length !== 1) throw new RestoreError('BAD_FILE', 'El .zip debe traer exactamente un archivo .sql (el dump completo)');
  return Buffer.from(files[names[0]]);
}

/**
 * Comprueba que sea un dump de pg_dump de ESTA app y que no traiga comandos de psql (\! ejecuta shell, \i lee archivos...).
 * Dentro de un bloque COPY las líneas pueden empezar con "\" (p. ej. \N = NULL), así que ahí no se revisan.
 */
export function validateDump(sql: Buffer): void {
  const text = sql.toString('utf8');
  if (!/^-- PostgreSQL database dump/m.test(text.slice(0, 2000))) {
    throw new RestoreError('BAD_FILE', 'El archivo no parece un dump de PostgreSQL generado por esta app');
  }
  if (!/CREATE TABLE (IF NOT EXISTS )?(public\.)?users\b/.test(text) || !/schema_migrations/.test(text)) {
    throw new RestoreError('BAD_FILE', 'El dump no contiene las tablas de Finanzas Personales (users, schema_migrations)');
  }
  let inCopy = false;
  for (const line of text.split('\n')) {
    if (inCopy) { if (line.replace(/\r$/, '') === '\\.') inCopy = false; continue; }
    if (/^COPY .* FROM stdin;\r?$/.test(line)) { inCopy = true; continue; }
    if (line.startsWith('\\') && !/^\\(restrict|unrestrict) \S+\r?$/.test(line)) {
      throw new RestoreError('BAD_FILE', 'El dump contiene comandos de psql no permitidos');
    }
  }
}

let running = false;

/**
 * Carga el dump con psql en UNA transacción y con ON_ERROR_STOP: si algo falla se revierte todo y la base queda como estaba.
 * Reemplaza TODA la base (usuarios, sesiones y datos), porque el dump trae DROP ... IF EXISTS.
 */
export function runPsqlRestore(databaseUrl: string, sql: Buffer, bin = process.env.PSQL_BIN || 'psql', timeoutMs = 10 * 60_000): Promise<void> {
  if (running) return Promise.reject(new RestoreError('RESTORE_FAILED', 'Ya hay una restauración en curso'));
  running = true;
  return new Promise<void>((resolve, reject) => {
    const done = (fn: () => void) => { running = false; fn(); };
    const child = spawn(bin, ['-X', '-q', '--single-transaction', '-v', 'ON_ERROR_STOP=1', '-f', '-'], {
      env: { ...process.env, ...pgEnv(databaseUrl) },
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    let err = '';
    const timer = setTimeout(() => { child.kill(); }, timeoutMs);
    child.stderr.on('data', (b: Buffer) => { if (err.length < 4000) err += b.toString(); });
    child.on('error', (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      done(() => reject(e.code === 'ENOENT' ? new RestoreError('PSQL_MISSING', 'psql no está instalado en el servidor') : new RestoreError('RESTORE_FAILED', e.message)));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) done(resolve);
      else done(() => reject(new RestoreError('RESTORE_FAILED', (err.trim() || `psql terminó con código ${code}`).slice(0, 400))));
    });
    child.stdin.on('error', () => { /* psql cerró antes de leerlo todo: el error real llega por 'close' */ });
    child.stdin.end(sql);
  });
}
