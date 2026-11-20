-- First purchase can carry optional consent. No charge runs before an account and cycle exist.
ALTER TABLE commerce.access_checkout DROP CONSTRAINT access_checkout_check1;
ALTER TABLE commerce.access_checkout ADD CHECK(application_id IS NULL OR mode IN ('once','enroll'));
