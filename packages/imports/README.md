# Import preparation

Browser WebCrypto preparation and independent server validation for the text-free `local-prepare/1` profile. Account/card/loan-contract/bank-reference and file fingerprints use versioned per-user HMAC; raw bytes, filenames, passwords and free text stay local. `dispose`/AbortSignal closes the memory-only preparation session, including in-flight work.

This is a preparation contract, not a bank parser or completed import. `/finance/import-validation` returns a count-only report and creates no financial records. Actual PDF/CSV/XLSX extraction, bank fixtures, safe merchant/description extraction, OCR, account matching, dedupe/provenance, queue, cancellation and UI integration remain separate work. [Contract and boundaries](../../docs/architecture/import-preparation.md).
