-- Historial de cambios: cada alta, edición y borrado queda registrado (quién, cuándo, antes y después) para poder deshacerlo.
-- Se llena con triggers de la base, así que no depende de qué código o herramienta (web, IA, importador) hizo el cambio.

CREATE TABLE audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seq bigserial UNIQUE,
  at timestamptz NOT NULL DEFAULT now(),
  -- Cambios hechos en la misma transacción (una acción, incluidos los borrados en cascada) comparten tx_id.
  tx_id bigint NOT NULL DEFAULT txid_current(),
  user_id uuid,
  actor text NOT NULL,
  table_name text NOT NULL,
  row_id text,
  op text NOT NULL CHECK (op IN ('INSERT','UPDATE','DELETE')),
  old_data jsonb,
  new_data jsonb,
  reverted_at timestamptz,
  reverted_by uuid
);
CREATE INDEX audit_log_user_seq ON audit_log (user_id, seq DESC);
CREATE INDEX audit_log_tx ON audit_log (tx_id);

CREATE FUNCTION audit_row() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  o jsonb;
  n jsonb;
  d jsonb;
  uid uuid;
BEGIN
  IF TG_OP <> 'INSERT' THEN o := to_jsonb(OLD); END IF;
  IF TG_OP <> 'DELETE' THEN n := to_jsonb(NEW); END IF;
  IF TG_OP = 'UPDATE' AND o = n THEN RETURN NEW; END IF;
  d := COALESCE(n, o);
  uid := COALESCE(
    (d->>'user_id')::uuid,
    (SELECT user_id FROM accounts WHERE id = (d->>'account_id')::uuid),
    (SELECT user_id FROM loans WHERE id = (d->>'loan_id')::uuid),
    (SELECT user_id FROM plans WHERE id = (d->>'plan_id')::uuid),
    (SELECT p.user_id FROM plan_items i JOIN plans p ON p.id = i.plan_id WHERE i.id = (d->>'item_id')::uuid),
    (SELECT user_id FROM splits WHERE id = (d->>'split_id')::uuid),
    NULLIF(current_setting('app.user_id', true), '')::uuid
  );
  INSERT INTO audit_log (user_id, actor, table_name, row_id, op, old_data, new_data)
  VALUES (
    uid,
    COALESCE(NULLIF(current_setting('app.actor', true), ''), 'sistema'),
    TG_TABLE_NAME,
    COALESCE(d->>'id', (d->>'item_id') || ':' || (d->>'month')),
    TG_OP, o, n
  );
  RETURN COALESCE(NEW, OLD);
END $$;

CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON categories FOR EACH ROW EXECUTE FUNCTION audit_row();
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON transactions FOR EACH ROW EXECUTE FUNCTION audit_row();
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON plans FOR EACH ROW EXECUTE FUNCTION audit_row();
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON plan_periods FOR EACH ROW EXECUTE FUNCTION audit_row();
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON plan_items FOR EACH ROW EXECUTE FUNCTION audit_row();
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON plan_cells FOR EACH ROW EXECUTE FUNCTION audit_row();
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON planned_expenses FOR EACH ROW EXECUTE FUNCTION audit_row();
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON accounts FOR EACH ROW EXECUTE FUNCTION audit_row();
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON ledger_entries FOR EACH ROW EXECUTE FUNCTION audit_row();
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON recovery_allocations FOR EACH ROW EXECUTE FUNCTION audit_row();
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON recovery_cobros FOR EACH ROW EXECUTE FUNCTION audit_row();
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON splits FOR EACH ROW EXECUTE FUNCTION audit_row();
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON split_items FOR EACH ROW EXECUTE FUNCTION audit_row();
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON transfers FOR EACH ROW EXECUTE FUNCTION audit_row();
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON savings_buckets FOR EACH ROW EXECUTE FUNCTION audit_row();
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON loans FOR EACH ROW EXECUTE FUNCTION audit_row();
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON loan_installments FOR EACH ROW EXECUTE FUNCTION audit_row();
