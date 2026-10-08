-- A payment-account contract is not evidence of a loan.
ALTER TABLE finance.ingestion_row DROP CONSTRAINT ingestion_row_alias_kind_check;
ALTER TABLE finance.ingestion_row ADD CONSTRAINT ingestion_row_alias_kind_check
 CHECK(alias_kind IN ('bank_account','card','loan_contract','bank_contract'));
