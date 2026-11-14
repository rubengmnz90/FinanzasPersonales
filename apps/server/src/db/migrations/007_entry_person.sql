-- A quién se le prestó (o quién devolvió) cada retiro/devolución del ahorro. NULL = préstamo normal.
ALTER TABLE ledger_entries ADD COLUMN person text;

UPDATE ledger_entries e SET person = 'Osky'
FROM accounts a WHERE a.id = e.account_id AND a.type = 'savings' AND e.person IS NULL
  AND e.tag IN ('temp_withdrawal', 'return') AND e.concept ILIKE '%osky%';
UPDATE ledger_entries e SET person = 'Charlie'
FROM accounts a WHERE a.id = e.account_id AND a.type = 'savings' AND e.person IS NULL
  AND e.tag IN ('temp_withdrawal', 'return') AND e.concept ILIKE '%charlie%';
UPDATE ledger_entries e SET person = 'Amor'
FROM accounts a WHERE a.id = e.account_id AND a.type = 'savings' AND e.person IS NULL
  AND e.tag IN ('temp_withdrawal', 'return') AND e.concept ILIKE '%amor%';

-- Compras del súper que se devuelven con el cobro.
UPDATE ledger_entries e SET person = 'Devolver en cobro'
FROM accounts a WHERE a.id = e.account_id AND a.type = 'savings' AND e.person IS NULL
  AND e.tag = 'temp_withdrawal' AND e.date = '2026-11-12' AND e.concept IN ('Super', 'Super Emma');
-- Préstamo de 60.000 del 14/11: el concepto es "Salida", la persona "Devolver en cobro".
UPDATE ledger_entries e SET concept = 'Salida', person = 'Devolver en cobro'
FROM accounts a WHERE a.id = e.account_id AND a.type = 'savings'
  AND e.tag = 'temp_withdrawal' AND e.concept = 'Devolver en cobro';
