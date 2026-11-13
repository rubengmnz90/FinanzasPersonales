-- Personas a las que se les prestó plata del ahorro (cuentas "me debe"): el saldo es lo que esa persona me debe.
ALTER TABLE accounts DROP CONSTRAINT accounts_type_check;
ALTER TABLE accounts ADD CONSTRAINT accounts_type_check
  CHECK (type IN ('bank','cash','savings','card','cash_box','fund','debt','receivable'));
