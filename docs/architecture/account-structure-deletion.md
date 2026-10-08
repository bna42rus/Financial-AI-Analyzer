# Счета и выборочное физическое удаление — второй серверный блок

Основание: PDF 6.1, 11.1–11.7, 34.4, 36.2–36.4/36.7, 52.5 и approved B-03/B-04/B-07; A-05/A-06/A-10 в применимой части. Полный PDF и Word прочитаны в ранее согласованной базе; исходные документы и baseline 1.3 неизменны. Ветка основана на `feature/finance-foundation` (PR №13), main не изменён.

## Модель данных

Migration 0007 добавляет отдельные `observation_account` bindings, `account_alias` matching index, redirects ошибочно созданных счетов и `rule.dependency_status`. Исходные `source_observation.account_id`, суммы, даты, описания и instance IDs не переписываются. Активный account определяется отдельно: source binding → independent correction. Общий `effective()` используется для расчётов, правил и выборки удаления. Binding backfill выполняется владельцем миграций атомарно, FORCE RLS источников восстанавливается до завершения транзакции.

HMAC alias содержит только pseudonym; namespace/hash/key generation выполняет будущий Import pipeline. Внутренний `acceptAccountAlias` проверяет пользователя, entitlement, generation, допустимый type/hash и повторное использование. API не принимает raw bank identifiers и не имеет публичного alias/source upload. В `/finance/state` возвращаются лишь alias IDs/types/assignments и observation IDs/assignments. HMAC не возвращается. Composite FK, FORCE RLS и неизменность identity действуют для новых таблиц; control/mail доступа не получают.

## Действия

Все три действия используют существующие `/finance/preview` и `/finance/commit`. Сервер проверяет verified session, доступ, generation/revision и собственные зависимости. Preview выполняется в savepoint и не меняет данные. Перед commit impact и зависимости вычисляются заново, сравниваются с preview; изменившиеся данные или финансовая история дают conflict. Общий порядок locks сохраняется: access cycle → finance workspace. Клиентские IDs не дают полномочий.

| Intent | Явный выбор | Результат |
| --- | --- | --- |
| `merge_accounts` | `id` выбранного canonical account и `sourceIds` активных donors | Bindings/aliases и corrections со счётом donor переходят к canonical; scoped rules перенастраиваются однозначно. Настройки canonical показываются в preview. Redirects старых IDs остаются внутри пользователя, повторное объединение выравнивает группу. |
| `split_account` | `id`, `newAccounts` с именем/типом/analytics/default visibility/loan mode; полный список `observations`, `operations`, `aliases` с `{id,accountId}` | Сервер не угадывает распределение. Требуются все source observations, включая старые instances, все aliases и связанные operations. Для operation можно сохранить независимую correction к другому собственному активному account. Неоднозначные scoped rules отключаются со статусом `needs_setup`. |
| `delete_financial` | Scope `operations` с `operationIds`; `period` с `from/through` и необязательными `accountIds`; либо `account` с `accountId` и явным `deleteAccount` | Физически удаляются выбранные operations, observations, components и links. В account scope учитываются как effective операции, так и операции с source bindings этого счёта. Данные других split destinations не включаются автоматически. |

Каждый новый Split account получает тот же банк и исходное system name; пользователь явно задаёт его рабочие настройки. Перенос source assignment не заменяет оригинальный bank fact. Rule edit с валидными новыми привязками снимает `needs_setup`; правила не расширяются автоматически на обе половины. Исторические classifications не переписываются изменением правила.

Merge/Split можно отменить в 30-дневном окне, пока workspace revision не изменилась после действия. Undo возвращает bindings/aliases/corrections/rules/redirects и удаляет только созданные данным Split счета. Это консервативный Undo, не полный selection rollback с независимыми последующими edits.

## Удаление и зависимые копии

Preview показывает точные IDs/count выбранных operations, source observations, всех components (в том числе inactive), links, удаляемых account records/aliases и финансовой истории, меняющиеся totals, surviving related operations и Review. Есть reimport warning и явный признак `undoable:false`. Period использует effective дату и московский календарь, сохраняя date-only precision исходного факта. Пустой выбранный account можно удалить отдельно.

