import { runPgDump, zipDump } from './dump';
import { validateDump } from './restore';
import { classify, copyName, DEFAULT_POLICY, latestSlot, parseCopyDate, selectToDelete, type Copy, type Policy, type Tier } from './gfs';
import { S3Store, type BackupStore } from './store';

export interface AutoBackupConfig {
  store: BackupStore;
  /** Carpeta dentro del bucket (termina en /). */
  prefix: string;
  /** Horas del día (en `policy.tz`) en que se hace una copia. */
  hours: number[];
  policy: Policy;
  /** Datos para mostrar en pantalla (nunca claves). */
  info: { bucket: string; endpoint: string };
}

const num = (v: string | undefined, d: number) => (v !== undefined && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : d);

/** Datos para armar la configuración (vienen del entorno o de la pantalla). Vacío = valor por defecto. */
export interface AutoBackupFields {
  endpoint?: string; keyId?: string; secret?: string; bucket?: string; region?: string; prefix?: string;
  hours?: string; tz?: string; sse?: string;
  keepRecentDays?: string; keepDaily?: string; keepWeekly?: string; keepMonthly?: string;
}

/** Arma la configuración. Devuelve null si falta endpoint, keyId, secret o bucket. */
export function buildConfig(f: AutoBackupFields): AutoBackupConfig | null {
  const endpoint = f.endpoint?.trim();
  const keyId = f.keyId?.trim();
  const secret = f.secret?.trim();
  const bucket = f.bucket?.trim();
  if (!endpoint || !keyId || !secret || !bucket) return null;
  // Para B2 la región va en el endpoint: https://s3.us-west-004.backblazeb2.com
  const region = f.region?.trim() || /s3\.([a-z0-9-]+)\./.exec(endpoint)?.[1] || 'us-east-1';
  const hours = (f.hours?.trim() || '0,6,12,18').split(',').map((h) => Number(h.trim())).filter((h) => Number.isInteger(h) && h >= 0 && h <= 23);
  const tz = f.tz?.trim() || DEFAULT_POLICY.tz;
  try { new Intl.DateTimeFormat('en', { timeZone: tz }); } catch { throw new Error(`Zona horaria inválida: ${tz}`); }
  return {
    store: new S3Store({ endpoint, region, keyId, secret, bucket, sse: f.sse?.trim().toLowerCase() === 'none' ? 'none' : 'AES256' }),
    prefix: (f.prefix?.trim() || 'finanzas/').replace(/^\/+/, '').replace(/\/?$/, '/'),
    hours: hours.length ? hours : [0, 6, 12, 18],
    policy: {
      recentDays: num(f.keepRecentDays, DEFAULT_POLICY.recentDays),
      daily: num(f.keepDaily, DEFAULT_POLICY.daily),
      weekly: num(f.keepWeekly, DEFAULT_POLICY.weekly),
      monthly: num(f.keepMonthly, DEFAULT_POLICY.monthly),
      tz,
    },
    info: { bucket, endpoint },
  };
}

/** Lee la configuración del entorno (BACKUP_S3_*). Devuelve null si falta algo o si BACKUP_AUTO=false. */
export function autoBackupFromEnv(env: NodeJS.ProcessEnv = process.env): AutoBackupConfig | null {
  if (env.BACKUP_AUTO?.trim().toLowerCase() === 'false') return null;
  return buildConfig({
    endpoint: env.BACKUP_S3_ENDPOINT, keyId: env.BACKUP_S3_KEY_ID, secret: env.BACKUP_S3_SECRET, bucket: env.BACKUP_S3_BUCKET,
    region: env.BACKUP_S3_REGION, prefix: env.BACKUP_S3_PREFIX, hours: env.BACKUP_HOURS, tz: env.BACKUP_TZ, sse: env.BACKUP_S3_SSE,
    keepRecentDays: env.BACKUP_KEEP_RECENT_DAYS, keepDaily: env.BACKUP_KEEP_DAILY, keepWeekly: env.BACKUP_KEEP_WEEKLY, keepMonthly: env.BACKUP_KEEP_MONTHLY,
  });
}

