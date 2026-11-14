-- Quién pagó (cliente o pagador) en los ingresos del flujo: Tellma, CBG...
ALTER TABLE transactions ADD COLUMN payer text;

UPDATE transactions SET payer = 'CBG' WHERE kind = 'income' AND payer IS NULL AND item ILIKE '%cbg%';
UPDATE transactions SET payer = 'Tellma' WHERE kind = 'income' AND payer IS NULL AND item ILIKE '%tellma%';
