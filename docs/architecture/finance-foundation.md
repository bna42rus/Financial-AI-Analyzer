# Финансовая основа — первый серверный блок

Основание: PDF 5–17, 21.1/21.7, 24.3/24.4, 32, 34–36, 49.4, 51–52 и 55; A-03–A-06/A-08 и B-01–B-09 в применимой части. PDF/Word и baseline 1.3 не изменены. Ветка `feature/finance-foundation` основана на `feature/mail-notifications`; main и реальные сервисы не меняются.

## Что реализовано

- Migration 0006: workspace с generation/revision, accounts, editable starter categories из PDF14, counterparties, rules, canonical transactions, append-only sanitized source observations, components, links и actions/history. Все связи включают user_id; FORCE RLS, запрет control/mail, immutable IDs. Runtime role не владеет объектами. Original foreign amount/currency допустимы как отдельный source факт; расчёты используют фактическую RUB-сумму.
- Source и corrections разделены. Новый observation не создаёт новый transaction ID при явно переданном canonical ID и сохраняет ручные исправления/verification. Bank date-only остаётся date-only, без выдуманного времени. Настоящие instants фильтруются по московской дате. Исходный технический kind сохранён отдельно. Связи, которые после изменения суммы не помещаются в capacity, сохраняют решение confirmed, но становятся неактивными в текущих расчётах.
- Pure finance-core: signed integer minor math, одна общая агрегация gross/reductions/net/income/difference, категория не определена, neutral/unresolved/excluded и parent attention IDs. Любая активная decomposition заменяет полную сумму; неизвестный остаток сохраняется unresolved. Difference — разница потоков, не банковский баланс. Negative net сохраняется; presentation/clamping budgets не входит в этот блок.
- Confirmed refund/reimbursement allocations наследуют role/category исходного расхода и уменьшают расход в собственную дату. Partial refund делится между категориями с unresolved остатком. Manual verified category имеет приоритет и не наследует несовместимую автоматическую subcategory. Own-transfer/debt linked части neutral; остаток не объявляется комиссией. Credit repayment нейтрален и имеет отдельную capacity от purchase refund. Expense/income/neutral reversals наследуют смысл доступного исходного узла.
- Candidate/rejected/invalid links не меняют расчёты. Проверяются оба endpoint, signed direction, явный component endpoint у split operation, shared refund/reimbursement/reversal target capacity и отдельная repayment capacity. Все участники oversubscribed pool получают conflict; порядок не выбирает победителя. Link не перезаписывает противоречащее user-verified role. Изменение source/correction пересчитывает граф, без обрезания allocations.
- Ordinary loan Cashflow/Economic: account override выше global default. Автоматические principal/interest/fee/insurance components пересчитываются по выбранной модели, независимые manual role decisions сохраняются. Без достоверной decomposition Economic показывает unresolved/completeness warning. Неполное покрытие credit card не превращает repayment в расход.
- Future personal rules с AND conditions и per-facet decisions. More specific scope выше широкого, priority разрешает порядок внутри одинаковой специфичности; неоднозначные ties требуют review. Verified facets и надёжный bank technical kind защищены. Смена rule не переписывает историю. Recurring detection, global/AI classifiers и broad historical application ещё не подключены.

## Серверный контракт

Только finance deployment profile загружает модуль и получает доступ к данным. Verified DB session → canonical entitlement/status → shared access-cycle lock → per-user workspace lock. Generation и revision повторно проверяются при commit. Изменения и ingest используют тот же lock order; DB composite FK дополняют application ownership checks. Денежные значения в HTTP — integer strings.

| Маршрут | Назначение |
| --- | --- |
| GET /finance/state | Собственный snapshot с generation/revision, справочниками, рабочими проекциями, conflicts и totals |
| POST /finance/summary | Строгие from/through/accountIds/categoryIds/includeExcluded filters, те же расчёты |
| POST /finance/operation | Собственная карточка с source, corrections и facets; HMAC bank reference не возвращается |
| POST /finance/preview | Closed intent + actionId/generation/revision; dry-run в savepoint, точные последствия без изменения данных |
| POST /finance/commit | Commit сохранённого preview после повторной проверки; retry возвращает прежний outcome |
| POST /finance/edit | Одно обратимое semantic/comment/inclusion edit операции без дополнительного confirmation; corrections требуют preview |
| GET /finance/history | До 100 последних actions за 30 дней; Undo через отдельный version-bound intent |

