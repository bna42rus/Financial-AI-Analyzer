# Local bank PDF adapters — Development

This block adds a device-only `prepareLocalBankPdfs` entry point, backed by pinned PDF.js 5.6.205 and three versioned adapters. It does not yet connect the import dialog to the live finance API. Product baseline 1.3 and the original sources remain unchanged; coverage is partial.

## Supported observed structures

| Adapter | Source facts | Privacy and ambiguity |
| --- | --- | --- |
| `tbank-movement-pdf/1` | Movement certificate: account label, operation date, processing date, signed amount in card/account currency. Original foreign-operation amount does not replace account amount. | Full account HMAC; masked card, description and contract number omitted. Without an explicit timezone, operation date remains a source-local day. |
| `ozon-movement-pdf/1` | Movement certificate: labelled payment-account contract, signed RUB amount, source datetime with explicit Moscow legend. Same table may continue without a second-page header. | A new `bank_contract` namespace represents the account contract, not a loan. Document codes are omitted because stability has not been established. |
| `sber-card-pdf/1` | Debit/credit-card statements: operation datetime with explicit МСК, separate processing date, account RUB amount rather than remaining balance or foreign-operation amount. Unsigned amounts are debits; explicit plus means credit. Repeated headers can move columns. | Account HMAC; authorization codes and masked cards omitted. Two identical purchases retain separate source ordinals. |

Issuer/template and labelled source-account evidence are mandatory. An unrelated account number elsewhere in a PDF cannot substitute for a missing or masked source identifier. A changed layout is blocked rather than silently dropping an unsupported table page. This is support for the observed templates, not a claim that all PDFs from these banks are supported.

## Local boundary and server acceptance

File bytes are copied into a local PDF worker. No file URL, external font/CMap URL, telemetry, arbitrary PDF script, storage or server client is provided. Worker fetch and evaluation are disabled. Passwords can be supplied to this local attempt only; technical errors contain fixed codes rather than PDF exceptions or text. Reader destruction, byte-copy clearing and local HMAC session disposal run on success, failure and abort. JavaScript strings and the original user-selected `File` remain subject to browser garbage collection; the implementation does not promise physical zeroization.

The original `text-free/1` profile remains available. The browser entry point now selects the separate [finite safe source profile](safe-bank-source.md). In the original profile, Names, merchants, descriptions, recipient identifiers, raw account/contract values, document/auth codes, filenames and passwords are absent. There is no claim that the general-purpose `sanitizeText` guard can safely retain arbitrary statement text. The finite profile retains only closed event/merchant codes with independent server validation; arbitrary safe text is still pending.

Prepared version `bank-pdf/1` selects the corresponding bank parser version in persisted observation metadata. The older `source-adapter/1` preparation remains valid. The server still independently checks dates, canonical integer money, sign/direction, RUB, HMAC shape, row ordinals, closed field names and processing versions. Invalid recognized rows become technical issues; a blocked file does not remove valid rows from other files. The file fingerprint remains per-user HMAC.

Files exceeding the local byte limit or failing byte reads appear only in the technical `localIssues` result: no fingerprint is invented without reading the file. Other files continue. If none could be read, `batch` is null and there is no server submission. A future live UI must combine these local issues with accepted batch counts.

Ozon's `bank_contract` alias requires forward migration `0013_bank_contract_alias.sql`, after 0012: `operator migrate-bank-contract-alias`. It uses the existing tenant/alias uniqueness and finance role protections. It creates an account of type `other`; it does not manufacture loan evidence. No new external service or API upload route is introduced.

## Checks and remaining work

- Synthetic adapter/reader tests cover exact decimal conversion and bigint bounds, currencies, account-label evidence, date/time validation, separate processing dates, moved/repeated and omitted page headers, duplicate real instances, raw-field omission, limits, password errors, cleanup and abort.
- Browser scenarios use actual synthetic PDF bytes and the real bundled PDF worker for all three banks, on desktop and mobile. They assert no outbound requests, writes or persistent browser storage. Multi-file partial preparation is checked independently.
- PostgreSQL/HTTP tests accept all three prepared formats, persist concrete parser versions, keep Ozon accounts non-loan and reimport identical files without extra transactions.
- Existing supplied PDFs were inspected and checked locally for structural recognition and row coverage. Their bytes, rows, identifiers, filenames, dates and amounts are not repository fixtures, AI context, test logs or Staging data. Reproducible CI uses only artificial data.

CI evidence is recorded at the final commit in the PR. Browser checks locally require a compatible installed Chromium; PostgreSQL integration requires the isolated PostgreSQL 18 fixture.

Still pending: CSV/XLSX adapters, local OCR, password/UI flow, richer safe source text, strict source fingerprints, remembered duplicate decisions, import cancellation, classification/link final pass and live import screens. Scans report `OCR_REQUIRED`; unknown/changed formats report a technical reason and never fall back to uploading the raw document. Development guards are 20 MiB/file, 100 pages, 100,000 text items, 2 million extracted characters, 10 files and 1,000 rows/batch; these are not final device/product limits.

PDF.js references: [document loading API](https://mozilla.github.io/pdf.js/api/draft/module-pdfjsLib.html), [build/worker layout](https://mozilla.github.io/pdf.js/getting_started/).
