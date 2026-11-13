-- Flujo solo con cuentas propias marcadas, objetivos de ahorro (tocable / intocable) y préstamos con cuotas.

ALTER TABLE accounts ADD COLUMN in_flow boolean NOT NULL DEFAULT false;
UPDATE accounts SET in_flow = true WHERE type = 'bank' AND name IN ('GNB', 'Familiar');

-- Coomecipar es el ahorro y "Familiar Vibra Lejana" es la caja de Vibra Lejana: se fusionan sus datos
-- en esas cuentas y se retiran los bancos duplicados (solo si no tienen movimientos propios).
UPDATE accounts s SET alias = b.alias, institution = b.institution
FROM accounts b
WHERE b.user_id = s.user_id AND b.type = 'bank' AND b.name = 'Coomecipar'
  AND s.type = 'savings' AND s.name = 'Ahorro Coomecipar';
UPDATE accounts s SET alias = b.alias, institution = b.institution
FROM accounts b
WHERE b.user_id = s.user_id AND b.type = 'bank' AND b.name = 'Familiar Vibra Lejana'
  AND s.type = 'cash_box' AND s.name = 'Vibra Lejana';
DELETE FROM accounts a
WHERE a.type = 'bank' AND a.name IN ('Coomecipar', 'Familiar Vibra Lejana')
  AND NOT EXISTS (SELECT 1 FROM transactions t WHERE t.account_id = a.id)
  AND NOT EXISTS (SELECT 1 FROM transfers x WHERE x.from_account_id = a.id OR x.to_account_id = a.id)
  AND NOT EXISTS (SELECT 1 FROM ledger_entries e WHERE e.account_id = a.id);

-- Objetivos de ahorro: cada aporte tiene un destino; los intocables no se prestan sin usarlos explícitamente.
CREATE TABLE savings_buckets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  untouchable boolean NOT NULL DEFAULT false,
  sort int NOT NULL DEFAULT 0,
  UNIQUE (user_id, name)
);

-- Los aportes importados ya traen el concepto del Excel (Ahorro, Aguinaldo, Vacaciones, Emma): ese es su objetivo.
UPDATE ledger_entries e SET bucket = e.concept
FROM accounts a
WHERE a.id = e.account_id AND a.type = 'savings' AND e.bucket IS NULL AND e.tag IS NULL
  AND e.concept IN ('Ahorro', 'Aguinaldo', 'Vacaciones', 'Emma');

INSERT INTO savings_buckets(user_id, name, untouchable, sort)
SELECT u.id, v.name, v.untouchable, v.sort
FROM users u CROSS JOIN (VALUES
  ('Ahorro', false, 1), ('Aguinaldo', true, 2), ('Vacaciones', true, 3), ('Emma', true, 4)
) AS v(name, untouchable, sort)
ON CONFLICT (user_id, name) DO NOTHING;

-- Préstamos formales (Coomecipar, equipo de Vibra Lejana, nuevos) con sus cuotas.
CREATE TABLE loans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  lender text,
  principal bigint NOT NULL DEFAULT 0,
  installment_amount bigint NOT NULL DEFAULT 0,
  -- true: las cuotas pendientes entran a los gastos planeados (y a la proyección).
  in_projection boolean NOT NULL DEFAULT false,
  -- Cuenta del flujo desde la que se paga (NULL = la predeterminada).
  pay_account_id uuid REFERENCES accounts(id) ON DELETE SET NULL,
  -- Si la cuota sale de una caja (Vibra Lejana) se anota como movimiento de esa cuenta en vez de flujo.
  ledger_account_id uuid REFERENCES accounts(id) ON DELETE SET NULL,
  note text,
  import_key text,
  UNIQUE (user_id, name)
);

CREATE TABLE loan_installments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id uuid NOT NULL REFERENCES loans(id) ON DELETE CASCADE,
  number int NOT NULL,
  due_date date NOT NULL,
  amount bigint NOT NULL,
  paid boolean NOT NULL DEFAULT false,
  paid_date date,
  planned_expense_id uuid REFERENCES planned_expenses(id) ON DELETE SET NULL,
  transaction_id uuid REFERENCES transactions(id) ON DELETE SET NULL,
  ledger_entry_id uuid REFERENCES ledger_entries(id) ON DELETE SET NULL,
  UNIQUE (loan_id, number)
);
CREATE INDEX loan_installments_loan ON loan_installments (loan_id, number);