export interface RunResult {
  key: string;
  size: number;
  /** Copias borradas por la política GFS. */
  deleted: string[];
  /** Copias que quedan. */
  kept: number;
}

/** Copias reales del bucket (solo archivos con el nombre de esta app). */
async function listCopies(cfg: AutoBackupConfig): Promise<Copy[]> {
  const objs = await cfg.store.list(cfg.prefix);
  const out: Copy[] = [];
  for (const o of objs) {
    const at = parseCopyDate(o.key);
    if (at) out.push({ key: o.key, at, size: o.size });
  }
  return out;
}

/**
 * Hace una copia completa (pg_dump en .zip), la sube, comprueba que quedó con el tamaño correcto y recién entonces
 * aplica la política GFS. Si algo falla antes de comprobar la subida no se borra nada.
 */
export async function runBackup(
  cfg: AutoBackupConfig,
  opts: { now?: Date; dump?: () => Promise<Buffer> } = {},
): Promise<RunResult> {
  const now = opts.now ?? new Date();
  const sql = await (opts.dump ? opts.dump() : runPgDump(process.env.DATABASE_URL ?? ''));
  validateDump(sql); // que sea restaurable desde /respaldo antes de gastar una subida
  const zip = zipDump(sql, copyName(now).replace(/\.zip$/, '.sql'));
  const key = `${cfg.prefix}${copyName(now)}`;

  await cfg.store.put(key, zip);
  const copies = await listCopies(cfg);
  const mine = copies.find((c) => c.key === key);
  if (!mine || mine.size !== zip.length) throw new Error(`La copia subida no coincide (esperado ${zip.length} bytes, hay ${mine?.size ?? 'nada'})`);

  const deleted: string[] = [];
  for (const c of selectToDelete(copies, now, cfg.policy)) {
    if (c.key === key) continue; // nunca la que acabo de subir
    await cfg.store.delete(c.key);
    deleted.push(c.key);
  }
  return { key, size: zip.length, deleted, kept: copies.length - deleted.length };
}

export interface CopyInfo {
  key: string;
  name: string;
  at: string;
  size: number;
  tiers: Tier[];
}

/** Las copias que hay y por qué se conserva cada una (reciente, diaria, semanal, mensual). Más nueva primero. */
export async function listAutoCopies(cfg: AutoBackupConfig, now = new Date()): Promise<CopyInfo[]> {
  const copies = await listCopies(cfg);
  const keep = classify(copies, now, cfg.policy);
  return copies
    .sort((a, b) => b.at.getTime() - a.at.getTime())
    .map((c) => ({ key: c.key, name: c.key.slice(cfg.prefix.length), at: c.at.toISOString(), size: c.size ?? 0, tiers: keep.get(c.key) ?? [] }));
}

// ── Planificador ──

export interface AutoBackupStatus {
  configured: boolean;
  source?: 'app' | 'env' | null;
  running: boolean;
  bucket?: string;
  endpoint?: string;
  prefix?: string;
  hours?: number[];
  policy?: Policy;
  lastSuccess: { at: string; key: string; size: number; deleted: number } | null;
  lastError: { at: string; message: string } | null;
}

/** Cada 5 minutos mira si ya pasó una hora programada sin copia y, si es así, la hace. Sobrevive a reinicios y despliegues. */
export class AutoBackup {
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  private retryAt = 0;
  private lastSuccess: AutoBackupStatus['lastSuccess'] = null;
  private lastError: AutoBackupStatus['lastError'] = null;

  /** De dónde viene la configuración activa. */
  source: 'app' | 'env' | null = null;

  constructor(
    private config: AutoBackupConfig | null,
    private opts: { dump?: () => Promise<Buffer>; log?: (msg: string) => void; clock?: () => Date } = {},
  ) {}

