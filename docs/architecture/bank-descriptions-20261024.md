# Bank descriptions and wider category evidence — 2026-10-24

The /3 importer turned source descriptions into event labels and exposed only a
fixed list of twenty brands. Unknown shops were consequently unreadable to the
user and absent from model requests. This was narrower than product PDF §§6.4–6.5,
18.11 and 35.2–35.5. The change implements sanitized bank descriptions separately
from effective user labels; it does not retain raw files or send bank statements.

## Data flow

`bank-source/4` retains the existing HMAC description identity and local adapter.
Before transmission, browser preparation derives closed `details` containing
`description` (1000 UTF-16 units), `merchantText` (160), `bankCategory` (160) and
optional four-digit MCC. Recognized CSV/XLSX headers supply the latter fields;
PDF layouts currently supply description only. Unknown layout/OCR does not gain
invented text or MCC. The old /1–/3 contracts are unchanged and reject details.

The shared cleaner removes known identifiers, labelled document/auth/reference
codes, URLs, numbers and recognizable recipient/person fragments. Transfers keep
an event label rather than their recipient text. Independent server validation
rejects text that the same cleaning would change, including on otherwise invalid
rows. This is a deterministic sanitizer with finite tested patterns, not a claim
of perfect detection of every possible natural-language identifier.

Explicit payment/refund templates determine bank event. An unrecognized line is
kept for display as `other`, with unresolved role; no expense role is inferred
from a negative amount alone. A negative card operation with explicit MCC and no
transfer/fee evidence may be treated as a purchase. Bare text with neither payment
semantics nor MCC remains unresolved, even if a human recognizes a business name.

Migration 0029 expands only the ingestion evidence check; no source money, tenant
policy or ownership changes. Existing observations stay immutable. The API's two
import endpoints accept at most 8 MiB (closed max 1000 rows including bounded text);
authentication remains at 8 KiB. The updater applies 0029 under its existing
staging-only backup/transaction workflow when absent. Rollback leaves this additive
constraint compatible with the previous runtime.

## Reimport and provenance

Re-reading the exact same file uses the same per-user file HMAC and row ordinal,
so enriching a legacy operation appends a source observation without changing the
canonical ID, amount, manual merchant, category, comment or corrections. The raw
normalized description HMAC is unchanged by the new display profile. Across
unrelated files the existing strict identity rules still apply: date-only or
otherwise ambiguous rows are not automatically merged merely for equal labels.

Legacy imports do not erase a richer description of the same event; missing
merchant/MCC/category evidence does not erase earlier evidence. Removing an import
rebuilds from remaining observations, including text/MCC, instead of retaining
materialized evidence from the removed file. Historical descriptions discarded by
/1–/3 cannot be reconstructed without re-reading the source file on the device.

## Display and classification

Connected operations show `Из банка:` below the effective merchant on both desktop
and mobile; the operation drawer shows the description without opening a hidden
section. User edits stay separate from source description. Description already
participates in server-side search.

`cashneuro-category-classification/3` admits independently validated /4 descriptions,
merchant, bank category and MCC beyond the fixed legacy brand list. Legacy sources
still use finite brands. Requests omit source money/dates, accounts, IDs/HMACs,
comments, recipients and raw files. The classifier can only choose visible tenant
categories, cannot rewrite bank facts, and still preserves user/rule assignments.
Evidence and protocol are part of cache identity, so different services at one
merchant do not share one decision merely because the brand matches.

The standalone check now has 15 diverse purchases in one model request and the
separate absent-taxi-category case in another: **maximum two POSTs**. Cases include
unfamiliar pharmacy/cafe/bakery/transport/fuel/fitness/cinema/repair names plus
marketplaces and an unknown shop that should stay unresolved. Some examples have
only merchant wording, without MCC or bank-category hints. No real user data is
part of this fixture. A passing fixture establishes only this bounded behavior,
not real-statement coverage or calibrated model confidence.

## Release

Do not reuse the old GD403D receipt archive for this runtime: the complete runtime
hash, protocol and fixed synthetic inputs changed. Run `scripts/run-classification-check.sh`
with the published commit first. On two passes, its new archive and the candidate
runtime hash may be supplied to the existing evidence-based staging installer;
prior paid calls, spend, held reservations and stricter stage ceilings are retained.
No automatic paid retries, no Production switch. Then re-read the same statement
through the new browser import and check readable descriptions, stable operation
count and preserved manual edits before starting category assignment.

### Output bound correction

The first 15-item model run ended with `finish_reason=length` at 1200 tokens;
its incomplete JSON is rejected and its reported usage stays settled in the
ledger. It is not evidence of category accuracy. Classification requests now
explicitly select a 4096-token output bound and compact JSON; chat keeps 1200.
The same immutable bound drives both durable cost reservation and HTTP output
limit. An assistant-mode model cannot send a classification protocol request
under the smaller reservation. The standalone remains limited to two POSTs;
there is no automatic retry or alteration of original stage ceilings.

### Reviewed classifications and resuming a settled answer

The complete 15-item response matched all expected category/null decisions: nine
high-confidence assignments, three 80% review assignments (pharmacy, cafe, cinema
without MCC/bank-category hints), and three unresolved shops/marketplaces. A
blanket >=90 smoke assertion incorrectly rejected correct medium-confidence
behavior. These three cases now explicitly allow >=70, while the application
threshold for automatic confirmation stays 90 and the other fixture cases retain
90. Incorrect categories and confidence below 70 still fail.

`run-classification-check.sh <repo> <sha> --resume-archive <directory>` independently
revalidates the fixed first input, closed answer, usage and complete settled paid
receipt before reuse. It appends only the missing taxi case, with at most one new
POST. Existing input/answer/usage/failure files cannot be overwritten; the old FAIL
remains historical evidence. Full installer admission still requires both cases.

### Unsupported platform assignment guard

The taxi case returned «Автомобиль» at 95% from the broad merchant «Яндекс Go»
without any service evidence. This is a genuine model semantic error, not a test
threshold problem. A server evidence policy now converts proposed categories for
broad platforms (Yandex Go/Market, Ozon, Wildberries) to null/0 when there is no
specific source MCC, non-generic bank category or explicit service/product clue.
Such operations stay in Review; user/rule/verified decisions remain protected.
This bounded policy does not prove all evidence-rich model decisions correct.

The policy has its own cache identity; legacy unsupported unverified AI assignments
can be reconsidered. Ordering of request items stays stable, so saved exact inputs
can be replayed. `--replay-archive` verifies BOTH saved fixed inputs, raw answers,
usage and settled receipts with zero completion POSTs. A passing replay means the
application guard prevented an unsupported assignment; it does not mean the model
answered the taxi case correctly. Its original failed answer remains unchanged.
