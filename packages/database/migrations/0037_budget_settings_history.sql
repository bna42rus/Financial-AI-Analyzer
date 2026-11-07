-- One settings snapshot per local day. Existing rows have no reliable history before this migration.
ALTER TABLE finance.budget ADD COLUMN settings_history jsonb NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(settings_history)='object');
ALTER TABLE finance.budget ADD COLUMN settings_history_legacy boolean NOT NULL DEFAULT true;
CREATE FUNCTION finance.record_budget_settings() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE local_day text;
BEGIN
 IF TG_OP='UPDATE' THEN
   IF (OLD.name,OLD.definition,OLD.enabled,OLD.dependency_status) IS NOT DISTINCT FROM
      (NEW.name,NEW.definition,NEW.enabled,NEW.dependency_status) THEN
     RETURN NEW;
   END IF;
 END IF;
 local_day := to_char(clock_timestamp() AT TIME ZONE (NEW.definition->>'timezone'),'YYYY-MM-DD');
 NEW.settings_history := NEW.settings_history || jsonb_build_object(local_day,jsonb_build_object(
   'name',NEW.name,'definition',NEW.definition,'enabled',NEW.enabled,'dependencyStatus',NEW.dependency_status));
 RETURN NEW;
END $$;
-- Bootstrap uses the earliest defensible settings, observed at migration time.
UPDATE finance.budget SET settings_history=jsonb_build_object(
 to_char(clock_timestamp() AT TIME ZONE (definition->>'timezone'),'YYYY-MM-DD'),
 jsonb_build_object('name',name,'definition',definition,'enabled',enabled,'dependencyStatus',dependency_status));
ALTER TABLE finance.budget ALTER COLUMN settings_history_legacy SET DEFAULT false;
CREATE TRIGGER record_budget_settings BEFORE INSERT OR UPDATE ON finance.budget
 FOR EACH ROW EXECUTE FUNCTION finance.record_budget_settings();
