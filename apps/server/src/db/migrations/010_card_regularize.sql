-- Compras de tarjeta "por regularizar": se cargaron a la tarjeta pero el dinero real aún no salió de una cuenta
-- (p. ej. un gasto del presupuesto pagado con la tarjeta). Se regulariza pagando la tarjeta desde una cuenta
-- (una transferencia), de a poco: cada abono queda ligado a la compra y a la transferencia que lo cubrió.
-- Solo agrega una columna con valor por defecto y una tabla nueva: nada existente cambia.
ALTER TABLE ledger_entries ADD COLUMN needs_regularize boolean NOT NULL DEFAULT false;

CREATE TABLE entry_regularizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_id uuid NOT NULL REFERENCES ledger_entries(id) ON DELETE CASCADE,
  -- Al borrar la transferencia, el abono desaparece y la compra vuelve a quedar pendiente por ese monto.
  transfer_id uuid NOT NULL REFERENCES transfers(id) ON DELETE CASCADE,
  amount bigint NOT NULL CHECK (amount > 0),
  date date NOT NULL
);
CREATE INDEX entry_regularizations_entry ON entry_regularizations (entry_id);
CREATE INDEX entry_regularizations_transfer ON entry_regularizations (transfer_id);
CREATE INDEX ledger_entries_regularize ON ledger_entries (account_id) WHERE needs_regularize;