Intents первого блока: operation, account, components, link, category, counterparty, rule, analytics и undo. Второй блок добавляет [account Merge/Split и selective deletion](account-structure-deletion.md). Structural category migration/merge/delete не подменяются обычным rename; изменение занятого role/parent требует будущего migration action. Undo консервативен: допускается только без последующей workspace revision, в пределах 30 дней; иначе conflict. Это не полный массовый rollback/30-day History UI.

`acceptAccount`/`acceptObservation` — внутренние primitives для будущего Import, **без публичного bank-fact upload route**. Они проверяют entitlement/generation/required facts/sanitized texts. Observation retry с тем же ID не создаёт второй эффект, другое содержимое с тем же ID отвергается. Они не выполняют dedupe, file matching или HMAC. Реальные выписки не импортируются; тесты используют только искусственные данные.

Shared `packages/privacy/src/text.ts` удаляет распознаваемые номера локально и отклоняет их на server boundary. Это дополнительный text guard, а не полное доказательство privacy банковского parser/OCR/free-text pipeline. UI подключение локальной очистки, HMAC aliases, consent и outbound AI/web validation предстоят.

## Проверки и эксплуатация

`pnpm run check` проверяет исходные hashes, pure money/access/graph/rule/date/privacy cases, projection tests, строгие типы и сборки. `pnpm run test:security` добавляет настоящие PostgreSQL18/HTTP integration: non-owner roles, cross-user denial/FK, canonical access, source/correction isolation, preview/commit/idempotency/concurrency, graph conflicts, categories, future rules и Undo. Существующие registration/renewal/browser/UI suites продолжают запускаться. Exact-head GitHub evidence записывается в PR.

Development operator после 0001–0005: `APP_ENV=development` и loopback MIGRATION_DATABASE_URL, затем `pnpm --filter @finance/api operator migrate-finance`. Все команды оператора выполняются в транзакции; runtime credentials не owner. Для ещё не выпущенного Development откат — восстановить предыдущую disposable DB/сборку. Production forward-fix/PITR/migration acceptance разрабатываются отдельно; таблицы с настоящими данными не удаляются ради отката.

## Что ещё предстоит

Это **первый блок этапа 4**, а не завершение всей финансовой модели. [Второй серверный блок](account-structure-deletion.md) реализует account Merge/Split, matching bindings/alias index и выборочное удаление текущих financial copies. Впереди: остальные entity migrations, selection Undo, broad exclusions, local HMAC/key custody, imports/dedupe/cancellation/provenance по файлам, links на автоматически выведенные/вложенные components, общий Analyzer Registry, budgets/calculators, UI binding, scheduled history cleanup, future-module deletion cascade, нагрузка и пагинация. Сейчас snapshot/reconciliation целиком загружает собственный граф до 10 000 transactions и явно отказывает при превышении; это Development boundary. Retention backups/legal, real mobile Safari, hosting и Staging acceptance ещё не доказаны. Все затронутые пункты registry остаются partial.

Следующий [блок исключений и выборочной истории](exclusions-history.md) добавляет journal/object-version Undo для новых действий. Описанный выше консервативный Undo остаётся fallback только для legacy actions без after snapshot; исходные ограничения финансовой/структурной модели сохраняются.

Последующий [пятый серверный блок](financial-reset.md) реализует Development full financial reset, protected key custody/rotation и обязательные generation/key-version acceptance checks. Actual Import/local privacy pipeline, будущие cascades, recovery deletion journal/KMS и рабочий UI по-прежнему впереди.

Последующий [шестой серверный блок](derived-allocations.md) добавляет links на автоматически выведенные allocation portions, итеративный пересчёт вложенных цепочек, зависимый Undo и transitive link deletion. Упоминание этих nested endpoints как будущей работы выше описывает историческую границу соответствующего блока; UI, actual Import и будущие module cascades по-прежнему не завершены.
