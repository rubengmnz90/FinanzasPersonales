import './env';
import argon2 from 'argon2';
import { createDb } from './client';
import { migrate } from './migrate';
import { seedCategories } from '../modules/categories/service';
import { seedDefaultAccounts } from '../modules/ledgers/service';
import { seedDefaultLoans } from '../modules/loans/service';

const email = (process.env.SEED_EMAIL ?? '').toLowerCase();
const password = process.env.SEED_USER_PASSWORD;
if (!email || !password) {
  console.error('Faltan SEED_EMAIL y/o SEED_USER_PASSWORD (variables de entorno o .env).');
  process.exit(2);
}

const db = createDb(process.env.DATABASE_URL!);
await migrate(db);
const hash = await argon2.hash(password, { type: argon2.argon2id });
const r = await db.query(
  `INSERT INTO users(email,password_hash,must_change_password) VALUES ($1,$2,true)
   ON CONFLICT (email) DO NOTHING RETURNING id`,
  [email, hash],
);
let userId: string;
if (r.rowCount) {
  userId = r.rows[0].id;
  console.log(`Usuario ${email} creado (deberá cambiar la contraseña al primer ingreso).`);
} else {
  userId = (await db.query('SELECT id FROM users WHERE email=$1', [email])).rows[0].id;
  console.log(`Usuario ${email} ya existía; no se toca su contraseña.`);
}
await seedCategories(db, userId);
await seedDefaultAccounts(db, userId);
await seedDefaultLoans(db, userId);
console.log('Categorías y cuentas sembradas.');
await db.end();