Если purchase удаляется отдельно, surviving refund не удаляется вместе с ней. Derived смысл, зависевший от удалённого link, становится unresolved/Review, а самостоятельно подтверждённые role/category/components сохраняются. Refund не становится income автоматически. Пересчёт использует общее ядро и не хранит копию удалённой покупки.

Account card физически удаляется вместе с merged donors только при отсутствии surviving source observations, которым нужны их immutable original IDs. Например, после Split исходная карточка ещё может быть оригинальным источником операции другой половины: `SOURCE_ACCOUNT_STILL_REFERENCED` блокирует удаление этой карточки, вместо удаления чужой по scope операции. Можно удалить назначенные финансовые данные отдельно или сначала разрешить зависимость. Это явная dependency boundary текущей модели.

`finance.action` preview/results/Undo patches содержат whole-workspace totals, поэтому выборочное удаление консервативно очищает **всю финансовую историю и pending previews пользователя**. Этот эффект явно включён в preview. Нельзя оставить aggregate copy только потому, что action был создан для другой операции. Коммит текущего delete сохраняет только техническую receipt: action ID, generation/revision, время, counts и признак необратимости. Нет operation IDs, scope dates, названий, комментариев, сумм или financial deltas. Ранее завершённые metadata-only delete receipts не очищаются новым выборочным удалением. Повтор commit возвращает receipt без повторного эффекта.

Всё удаление текущего поддержанного scope атомарно. Новая financial generation блокирует старые prepared payloads и previews, включая внутренние source/alias acceptance hooks. Это data epoch: выборочное удаление не заявляется как full financial reset или HMAC rotation. Future Import должен иметь отдельную HMAC key version и не повторять старый payload автоматически. Уже исполняющийся acceptance либо завершится до delete lock и войдёт в проверенный scope, либо устареет; удалённые transaction IDs не восстанавливаются Undo.

## Проверки и границы

Pure tests проверяют assignment/correction priority, analytics inclusion и future rule scope. Настоящие PostgreSQL18/HTTP tests проверяют merge chains/Undo, обязательное полное распределение старых observations, independent correction, rules/aliases, сохранение банковских фактов, оба варианта surviving refund, effective/Moscow period, account cleanup, privacy очистку History, generation fences, повторные receipts, cross-user denial/FK/RLS, изменившуюся историю перед commit, два независимых DB clients и backfill с существующими observations. Полные types/build/source hash и прежние browser/UI suites запускаются в GitHub; exact-head evidence фиксируется в PR.

Development operator: после migrations 0001–0006 `APP_ENV=development` и loopback `MIGRATION_DATABASE_URL`, затем `pnpm --filter @finance/api operator migrate-account-structure`. Команда оборачивает весь SQL в транзакцию. Отдельные operator/DB acceptance и восстановление Production ещё предстоят.

UI этих действий пока не подключён. Реальных банковских данных и новых сервисов нет. Границы Development: snapshot до 10 000 transactions, один delete до 1 000 operations (при превышении явный отказ до удаления); крупные scopes требуют будущего deletion journal/chunks/progress. Полный financial reset/key rotation, user-account deletion/sessions, Import cancellation/dedupe/transaction merge, budgets/views/widgets, Analyzer result/document/blob/worker cascade и backups retention ещё не реализованы. Таких финансовых copies/queues пока нет в этой модели, но будущие модули обязаны подключать собственные dependencies к deletion service. Ни SQL CASCADE, ни данные проверки не доказывают их будущую очистку. Все затронутые пункты registry остаются partial; весь этап 4 и Production не завершены.

Category/Counterparty migrations и отдельный counterparty scope реализуются следующим Development блоком: [категории и контрагенты](category-counterparty-structure.md); исходные ограничения этой account migration сохраняются.

Следующий [блок исключений и выборочной истории](exclusions-history.md) добавляет journal/object-version Undo для новых действий. Описанный выше консервативный Undo остаётся fallback только для legacy actions без after snapshot; исходные ограничения финансовой/структурной модели сохраняются.

Последующий [пятый серверный блок](financial-reset.md) реализует Development full financial reset, protected key custody/rotation и обязательные generation/key-version acceptance checks. Actual Import/local privacy pipeline, будущие cascades, recovery deletion journal/KMS и рабочий UI по-прежнему впереди.
