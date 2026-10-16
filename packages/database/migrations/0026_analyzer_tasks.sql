-- Additive, opt-in task runtime. Existing chats/messages/receipts keep their
-- original meaning. Commercial receipts never depend on a financial chat FK.
ALTER TABLE finance.analyzer_chat ADD COLUMN epoch uuid NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE finance.analyzer_chat ADD CONSTRAINT analyzer_chat_lifetime UNIQUE(user_id,id,epoch);
CREATE FUNCTION finance.fixed_chat_epoch() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF NEW.epoch<>OLD.epoch THEN RAISE EXCEPTION 'IMMUTABLE_CHAT_LIFETIME';END IF;RETURN NEW;END $$;
CREATE TRIGGER fixed_epoch BEFORE UPDATE ON finance.analyzer_chat FOR EACH ROW EXECUTE FUNCTION finance.fixed_chat_epoch();
REVOKE ALL ON FUNCTION finance.fixed_chat_epoch() FROM PUBLIC,finance_api,control_api,mail_finance,mail_control;

CREATE TABLE finance.analyzer_globals (
 user_id text PRIMARY KEY REFERENCES finance.workspace(user_id) ON DELETE CASCADE,
 generation uuid NOT NULL,snapshot jsonb NOT NULL CHECK(jsonb_typeof(snapshot)='object'),
 revision bigint NOT NULL CHECK(revision BETWEEN 0 AND 9007199254740991),invalidated boolean NOT NULL DEFAULT false,
 CHECK(snapshot->>'revision'=revision::text)
);
CREATE TABLE finance.analyzer_global_change (
 user_id text NOT NULL REFERENCES finance.analyzer_globals(user_id) ON DELETE CASCADE,id uuid NOT NULL,
 request jsonb NOT NULL,snapshot jsonb NOT NULL,PRIMARY KEY(user_id,id)
);
CREATE TABLE finance.analyzer_task_book (
 user_id text NOT NULL,chat_id uuid NOT NULL,chat_epoch uuid NOT NULL,generation uuid NOT NULL,
 book jsonb NOT NULL CHECK(jsonb_typeof(book)='object'),head uuid,node_count integer NOT NULL CHECK(node_count BETWEEN 0 AND 100),
 PRIMARY KEY(user_id,chat_id),FOREIGN KEY(user_id,chat_id,chat_epoch) REFERENCES finance.analyzer_chat(user_id,id,epoch) ON DELETE CASCADE,
 CHECK(jsonb_array_length(book->'nodes')=node_count),
 CHECK((node_count=0 AND head IS NULL) OR (node_count>0 AND head::text=book->'nodes'->-1->>'messageId'))
);
CREATE TABLE finance.analyzer_task_request (
 user_id text NOT NULL,id uuid NOT NULL,chat_id uuid NOT NULL,chat_epoch uuid NOT NULL,generation uuid NOT NULL,
 request jsonb NOT NULL,input jsonb NOT NULL,expected jsonb NOT NULL,
 anchor_at timestamptz NOT NULL,period_start timestamptz NOT NULL,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','cancelled','completed')),
 reply jsonb,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(user_id,id),FOREIGN KEY(user_id,chat_id,chat_epoch) REFERENCES finance.analyzer_chat(user_id,id,epoch) ON DELETE CASCADE,
 CHECK((state='completed')=(reply IS NOT NULL))
);
CREATE TABLE finance.analyzer_task_cache (
 user_id text NOT NULL,request_id uuid NOT NULL,step text NOT NULL CHECK(step IN ('gate','plan')),
 payload jsonb NOT NULL CHECK(jsonb_typeof(payload)='object'),PRIMARY KEY(user_id,request_id,step),
 FOREIGN KEY(user_id,request_id) REFERENCES finance.analyzer_task_request(user_id,id) ON DELETE CASCADE,
 FOREIGN KEY(user_id,request_id,step) REFERENCES commerce.analyzer_request(user_id,request_id,step)
);
CREATE TABLE finance.analyzer_task_cancel (
 user_id text NOT NULL,request_id uuid NOT NULL,chat_id uuid NOT NULL,chat_epoch uuid NOT NULL,
 PRIMARY KEY(user_id,request_id),FOREIGN KEY(user_id,chat_id,chat_epoch) REFERENCES finance.analyzer_chat(user_id,id,epoch) ON DELETE CASCADE
);
CREATE FUNCTION finance.fixed_task_claim() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF ROW(NEW.user_id,NEW.id,NEW.chat_id,NEW.chat_epoch,NEW.generation,NEW.request,NEW.input,NEW.expected,NEW.anchor_at,NEW.period_start,NEW.created_at)
 IS DISTINCT FROM ROW(OLD.user_id,OLD.id,OLD.chat_id,OLD.chat_epoch,OLD.generation,OLD.request,OLD.input,OLD.expected,OLD.anchor_at,OLD.period_start,OLD.created_at)
 OR OLD.state<>'pending' AND ROW(NEW.state,NEW.reply) IS DISTINCT FROM ROW(OLD.state,OLD.reply)
 THEN RAISE EXCEPTION 'IMMUTABLE_TASK_REQUEST';END IF;RETURN NEW;END $$;
CREATE TRIGGER fixed_claim BEFORE UPDATE ON finance.analyzer_task_request FOR EACH ROW EXECUTE FUNCTION finance.fixed_task_claim();
REVOKE ALL ON FUNCTION finance.fixed_task_claim() FROM PUBLIC,finance_api,control_api,mail_finance,mail_control;
CREATE FUNCTION finance.finish_deleted_task_receipts() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 UPDATE commerce.analyzer_request SET state='completed',error_code='AI_STATE_CHANGED',updated_at=clock_timestamp()
 WHERE user_id=OLD.user_id AND request_id=OLD.id AND state='received';RETURN OLD;END $$;
