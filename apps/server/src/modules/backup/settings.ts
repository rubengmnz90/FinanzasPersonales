import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import type { Db } from '../../db/client';
import { buildConfig, type AutoBackupConfig, type AutoBackupFields } from './auto';

/** Lo que se guarda cifrado. Los nombres coinciden con AutoBackupFields. */
export type StoredFields = Required<Pick<AutoBackupFields, 'endpoint' | 'keyId' | 'secret' | 'bucket'>> & Omit<AutoBackupFields, 'endpoint' | 'keyId' | 'secret' | 'bucket'>;

export class SettingsError extends Error {}

/** Llave de cifrado: SETTINGS_KEY, o BACKUP_TOKEN si no existe. Vive solo en el servidor (.env), no en la base ni en los respaldos. */
function masterKey(env: NodeJS.ProcessEnv = process.env): Buffer {
  const raw = env.SETTINGS_KEY?.trim() || env.BACKUP_TOKEN?.trim();
  if (!raw || raw.length < 16) {
    throw new SettingsError('El servidor no tiene una llave para cifrar (define SETTINGS_KEY, de al menos 16 caracteres, en el .env).');
  }
  return Buffer.from(hkdfSync('sha256', raw, 'finanzas-backup-settings', 'aes-256-gcm', 32));
}

/** v1.<iv>.<tag>.<datos> en base64url. */
export function encryptJson(value: unknown, env?: NodeJS.ProcessEnv): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', masterKey(env), iv);
  const data = Buffer.concat([c.update(JSON.stringify(value), 'utf8'), c.final()]);
  return ['v1', iv, c.getAuthTag(), data].map((p) => (typeof p === 'string' ? p : p.toString('base64url'))).join('.');
}

export function decryptJson<T>(blob: string, env?: NodeJS.ProcessEnv): T {
  const [v, iv, tag, data] = blob.split('.');
  if (v !== 'v1' || !iv || !tag || !data) throw new SettingsError('Configuración guardada con un formato desconocido');
  try {
    const d = createDecipheriv('aes-256-gcm', masterKey(env), Buffer.from(iv, 'base64url'));
    d.setAuthTag(Buffer.from(tag, 'base64url'));
    return JSON.parse(Buffer.concat([d.update(Buffer.from(data, 'base64url')), d.final()]).toString('utf8')) as T;
  } catch (e) {
    if (e instanceof SettingsError) throw e;
    throw new SettingsError('No se pudo descifrar la configuración guardada: la llave del servidor (SETTINGS_KEY / BACKUP_TOKEN) cambió. Vuelve a guardar las claves.');
  }
}

export async function loadStoredFields(db: Db, env?: NodeJS.ProcessEnv): Promise<StoredFields | null> {
  const r = await db.query<{ config_enc: string }>('SELECT config_enc FROM backup_settings WHERE id = 1');
  return r.rows[0] ? decryptJson<StoredFields>(r.rows[0].config_enc, env) : null;
}

export async function saveStoredFields(db: Db, f: StoredFields, env?: NodeJS.ProcessEnv): Promise<void> {
  const enc = encryptJson(f, env);
  await db.query(
    `INSERT INTO backup_settings (id, config_enc) VALUES (1, $1)
     ON CONFLICT (id) DO UPDATE SET config_enc = EXCLUDED.config_enc, updated_at = now()`,
    [enc],
  );
}

export async function clearStoredFields(db: Db): Promise<void> {
  await db.query('DELETE FROM backup_settings WHERE id = 1');
}

/** Lo que ve la pantalla: todo menos el secreto (solo "hay uno") y con la clave de acceso enmascarada. */
export function publicView(f: StoredFields | null) {
  if (!f) return null;
  const { secret, keyId, ...rest } = f;
  return { ...rest, keyIdMasked: keyId.length > 6 ? `${keyId.slice(0, 4)}…${keyId.slice(-2)}` : '••••', hasSecret: !!secret };
}

const str = (v: unknown, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const numStr = (v: unknown) => (v === undefined || v === null || v === '' ? '' : String(v).trim());

/**
 * Valida lo que manda la pantalla y lo junta con lo ya guardado (el secreto y la clave de acceso son opcionales al editar:
 * vacío = dejar la actual). Lanza SettingsError con un mensaje claro si algo no sirve.
 */
export function mergeInput(body: any, current: StoredFields | null): { fields: StoredFields; config: AutoBackupConfig } {
  const endpoint = str(body?.endpoint);
  if (!/^(https:\/\/[^\s/]+|http:\/\/(localhost|127\.0\.0\.1)(:\d+)?)\/?$/i.test(endpoint)) throw new SettingsError('El endpoint debe empezar con https:// (p. ej. https://s3.us-west-004.backblazeb2.com)');
  const bucket = str(body?.bucket);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9.-]{2,62}$/.test(bucket)) throw new SettingsError('El nombre del bucket no es válido');
  const keyId = str(body?.keyId) || current?.keyId || '';
  const secret = str(body?.secret, 400) || current?.secret || '';
  if (!keyId) throw new SettingsError('Falta el keyID de la application key');
  if (!secret) throw new SettingsError('Falta la applicationKey (la clave secreta)');
  const fields: StoredFields = {
    endpoint: endpoint.replace(/\/$/, ''), keyId, secret, bucket,
    region: str(body?.region, 40), prefix: str(body?.prefix, 100), hours: numStr(body?.hours), tz: str(body?.tz, 60), sse: str(body?.sse, 10),
    keepRecentDays: numStr(body?.keepRecentDays), keepDaily: numStr(body?.keepDaily), keepWeekly: numStr(body?.keepWeekly), keepMonthly: numStr(body?.keepMonthly),
  };
  for (const k of ['keepRecentDays', 'keepDaily', 'keepWeekly', 'keepMonthly'] as const) {
    const v = fields[k];
    if (v !== '' && !(Number.isInteger(Number(v)) && Number(v) >= 0 && Number(v) <= 3650)) throw new SettingsError('Los días/semanas/meses a conservar deben ser enteros entre 0 y 3650');
  }
  if (fields.hours && !fields.hours.split(',').every((h) => Number.isInteger(Number(h.trim())) && Number(h.trim()) >= 0 && Number(h.trim()) <= 23)) {
    throw new SettingsError('Las horas deben ser números del 0 al 23 separados por coma (p. ej. 0,6,12,18)');
  }
  let config: AutoBackupConfig | null;
  try { config = buildConfig(fields); } catch (e) { throw new SettingsError((e as Error).message); }
  if (!config) throw new SettingsError('Faltan datos para conectar');
  return { fields, config };
}
