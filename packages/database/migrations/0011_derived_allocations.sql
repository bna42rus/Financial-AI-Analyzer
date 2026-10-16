-- Stable references identify a portion produced by another stored link, never a copied bank fact.
ALTER TABLE finance.link ADD COLUMN source_allocation_id uuid, ADD COLUMN target_allocation_id uuid,
 ADD CONSTRAINT distinct_source_selector CHECK(source_component_id IS NULL OR source_allocation_id IS NULL),
 ADD CONSTRAINT distinct_target_selector CHECK(target_component_id IS NULL OR target_allocation_id IS NULL),
 ADD CONSTRAINT no_self_allocation CHECK(id IS DISTINCT FROM source_allocation_id AND id IS DISTINCT FROM target_allocation_id),
 ADD CONSTRAINT source_allocation_fk FOREIGN KEY(user_id,source_allocation_id) REFERENCES finance.link(user_id,id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
 ADD CONSTRAINT target_allocation_fk FOREIGN KEY(user_id,target_allocation_id) REFERENCES finance.link(user_id,id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED;
CREATE INDEX ON finance.link(user_id,source_allocation_id) WHERE source_allocation_id IS NOT NULL;
CREATE INDEX ON finance.link(user_id,target_allocation_id) WHERE target_allocation_id IS NOT NULL;

-- Invoker rights and own-data RLS remain in force. Deferral permits an atomic history replay.
CREATE FUNCTION finance.check_allocation_references() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE c finance.link%ROWTYPE; p finance.link%ROWTYPE; selector record; cyclic boolean;
BEGIN
 SELECT * INTO c FROM finance.link WHERE user_id=NEW.user_id AND id=NEW.id;
 IF NOT FOUND THEN RETURN NULL; END IF;
 FOR selector IN SELECT * FROM (VALUES(c.source_id,c.source_allocation_id),(c.target_id,c.target_allocation_id)) AS e(operation_id,allocation_id) WHERE allocation_id IS NOT NULL LOOP
  SELECT * INTO p FROM finance.link WHERE user_id=c.user_id AND id=selector.allocation_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'allocation reference unavailable' USING ERRCODE='23503'; END IF;
  IF selector.operation_id<>p.source_id AND NOT(selector.operation_id=p.target_id AND p.kind IN ('own_transfer','debt_repayment')) THEN
   RAISE EXCEPTION 'allocation endpoint mismatch' USING ERRCODE='23514';
  END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM finance.link d WHERE d.user_id=c.user_id AND
  ((d.source_allocation_id=c.id AND d.source_id<>c.source_id AND NOT(d.source_id=c.target_id AND c.kind IN ('own_transfer','debt_repayment')))
   OR (d.target_allocation_id=c.id AND d.target_id<>c.source_id AND NOT(d.target_id=c.target_id AND c.kind IN ('own_transfer','debt_repayment'))))) THEN
  RAISE EXCEPTION 'dependent allocation endpoint mismatch' USING ERRCODE='23514';
 END IF;
 WITH RECURSIVE ancestry(id) AS (
  SELECT e.id FROM (VALUES(c.source_allocation_id),(c.target_allocation_id)) e(id) WHERE e.id IS NOT NULL
  UNION
  SELECT e.id FROM ancestry a JOIN finance.link l ON l.user_id=c.user_id AND l.id=a.id
   CROSS JOIN LATERAL (VALUES(l.source_allocation_id),(l.target_allocation_id)) e(id) WHERE e.id IS NOT NULL
 ) SELECT EXISTS(SELECT 1 FROM ancestry WHERE id=c.id) INTO cyclic;
 IF cyclic THEN RAISE EXCEPTION 'cyclic allocation reference' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION finance.check_allocation_references() FROM PUBLIC,finance_api,control_api,mail_finance,mail_control;
CREATE CONSTRAINT TRIGGER allocation_references AFTER INSERT OR UPDATE ON finance.link DEFERRABLE INITIALLY DEFERRED
 FOR EACH ROW EXECUTE FUNCTION finance.check_allocation_references();
