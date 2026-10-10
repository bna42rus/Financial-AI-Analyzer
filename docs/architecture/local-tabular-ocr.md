# Local tables, OCR and finite bank classification

Development block after PR #32. Original PDF/Word and baseline 1.3 are unchanged. Requirements 18.1–18.6, 18.10–18.12 and privacy govern this implementation; coverage remains partial.

## Files and boundaries

Authenticated upload accepts PDF, CSV and XLSX in one selection, up to 10 files / 20 MB each / 1000 total rows. Supported CSV/XLSX tables identify the bank (`Т-Банк`, `Ozon Банк`, `Сбербанк`) and full source account/contract explicitly, either in two-column metadata before the header or in each row. Required headers: `Дата операции`, `Сумма операции` or `Сумма в рублях`, `Валюта`, and `Описание` / `Описание операции` / `Назначение платежа`. Optional processing dates remain independent. Account-column conflicts are row issues; unknown or mixed issuers are blocked. No account identity is guessed from masked cards or a filename.

CSV supports UTF-8/BOM and Windows-1251, semicolon/comma/tab separators and exact quotes/newlines. Amounts use signed decimal integer conversion, never float money. Text dates use explicit calendars or timezone-marked ISO instants. XLSX preserves cell lexical values, shared/inline strings and whole-day Excel serials with known date formats, including the 1900 leap-year exception and 1904 epoch. Formulas/errors cannot supply financial facts. ZIP entry/decompressed-size/cell/text limits, DTD/external relationship rejection and nonempty extra-sheet rejection prevent implicit data loss or external reads. General tables, encrypted XLSX, fractional date serials and bank formats without required source evidence are not claimed supported. Real-bank export acceptance is still required.

Text PDFs retain the observed parsers. Pages without text are rendered locally at a bounded resolution and recognized with pinned Tesseract.js 7 and Russian/English models. Assets are generated from locked dependencies by `scripts/prepare-ocr-assets.mjs`, included in the build and served by the same site. No CDN, image upload, AI or OCR cache is used. Workers and canvas are destroyed on success, failure, cancellation or timeout. Scans over 20 pages / 6 million pixels per page are blocked. Low-confidence/malformed OCR is blocked rather than corrected by guessing. Known-layout validation still applies; arbitrary scanned layouts are not supported.

OCR records use explicit parser codes and no merchant, full-description fingerprint or stable bank ID evidence. They remain unclassified and appear in Review. Users can correct effective dates/amounts without replacing bank source facts. Recognition confidence is not a guarantee of accuracy; real device/scan corpus and owner acceptance remain open.

## Versioned source and classification

`bank-local/1` with `bank-source/3` has a closed per-row parser registry. Legacy text-free, bank-source/1 and bank-source/2 contracts remain unchanged. Each immutable source observation records its parser, sanitizer and classifier. Raw text, names, recipients, filenames, passwords and account numbers remain device-only; server storage has canonical finite labels and per-user keyed digests.

Profile 3 adds exact, sign-consistent cash withdrawal/deposit, cashback and incoming/outgoing transfer prefixes. Cash is neutral by default, cashback income, transfer purpose unresolved. It never infers an own transfer or counterparty from a bank description. Personal rules and manual corrections retain their existing priority. Unknown and OCR rows remain unresolved; full AI/global categorization and the final whole-batch transfer/refund matching pass are separate work.

Apply migration `0018_local_bank_classification.sql` after 0001–0017 using `operator migrate-local-bank-classification`, with the Development migration-owner connection. It extends only the finite source-evidence constraint. After the first new import, older readers/workers cannot process the new contract/events safely: pause imports, drain accepted jobs and use a compatible runtime or forward-fix. No destructive down migration is provided.

## Verification

Synthetic core tests exercise exact money, calendars, CSV quoting, issuer/account ambiguity, row isolation, parser privacy and conservative classification. PostgreSQL/HTTP tests exercise source persistence, retries, cancellation and rejection of forged OCR/foreign parser evidence. Browser checks exercise actual CSV/XLSX extraction, XLSX safety cases, local OCR models without external requests/storage, plus upload on desktop/mobile. Full CI and visual results of the published head are recorded in the PR. Real statements never enter Git/CI, and CI does not substitute for Safari/device corpus or Staging acceptance.

Additive requirement coverage is recorded in `docs/product/local-tabular-ocr-coverage.json`; the original registry remains intact.
