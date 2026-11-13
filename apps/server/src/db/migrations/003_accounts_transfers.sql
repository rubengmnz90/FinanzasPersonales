-- Cuentas bancarias y efectivo, movimientos por cuenta, transferencias y ahorros por objetivo.

ALTER TABLE accounts DROP CONSTRAINT accounts_type_check;
ALTER TABLE accounts ADD CONSTRAINT accounts_type_check
  CHECK (type IN ('bank','cash','savings','card','cash_box','fund','debt'));
ALTER TABLE accounts
  ADD COLUMN alias text,
  ADD COLUMN institution text,
  ADD COLUMN opening_balance bigint NOT NULL DEFAULT 0,
  ADD COLUMN is_default boolean NOT NULL DEFAULT false,
  ADD COLUMN archived boolean NOT NULL DEFAULT false,
  ADD COLUMN sort int NOT NULL DEFAULT 0;

-- Las tarjetas pasan a llamarse "Tarjeta X" para no chocar con las cuentas bancarias del mismo banco.
UPDATE accounts SET name = 'Tarjeta ' || name WHERE type = 'card' AND name IN ('Coomecipar', 'GNB');

ALTER TABLE ledger_entries ADD COLUMN bucket text;

ALTER TABLE transactions
  ADD COLUMN account_id uuid REFERENCES accounts(id) ON DELETE SET NULL,
  ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE transactions ALTER COLUMN created_at SET DEFAULT clock_timestamp();
CREATE INDEX transactions_account ON transactions (account_id);

CREATE TABLE transfers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date date NOT NULL,
  seq bigint GENERATED ALWAYS AS IDENTITY,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  from_account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  to_account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  amount bigint NOT NULL CHECK (amount > 0),
  kind text NOT NULL DEFAULT 'transfer' CHECK (kind IN ('transfer','loan','repayment')),
  bucket text,
  note text,
  import_key text,
  CHECK (from_account_id <> to_account_id),
  UNIQUE (user_id, import_key)
);
CREATE INDEX transfers_user_date ON transfers (user_id, date, seq);
CREATE INDEX transfers_from ON transfers (from_account_id);
CREATE INDEX transfers_to ON transfers (to_account_id);

-- Cuentas iniciales para los usuarios existentes (los nuevos las reciben con seedDefaultAccounts).
INSERT INTO accounts(user_id,type,name,alias,institution,is_default,sort)
SELECT u.id, v.type, v.name, v.alias, v.institution, v.is_default, v.sort
FROM users u CROSS JOIN (VALUES
  ('bank','GNB','0971185507','GNB',true,1),
  ('bank','Familiar','2946999','Banco Familiar',false,2),
  ('bank','Familiar Vibra Lejana','rubengmnz90@gmail.com','Banco Familiar',false,3),
  ('bank','Coomecipar','2946999-6','Coomecipar',false,4),
  ('cash','Efectivo',NULL,NULL,false,5)
) AS v(type,name,alias,institution,is_default,sort)
ON CONFLICT (user_id,name) DO NOTHING;

UPDATE accounts SET institution = 'Coomecipar' WHERE type = 'savings' AND name = 'Ahorro Coomecipar';
UPDATE accounts SET institution = 'Banco Familiar' WHERE type = 'cash_box' AND name = 'Vibra Lejana';

-- Todo el flujo existente se atribuye a la cuenta GNB.
UPDATE transactions t SET account_id = a.id
FROM accounts a WHERE a.user_id = t.user_id AND a.type = 'bank' AND a.is_default AND t.account_id IS NULL;