CREATE TRIGGER finish_receipts BEFORE DELETE ON finance.analyzer_task_request FOR EACH ROW EXECUTE FUNCTION finance.finish_deleted_task_receipts();
REVOKE ALL ON FUNCTION finance.finish_deleted_task_receipts() FROM PUBLIC,finance_api,control_api,mail_finance,mail_control;
DO $$DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['analyzer_globals','analyzer_global_change','analyzer_task_book','analyzer_task_request','analyzer_task_cache','analyzer_task_cancel'] LOOP
 EXECUTE format('ALTER TABLE finance.%I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format('ALTER TABLE finance.%I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY own_data ON finance.%I TO finance_api USING(user_id=current_setting(''app.user_id'',true)) WITH CHECK(user_id=current_setting(''app.user_id'',true))',t);
 EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON finance.%I TO finance_api',t);
 EXECUTE format('REVOKE ALL ON finance.%I FROM PUBLIC,control_api,mail_finance,mail_control',t);
END LOOP;END $$;
-- Append-only private provider payloads and global-change receipts. UPDATE is
-- unnecessary; DELETE is needed for normal owner/chat/reset privacy cascades.
REVOKE UPDATE ON finance.analyzer_task_cache,finance.analyzer_global_change,finance.analyzer_task_cancel FROM finance_api;

CREATE FUNCTION finance.purge_task_generation() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF NEW.generation<>OLD.generation THEN
  -- Partial deletion also changes generation to invalidate pending imports.
  -- Existing dependency triggers remove affected chats; unrelated history and
  -- completed semantic definitions survive, explicitly rebound by the server.
  DELETE FROM finance.analyzer_task_request WHERE user_id=OLD.user_id;
  DELETE FROM finance.analyzer_global_change WHERE user_id=OLD.user_id;
  IF NEW.key_version<>OLD.key_version THEN
   DELETE FROM finance.analyzer_chat WHERE user_id=OLD.user_id;
   DELETE FROM finance.analyzer_globals WHERE user_id=OLD.user_id;
  ELSE
   UPDATE finance.analyzer_task_book SET generation=NEW.generation,book=jsonb_set(book,'{scope,generation}',to_jsonb(NEW.generation::text)) WHERE user_id=OLD.user_id;
   UPDATE finance.analyzer_globals SET generation=NEW.generation WHERE user_id=OLD.user_id;
  END IF;
 END IF;RETURN NEW;END $$;
CREATE TRIGGER task_generation_reset BEFORE UPDATE OF generation ON finance.workspace FOR EACH ROW EXECUTE FUNCTION finance.purge_task_generation();
REVOKE ALL ON FUNCTION finance.purge_task_generation() FROM PUBLIC,finance_api,control_api,mail_finance,mail_control;

-- Pending claims and semantic books may reference an object before a message
-- dependency is written. Deletion removes the entire affected conversation.
CREATE FUNCTION finance.purge_task_reference() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE reference_id uuid;
BEGIN
 IF TG_TABLE_NAME='source_observation' THEN reference_id=finance.canonical_operation(OLD.user_id,OLD.transaction_id);ELSE reference_id=OLD.id;END IF;
 DELETE FROM finance.analyzer_chat c WHERE c.user_id=OLD.user_id AND (
  EXISTS(SELECT 1 FROM finance.analyzer_task_book b WHERE (b.user_id,b.chat_id)=(c.user_id,c.id) AND strpos(b.book::text,reference_id::text)>0) OR
  EXISTS(SELECT 1 FROM finance.analyzer_task_request r WHERE (r.user_id,r.chat_id)=(c.user_id,c.id) AND strpos(r.input::text,reference_id::text)>0));
 -- Preserve monotonic stamps and unrelated conditions. A stale owned reference
 -- blocks dispatch until a valid explicit UI snapshot replaces it; never widen
 -- a filter or reset its revision counter by deleting the global row.
 UPDATE finance.analyzer_globals SET invalidated=true WHERE user_id=OLD.user_id AND strpos(snapshot::text,reference_id::text)>0;
 RETURN OLD;
END $$;
DO $$DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['transaction','source_observation','account','category','counterparty'] LOOP
 EXECUTE format('CREATE TRIGGER task_reference_delete BEFORE DELETE ON finance.%I FOR EACH ROW EXECUTE FUNCTION finance.purge_task_reference()',t);
END LOOP;END $$;
REVOKE ALL ON FUNCTION finance.purge_task_reference() FROM PUBLIC,finance_api,control_api,mail_finance,mail_control;

-- Cloud's exact public model identifier contains a slash. No arbitrary text,
-- credentials or endpoint is admitted by this additive identifier constraint.
ALTER TABLE commerce.ai_cost_reservation DROP CONSTRAINT ai_cost_reservation_quoted_model_version_check;
ALTER TABLE commerce.ai_cost_reservation ADD CONSTRAINT ai_cost_reservation_quoted_model_version_check CHECK(quoted_model_version ~ '^[A-Za-z0-9._/-]{1,160}$');
-- One logical monthly budget even while old/new code overlaps in a rollout.
-- Existing duplicate aliases stop this migration for explicit reconciliation;
-- no receipt or balance is rewritten/deleted to make the index pass.
CREATE UNIQUE INDEX ai_user_budget_period_precision ON commerce.ai_user_budget(user_id,anchor_at,(date_trunc('milliseconds',period_start AT TIME ZONE 'UTC')));
