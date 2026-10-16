-- Original observation identities/facts remain append-only. Mutable operation aliases
-- project all original instances onto one active transaction, without copying sources.
ALTER TABLE finance.transaction ADD merged_into_id uuid;
ALTER TABLE finance.transaction ADD CHECK(merged_into_id IS DISTINCT FROM id);
ALTER TABLE finance.transaction ADD FOREIGN KEY(user_id,merged_into_id) REFERENCES finance.transaction(user_id,id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED;
CREATE INDEX ON finance.transaction(user_id,merged_into_id) WHERE merged_into_id IS NOT NULL;
ALTER TABLE finance.transaction ALTER source_observation_id DROP NOT NULL;
ALTER TABLE finance.transaction ADD CHECK(merged_into_id IS NOT NULL OR source_observation_id IS NOT NULL);
-- A canonical transaction may select a source belonging to one of its original IDs.
DO $$ DECLARE c text;BEGIN
 SELECT conname INTO c FROM pg_constraint WHERE conrelid='finance.transaction'::regclass AND confrelid='finance.source_observation'::regclass AND contype='f';
 EXECUTE format('ALTER TABLE finance.transaction DROP CONSTRAINT %I',c);
END $$;
ALTER TABLE finance.transaction ADD FOREIGN KEY(user_id,source_observation_id) REFERENCES finance.source_observation(user_id,id) DEFERRABLE INITIALLY DEFERRED;
-- Invoker permissions and tenant RLS apply; no elevated write path to bank facts.
CREATE FUNCTION finance.canonical_operation(tenant text,operation uuid) RETURNS uuid LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT COALESCE(merged_into_id,id) FROM finance.transaction WHERE user_id=tenant AND id=operation
$$;
REVOKE ALL ON FUNCTION finance.canonical_operation(text,uuid) FROM PUBLIC,control_api,mail_finance,mail_control;
GRANT EXECUTE ON FUNCTION finance.canonical_operation(text,uuid) TO finance_api;
CREATE FUNCTION finance.check_canonical_source() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE t record;target uuid;BEGIN
 SELECT * INTO t FROM finance.transaction WHERE user_id=NEW.user_id AND id=NEW.id;
 IF NOT FOUND THEN RETURN NULL;END IF;
 IF EXISTS(SELECT 1 FROM finance.transaction a JOIN finance.transaction p ON (p.user_id,p.id)=(a.user_id,a.merged_into_id) WHERE a.user_id=t.user_id AND p.merged_into_id IS NOT NULL AND (a.id=t.id OR p.id=t.id)) THEN RAISE EXCEPTION 'canonical chain' USING ERRCODE='23514';END IF;
 IF EXISTS(SELECT 1 FROM finance.transaction a JOIN finance.source_observation o ON (o.user_id,o.id)=(a.user_id,a.source_observation_id) WHERE a.user_id=t.user_id AND (a.id=t.id OR o.transaction_id=t.id) AND finance.canonical_operation(o.user_id,o.transaction_id) IS DISTINCT FROM COALESCE(a.merged_into_id,a.id)) THEN RAISE EXCEPTION 'source outside canonical operation' USING ERRCODE='23514';END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION finance.check_canonical_source() FROM PUBLIC,finance_api,control_api,mail_finance,mail_control;
CREATE CONSTRAINT TRIGGER canonical_source AFTER INSERT OR UPDATE ON finance.transaction DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION finance.check_canonical_source();
-- Move component endpoints and link endpoints atomically while preserving their IDs.
DO $$ DECLARE c record;BEGIN
 FOR c IN SELECT conname FROM pg_constraint WHERE conrelid='finance.link'::regclass AND contype='f' LOOP
  EXECUTE format('ALTER TABLE finance.link ALTER CONSTRAINT %I DEFERRABLE INITIALLY DEFERRED',c.conname);
 END LOOP;
END $$;
