ALTER TABLE finance.counterparty ADD COLUMN proposal_operation_ids uuid[];
ALTER TABLE finance.counterparty ADD COLUMN auto_rule_id uuid;
ALTER TABLE finance.counterparty ADD CONSTRAINT counterparty_auto_rule
 FOREIGN KEY(user_id,auto_rule_id) REFERENCES finance.rule(user_id,id)
 ON DELETE SET NULL (auto_rule_id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE finance.counterparty ADD CONSTRAINT counterparty_one_auto_rule
 UNIQUE(user_id,auto_rule_id) DEFERRABLE INITIALLY DEFERRED;
