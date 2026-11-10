-- An operator can extend access a few days beyond an existing allowance window.
-- Keep the remaining units until that new access end; do not refill them on the
-- former access-end date. Only repair current, audited, short extensions.
DO $$
DECLARE
  at_time timestamptz := clock_timestamp();
  target record;
  slot record;
  saved boolean;
BEGIN
  FOR target IN
    SELECT c.user_id,c.access_end
    FROM commerce.access_cycle c
    WHERE c.access_end > at_time AND NOT c.indefinite
      AND EXISTS (
        SELECT 1 FROM commerce.manual_access_audit a
        WHERE a.user_id = c.user_id
          AND a.data->>'mode' IN ('extend','set_end')
          AND a.data->'after'->>'accessEnd' IS NOT NULL
          AND (a.data->'after'->>'accessEnd')::timestamptz = c.access_end
      )
  LOOP
    SELECT * INTO slot FROM commerce.customer_allowance_usage(target.user_id,at_time);
    IF slot.period_end IS NOT NULL
      AND slot.period_end < target.access_end
      AND target.access_end <= slot.period_end + interval '31 days'
      AND slot.quota IS NOT NULL THEN
      SELECT commerce.set_customer_allowance(target.user_id,at_time,target.access_end,slot.quota)
      INTO saved;
      IF NOT saved THEN
        RAISE EXCEPTION 'ALLOWANCE_COST_PENDING for audited manual extension';
      END IF;
    END IF;
  END LOOP;
END $$;
