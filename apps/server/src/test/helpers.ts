import '../db/env';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { createDb, type Db } from '../db/client';
import { migrate } from '../db/migrate';

export interface TestCtx {
  db: Db;
  close(): Promise<void>;
}

/** Crea un schema aislado por archivo de test y aplica las migraciones. */
export async function makeTestDb(): Promise<TestCtx> {
  const url = process.env.TEST_DATABASE_URL!;
  const schema = 't_' + randomBytes(6).toString('hex');
  const admin = new pg.Pool({ connectionString: url, max: 1 });
  await admin.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
  await admin.query(`CREATE SCHEMA ${schema}`);
  const db = createDb(url, `${schema},public`);
  await migrate(db);
  return {
    db,
    async close() {
      await db.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    },
  };
}

export async function makeUser(db: Db, email?: string): Promise<string> {
  const e = email ?? `u${randomBytes(4).toString('hex')}@test.io`;
  const r = await db.query("INSERT INTO users(email, password_hash) VALUES ($1, 'x') RETURNING id", [e]);
  return r.rows[0].id;
}