  get cfg(): AutoBackupConfig | null { return this.config; }

  /** Cambia la configuración en caliente (desde la pantalla). Reinicia el estado de errores y reintentos. */
  setConfig(cfg: AutoBackupConfig | null, source: 'app' | 'env' | null) {
    this.config = cfg;
    this.source = cfg ? source : null;
    this.lastSuccess = null;
    this.lastError = null;
    this.retryAt = 0;
    if (cfg) this.log(`configuración ${source === 'app' ? 'de la pantalla' : 'del entorno'}: ${cfg.info.bucket}/${cfg.prefix}`);
  }

  private log(msg: string) { (this.opts.log ?? console.log)(`[respaldo-auto] ${msg}`); }
  private now() { return (this.opts.clock ?? (() => new Date()))(); }

  start(everyMs = 5 * 60_000, firstTickMs = 30_000) {
    if (this.timer) return;
    const c = this.cfg;
    if (c) this.log(`activo: ${c.info.bucket}/${c.prefix}, horas ${c.hours.join(',')} (${c.policy.tz}), GFS ${c.policy.recentDays}d recientes + ${c.policy.daily} diarias + ${c.policy.weekly} semanales + ${c.policy.monthly} mensuales`);
    setTimeout(() => void this.tick(), firstTickMs).unref();
    this.timer = setInterval(() => void this.tick(), everyMs);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Una pasada del planificador. Devuelve true si hizo una copia. */
  async tick(): Promise<boolean> {
    if (!this.cfg || this.busy) return false;
    const now = this.now();
    if (now.getTime() < this.retryAt) return false;
    try {
      const slot = latestSlot(now, this.cfg.hours, this.cfg.policy.tz);
      if (!this.lastSuccess) {
        // Tras un reinicio: ¿ya hay una copia de este horario en el bucket?
        const newest = (await listCopies(this.cfg)).sort((a, b) => b.at.getTime() - a.at.getTime())[0];
        if (newest) this.lastSuccess = { at: newest.at.toISOString(), key: newest.key, size: newest.size ?? 0, deleted: 0 };
      }
      const last = this.lastSuccess ? new Date(this.lastSuccess.at).getTime() : 0;
      if (last >= slot.getTime()) return false; // ya está al día
      await this.runNow();
      return true;
    } catch (e) {
      this.fail(e);
      return false;
    }
  }

  /** Respaldar ahora (botón de la pantalla o por pedido). */
  async runNow(): Promise<RunResult> {
    if (!this.cfg) throw new Error('El respaldo automático no está configurado');
    if (this.busy) throw new Error('Ya hay un respaldo en curso');
    this.busy = true;
    try {
      const r = await runBackup(this.cfg, { now: this.now(), dump: this.opts.dump });
      this.lastSuccess = { at: this.now().toISOString(), key: r.key, size: r.size, deleted: r.deleted.length };
      this.lastError = null;
      this.retryAt = 0;
      this.log(`copia ${r.key} (${Math.round(r.size / 1024)} KB); borradas por GFS: ${r.deleted.length}; quedan ${r.kept}`);
      return r;
    } catch (e) {
      this.fail(e);
      throw e;
    } finally {
      this.busy = false;
    }
  }

  private fail(e: unknown) {
    const message = String((e as Error)?.message ?? e).slice(0, 300);
    this.lastError = { at: this.now().toISOString(), message };
    this.retryAt = this.now().getTime() + 30 * 60_000; // reintenta en 30 minutos
    console.error('[respaldo-auto] falló:', message);
  }

  status(): AutoBackupStatus {
    const c = this.cfg;
    return {
      configured: !!c, source: this.source, running: this.busy, bucket: c?.info.bucket, endpoint: c?.info.endpoint, prefix: c?.prefix, hours: c?.hours, policy: c?.policy,
      lastSuccess: this.lastSuccess, lastError: this.lastError,
    };
  }
}
