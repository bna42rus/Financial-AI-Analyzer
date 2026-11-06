# Settings and commerce, November 6

The Settings, Account and Analyzer changes add migrations 0033 (the live review queue) and 0034 (editable tariffs and test AI pack orders). Both are additive. Existing access quotes and confirmed purchase snapshots are not rewritten.

The initial access plans are 399 ₽ / 1 month, 1,049 ₽ / 3 months, and 1,899 ₽ / 6 months. They are saved as hidden drafts. In the admin console, «Тарифы» edits their duration, price and availability. AI packages start at 39 / 69 / 149 / 269 ₽ for 1,000 / 2,000 / 5,000 / 10,000 units.

The AI allowance is 10,000 units per Moscow calendar month. Confirmed package balances carry over. A paid model call consumes the included balance first; only excess draws on packages. Statement classification and the operator's project safety cap are separate. Basic deterministic answers do not spend units.

Test checkout is off unless the finance API on Staging receives `YOOKASSA_TEST_ENABLED=1`, `YOOKASSA_TEST_SHOP_ID`, and `YOOKASSA_TEST_SECRET` through secure server configuration. Do not put keys in the repository or chat. An order fixes its price before the provider is called. CashNeuro rechecks the provider payment ID, test flag, amount, currency and order metadata before crediting. Check payment in the top-up dialog after returning from YooKassa. The access purchase workflow still uses the existing review path. Production checkout, automated access activation, and real fiscal receipts are not enabled by this change.

The website shows the seller's public details. Set `VITE_PUBLIC_SUPPORT_EMAIL=support@cashneuro.ru` at frontend build time only after the mailbox can receive mail. The separate Postbox sender `notifications@cashneuro.ru` remains unchanged; mail now uses the display name CashNeuro and a plain text and HTML body. Recipient-side sender avatars are managed separately by the mail provider.
