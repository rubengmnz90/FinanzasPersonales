import { spawn } from 'node:child_process';
import { timingSafeEqual } from 'node:crypto';
import { zipSync } from 'fflate';

/** Fallo al generar el dump (pg_dump ausente, versión distinta, credenciales...). */
export class DumpError extends Error {
  constructor(public code: 'PG_DUMP_MISSING' | 'PG_DUMP_FAILED', message: string) {
    super(message);
    this.name = 'DumpError';
  }
}

const MAX_DUMP = 1024 * 1024 * 1024; // 1 GB: tope de seguridad para no agotar la memoria

/** Variables de entorno de libpq a partir de DATABASE_URL (así la clave no aparece en los argumentos del proceso). */
export function pgEnv(databaseUrl: string): Record<string, string> {
  const u = new URL(databaseUrl);
  const env: Record<string, string> = {
    PGHOST: decodeURIComponent(u.hostname),
    PGPORT: u.port || '5432',
    PGUSER: decodeURIComponent(u.username),
    PGPASSWORD: decodeURIComponent(u.password),
    PGDATABASE: decodeURIComponent(u.pathname.replace(/^\//, '')),
  };
  const ssl = u.searchParams.get('sslmode');
  if (ssl) env.PGSSLMODE = ssl;
  return env;
}

/**
 * Dump real de la base con pg_dump, en SQL plano. Se restaura con psql (incluye DROP ... IF EXISTS, así que
 * puede cargarse sobre una base existente). Es una copia de TODA la base.
 */
export function runPgDump(databaseUrl: string, bin = process.env.PG_DUMP_BIN || 'pg_dump'): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, ['--format=plain', '--no-owner', '--no-privileges', '--clean', '--if-exists'], {
      env: { ...process.env, ...pgEnv(databaseUrl) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const out: Buffer[] = [];
    let size = 0;
    let err = '';
    child.stdout.on('data', (b: Buffer) => {
      size += b.length;
      if (size > MAX_DUMP) { child.kill(); reject(new DumpError('PG_DUMP_FAILED', 'El dump supera el tamaño máximo permitido')); return; }
      out.push(b);
    });
    child.stderr.on('data', (b: Buffer) => { err += b.toString(); });
    child.on('error', (e: NodeJS.ErrnoException) => {
      reject(e.code === 'ENOENT' ? new DumpError('PG_DUMP_MISSING', 'pg_dump no está instalado en el servidor') : new DumpError('PG_DUMP_FAILED', e.message));
    });
    child.on('close', (code) => {
      if (code === 0) resolve(Buffer.concat(out));
      else reject(new DumpError('PG_DUMP_FAILED', (err.trim() || `pg_dump terminó con código ${code}`).slice(0, 400)));
    });
  });
}

/** Empaqueta el SQL en un .zip con un único archivo. */
export function zipDump(sql: Buffer, sqlName: string): Buffer {
  return Buffer.from(zipSync({ [sqlName]: new Uint8Array(sql) }, { level: 9 }));
}

export function stamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}

/** Compara dos textos en tiempo constante (para el token del respaldo). */
export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
