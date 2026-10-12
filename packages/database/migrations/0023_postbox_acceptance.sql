-- Metadata only. SMTP acceptance means provider accepted, not mailbox delivery.
ALTER TABLE mail.delivery DROP CONSTRAINT delivery_acceptance_check;
ALTER TABLE mail.delivery ADD CONSTRAINT delivery_acceptance_check
 CHECK (acceptance IS NULL OR acceptance IN ('sandbox', 'postbox'));
