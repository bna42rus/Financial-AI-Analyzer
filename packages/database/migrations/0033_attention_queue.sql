-- A single live queue per owner; old explicit review sessions stay readable.
ALTER TABLE finance.review_session ADD COLUMN live_queue boolean NOT NULL DEFAULT false;
CREATE UNIQUE INDEX review_session_live_queue ON finance.review_session(user_id) WHERE live_queue;
ALTER TABLE finance.review_session DROP CONSTRAINT review_session_operation_ids_check;
ALTER TABLE finance.review_session ADD CHECK(live_queue OR cardinality(operation_ids) BETWEEN 0 AND 1000);
