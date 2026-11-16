-- Compras de tarjeta con rubro: el gasto cuenta en el resumen en la fecha de la compra, y el pago de la tarjeta
-- (transferencia) se ignora. Solo agrega columnas nulas: los movimientos existentes no cambian.
ALTER TABLE ledger_entries
  ADD COLUMN category_id uuid REFERENCES categories(id) ON DELETE SET NULL,
  -- Cuenta desde la que se pagará esta compra (p. ej. GNB). Informativo; el pago real es una transferencia.
  ADD COLUMN pay_from_account_id uuid REFERENCES accounts(id) ON DELETE SET NULL,
  -- Agrupa movimientos relacionados (una compra y su IVA) para verlos y totalizarlos juntos.
  ADD COLUMN group_key text;
CREATE INDEX ledger_entries_category ON ledger_entries (category_id) WHERE category_id IS NOT NULL;
