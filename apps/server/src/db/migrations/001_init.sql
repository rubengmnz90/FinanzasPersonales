CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  must_change_password boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  token_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL
);

CREATE TABLE categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  group_name text NOT NULL CHECK (group_name IN ('Ingresos','Egresos','Gasto','Inversion','Otros')),
  archived boolean NOT NULL DEFAULT false,
  UNIQUE (user_id, name)
);

CREATE TABLE transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date date NOT NULL,
  seq bigint GENERATED ALWAYS AS IDENTITY,
  item text NOT NULL DEFAULT '',
  kind text NOT NULL CHECK (kind IN ('income','expense')),
  amount bigint NOT NULL CHECK (amount >= 0),
  amount_expr text,
  category_id uuid REFERENCES categories(id) ON DELETE SET NULL,
  note text,
  import_key text,
  UNIQUE (user_id, import_key)
);
CREATE INDEX transactions_user_date ON transactions (user_id, date, seq);

CREATE TABLE plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  year int NOT NULL,
  name text NOT NULL,
  archived boolean NOT NULL DEFAULT false,
  import_key text,
  UNIQUE (user_id, import_key)
);

CREATE TABLE plan_periods (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id uuid NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  label text NOT NULL,
  day_of_month int NOT NULL CHECK (day_of_month BETWEEN 1 AND 31),
  sort int NOT NULL DEFAULT 0
);

CREATE TABLE plan_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id uuid NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  period_id uuid NOT NULL REFERENCES plan_periods(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('income','expense')),
  concept text NOT NULL,
  sort int NOT NULL DEFAULT 0,
  auto_source text CHECK (auto_source IN ('planned_expenses'))
);

CREATE TABLE plan_cells (
  item_id uuid NOT NULL REFERENCES plan_items(id) ON DELETE CASCADE,
  month int NOT NULL CHECK (month BETWEEN 1 AND 12),
  amount bigint NOT NULL DEFAULT 0,
  amount_expr text,
  PRIMARY KEY (item_id, month)
);

CREATE TABLE planned_expenses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  concept text NOT NULL,
  amount bigint NOT NULL,
  period_label text NOT NULL,
  due_date date NOT NULL,
  done boolean NOT NULL DEFAULT false,
  transaction_id uuid REFERENCES transactions(id) ON DELETE SET NULL,
  import_key text,
  UNIQUE (user_id, import_key)
);
CREATE INDEX planned_expenses_user_due ON planned_expenses (user_id, due_date);

CREATE TABLE accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type text NOT NULL CHECK (type IN ('savings','card','cash_box','fund','debt')),
  name text NOT NULL,
  credit_limit bigint,
  counterparty text,
  UNIQUE (user_id, name)
);

CREATE TABLE ledger_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  date date NOT NULL,
  seq bigint GENERATED ALWAYS AS IDENTITY,
  concept text NOT NULL DEFAULT '',
  amount bigint NOT NULL,
  tag text,
  import_key text,
  UNIQUE (account_id, import_key)
);
CREATE INDEX ledger_entries_account ON ledger_entries (account_id, date, seq);

CREATE TABLE recovery_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  cobro_label text NOT NULL,
  cobro_index int NOT NULL,
  concept text NOT NULL,
  amount bigint NOT NULL,
  tag text CHECK (tag IN ('T','A','V','F')),
  import_key text,
  UNIQUE (user_id, import_key)
);

CREATE TABLE recovery_cobros (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  cobro_index int NOT NULL,
  label text NOT NULL,
  income bigint NOT NULL DEFAULT 0,
  UNIQUE (user_id, cobro_index)
);

CREATE TABLE splits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  date date NOT NULL DEFAULT current_date,
  participants jsonb NOT NULL DEFAULT '[]',
  import_key text,
  UNIQUE (user_id, import_key)
);

CREATE TABLE split_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  split_id uuid NOT NULL REFERENCES splits(id) ON DELETE CASCADE,
  sort int NOT NULL DEFAULT 0,
  label text NOT NULL DEFAULT '',
  total numeric NOT NULL,
  discount_pct numeric NOT NULL DEFAULT 0,
  shares jsonb NOT NULL DEFAULT '{}'
);

CREATE TABLE oauth_clients (
  client_id text PRIMARY KEY,
  client_secret_hash text,
  metadata jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE oauth_codes (
  code_hash text PRIMARY KEY,
  client_id text NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_challenge text NOT NULL,
  redirect_uri text NOT NULL,
  scopes text[] NOT NULL,
  resource text,
  expires_at timestamptz NOT NULL
);

CREATE TABLE oauth_tokens (
  token_hash text PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('access','refresh')),
  client_id text NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scopes text[] NOT NULL,
  resource text,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
