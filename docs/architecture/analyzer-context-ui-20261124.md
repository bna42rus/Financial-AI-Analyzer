# Analyzer context and calculator presentation — 2026-11-24

Owner-approved scope: keep original answer buttons, remove the intermediate prepared-state text/button, preserve task context through concept questions and short replies, compare prior calculations and periods, show loan payment composition, hide internal handles/versions, and remove irrelevant zero prepayment savings.

## Context contract

The bounded model history includes short public explanations and clarification questions, resolved task periods, the last eight successful tasks, and the active calculator/report even when older than the recent dialogue window. A concept answer does not replace a calculator snapshot or clear its pending clarification. A successful calculation clears its pending request.

Calculator continuations carry `kind`, `from` (`active` or a server-provided history handle), an explicit `variant` when the source contains several calculations, and only changed fields. The server resolves the source within the authenticated conversation and merges the patch into its validated input. Complete independent inputs remain supported. No cross-chat IDs or model-generated arithmetic are accepted. Report bindings are resolved before final arithmetic validation, preserving existing checked-fact calculations.

Read plans can bind directly to a server-provided successful history handle. `comparisonReference` obtains the other period from a saved task, while the primary query supplies the remaining current selection. Arbitrary different query selections still require separate report reads. Options merge field by field so that changing chart/statistic does not discard unrelated settings. Queries run against current authorized data, never historical totals. Comparison answers show exact group differences and identify the largest increase/decrease across the complete server-side groups, including comparison-only groups and groups outside the chart top-N. These checked differences are also available as report facts for narration. A truncated preview cannot establish a global maximum.

Both planning and completeness review receive the same relevant history and calculator capabilities. Explanation prompts distinguish a definition from a pending numerical task. Internal history handles are removed from public free text. Structural validation, financial relevance, reservations, exact receipts and the existing maximum call count remain active.

## Presentation and actions

- Loan charts use the existing exact monthly rows: principal and interest as separate stacked areas, an optional prepayment area, and a line for total monthly outflow. The table retains exact kopecks.
- Loan reports show a comparison table with first/last payment, total interest, total paid and actual duration. The deterministic conclusion compares interest only and ranks it only for equal principals.
- Ordinary loan answers omit prepayment savings, prepayment columns and event assumptions when those events are absent. Genuine zero savings remain visible in an actual prepayment scenario.
- The pagination button has a separate block and a one-rem top margin. Calculator version strings remain in persisted results but are hidden from both ordinary and scenario details, per the owner's explicit instruction.
- Original answer buttons remain visible after preview cancellation and reopen their own action. Switching actions sends the expected previous preview ID; the server permits replacement only for an owned uncommitted preview of that answer and expires the previous confirmation. Existing authorization, revision and scope checks remain mandatory. Exact retries reuse the replacement action ID.

## Verification

Synthetic offline workflow tests cover pending clarification → explanation → calculation, later short edits, multiple scenarios and exact interest differences, different amounts/rates, deposits, rate changes and prepayments, and two historical month references after regrouping and an explanation. Rendering checks independently verify a two-month example and suppress ranking for unequal principals. HTTP and desktop/mobile browser regressions are included in CI.

No live model calls, account data, keys, Production deployment or automatic release are part of these checks. A real-provider language acceptance run remains distinct from passing synthetic contract tests.
