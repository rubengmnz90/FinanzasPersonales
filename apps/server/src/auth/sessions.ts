import argon2 from 'argon2';
import { createHash, randomBytes } from 'node:crypto';
import type { Db } from '../db/client';

export const SESSION_DAYS = 30;

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');

export const hashPassword = (pw: string) => argon2.hash(pw, { type: argon2.argon2id });

// Hash de relleno para igualar tiempos cuando el email no existe.
let dummy: Promise<string> | null = null;
export async function verifyPassword(hash: string | null, pw: string): Promise<boolean> {
  if (!hash) {
    dummy ??= hashPassword('relleno-no-valido');
    await argon2.verify(await dummy, pw).catch(() => false);
    return false;
  }
  return argon2.verify(hash, pw).catch(() => false);
}

export async function createSession(db: Db, userId: string): Promise<string> {
  const token = randomToken();
  await db.query(
    `INSERT INTO sessions(token_hash,user_id,expires_at) VALUES ($1,$2, now() + ($3 || ' days')::interval)`,
    [sha256(token), userId, String(SESSION_DAYS)],
  );
  return token;
}

export interface SessionUser {
  id: string;
  email: string;
  mustChangePassword: boolean;
}

export async function getSessionUser(db: Db, token: string | undefined): Promise<SessionUser | null> {
  if (!token) return null;
  const r = await db.query(
    `SELECT u.id, u.email, u.must_change_password FROM sessions s JOIN users u ON u.id=s.user_id
     WHERE s.token_hash=$1 AND s.expires_at > now()`,
    [sha256(token)],
  );
  const u = r.rows[0];
  return u ? { id: u.id, email: u.email, mustChangePassword: u.must_change_password } : null;
}

export async function destroySession(db: Db, token: string | undefined): Promise<void> {
  if (token) await db.query('DELETE FROM sessions WHERE token_hash=$1', [sha256(token)]);
}

/** Limitador simple en memoria: máx. `max` intentos por clave en `windowMs`. */
export class RateLimiter {
  private hits = new Map<string, number[]>();
  constructor(private max = 10, private windowMs = 60_000) {}
  check(key: string): boolean {
    const now = Date.now();
    const arr = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (arr.length >= this.max) {
      this.hits.set(key, arr);
      return false;
    }
    arr.push(now);
    this.hits.set(key, arr);
    return true;
  }
}
