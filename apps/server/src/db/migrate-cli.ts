import './env';
import { createDb } from './client';
import { migrate } from './migrate';

const db = createDb(process.env.DATABASE_URL!);
const applied = await migrate(db);
console.log(applied.length ? `Migraciones aplicadas: ${applied.join(', ')}` : 'Base al día.');
await db.end();
