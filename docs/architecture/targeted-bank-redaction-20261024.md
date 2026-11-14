# Targeted bank-text redaction — owner decision, 24 October 2026

The owner explicitly approved preserving FIO, IP/business names, ordinary numbers,
words containing digits and full transfer/SBP descriptions. This supersedes the
broader display stripping described in the earlier bank-descriptions note.
Product PDF §§6.4 and 35.2 still require sanitization of sensitive identifiers
before network transmission; the raw statement and full HMAC identity input stay
on the device.

Keep targeted redaction of card/account/contract/phone/email/passport identifiers,
labelled auth/operation/document/terminal/tax/bank identifiers and complete internet
links. Shared numeric identifier detection remains for strings shaped like full
card/account/phone values; it is no longer a blanket deletion of every digit or
every six-character word containing digits. Masked card suffixes and grouped INN/
BIK/SNILS values are handled by explicit labels. URLs are removed before generic
email sanitization so credentials inside a URL cannot leave a partial URL behind.

Examples preserved: `Магазин24`, `Аптека 36,6`, `ИП Иванов Иван Иванович`,
`Получатель: Петров Пётр Петрович`, `Перевод Иванову 1500 рублей за 2 билета`.
Examples masked: `карта ****1234`, `номер операции ABCDEF-123`, `ИНН 123 456 7890`,
email, phone, passport and full HTTP/WWW URLs including paths and queries.

A readable transfer description does not become a merchant. Merchant extraction
still separates transfer/SBP semantics, and explicit MCC cannot upgrade a transfer
or SBP line to a purchase merely because numbers/text are retained. AI category
and manual/rule protection are unchanged. No source amount, operation date, source
identity HMAC, dedupe rule or RLS policy changes; no migration is necessary.

Already discarded fragments cannot be recovered from the database. After installing
this runtime, re-read the same source file to enrich exact source instances; manual
corrections remain separate. New tests use artificial names and numbers only.

Validation: 115 import/privacy/classification unit checks, 71 PostgreSQL ingestion/
classification checks and API/web types. Existing two synthetic paid answers may
be replayed by the installer against unchanged fixed inputs with zero new POSTs;
this is deterministic sanitization validation, not a new measurement of model
quality. A new full runtime hash binds the changed sanitizer. Existing Staging
admission, costs and call ceilings remain in force.
