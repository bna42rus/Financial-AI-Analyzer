# Категории и контрагенты — третий серверный блок

Основание: основной PDF 13.1–13.4, 15.1–15.7, 34.4, 36.2–36.4/36.7; approved B-04/B-07 и применимые privacy/access правила. Исходные PDF/Word, source manifest и baseline 1.3 неизменны. Ветка основана на `feature/account-structure-deletion` (PR №14). Это Development backend; UI и Production не объявляются завершёнными.

## Общая граница действий

Новые intents используют `/finance/preview` и `/finance/commit`: verified session, активный доступ, own IDs, workspace generation/revision, locks access cycle → finance workspace. Preview исполняется в savepoint без сохранения эффекта. Commit повторно вычисляет impact/dependencies и отклоняет изменившиеся последствия атомарно. Нет публичного маршрута загрузки банковских фактов или aliases.

| Intent | Явное решение | Поведение |
| --- | --- | --- |
| `merge_categories` | canonical `id`, `sourceIds`; при необходимости `targetRole`, `childRoles`, `roleDecisions` | Корневые категории объединяются с переносом children и сохранением их IDs; подкатегории можно объединить между разными roots. Мигрируют operation/component метки и поддержанные assignments правил. |
| `delete_category` | `id`, `replacementId` или `null` | Операции сохраняются. Replacement того же уровня получает зависимости; удаление root без replacement удаляет дерево настроек и очищает обе метки, удаление leaf оставляет root. Правила с утраченными зависимостями отключаются со статусом `needs_setup`. |
| `migrate_category` | `id`, `parentId`, `role`, необходимые `childRoles` и `roleDecisions` | Меняет занятую категорию без обхода dependency check; сохраняет ID, поддерживает перенос/повышение leaf. Запрещает циклы, третий уровень и несовместимую роль children. |
| `merge_counterparties` | canonical `id`, `sourceIds` | Переносит matching aliases, source bindings, метки операций и CP условия/assignments правил. Настройки canonical явно показаны в preview, redirects donors остаются scoped внутри пользователя и выравниваются при повторном Merge. |
| `split_counterparty` | Полные `observations`, `aliases`, `operations` с `{id,counterpartyId}`; `newParties` с именем/state/isSelf | Требует распределения всех старых instances и aliases. Observations одного alias нельзя отправить разным людям. Operation может явно сохранить независимую метку к другому активному own party или `null`. Неоднозначные правила отключаются и требуют настройки. |
| `delete_counterparty` | `id` | Убирает card/registration/settings, merged donors, CP source bindings и matching aliases; очищает CP метки и зависимые условия/assignments правил. Финансовые operations, source facts, components и links сохраняются. |
| `delete_financial` с `scope.kind='counterparty'` | `counterpartyId`, обязательный boolean `deleteCard` | Отдельное необратимое удаление связанных финансовых operations, включая связи по старым source instances. Card/settings/aliases сохраняются при `false` и удаляются при `true`. Surviving операции вне scope, в том числе refunds, остаются. |

Простые Rename/Hide сохраняют category IDs. Обычный edit занятой category роли/parent отклоняется с `DEPENDENCY_MIGRATION_REQUIRED`, в том числе при ссылках только из правил или inactive components. Структурная миграция обрабатывает все component references, включая inactive, не только активную проекцию. Суммы, даты, operation/source IDs и банковские факты не переписываются.

`roleDecisions` содержит `{kind:'operation'|'component',id,role}` и применим только к затронутым зависимостям. Несовместимая категория отклоняется с `CATEGORY_ROLE_DECISION_REQUIRED`; сервер не делает расход доходом молча. Явная role decision становится user-verified и пересчитывается общим финансовым ядром. Merge меток сохраняет provenance/confidence/userVerified. Сужение категории с неоднозначной ролью правила также требует перенастройки правила. Mark as Self остаётся сохранённым сигналом для будущего Import/classification и не создаёт confirmed links или новую финансовую роль существующих операций автоматически.

## Source assignments и privacy

Migration 0008 добавляет `counterparty.merged_into_id`, `counterparty_alias` и `observation_counterparty`. Alias identity/type/HMAC и binding observation/alias identity неизменны; только назначение собственной карточке переносится Merge/Split. Composite FK, FORCE RLS и запрет доступа control/mail применяются ко всем новым таблицам. FK binding→alias отложен до завершения транзакции для атомарного перемещения пары. Исходная `source_observation` не меняется.

Внутренние `acceptCounterpartyAlias`/`acceptCounterpartyObservation` проверяют доступ, generation, собственные observation/alias/party, допустимый type и 64-hex HMAC, повторное использование и scoped redirects. HMAC generation/key custody, автоматическое discovery и полный import pipeline остаются будущим блоком. Source binding не заменяет независимую user-verified CP метку; старый observation не перезаписывает current operation. Future pipeline должен завершать классификацию с CP context отдельно; эти primitives не заявлены как полный parser или reclassification engine.

`/finance/state` показывает active/merged cards и безопасные alias IDs/types/assignments, observation IDs/assignments. Хэши, raw номера карт/телефонов и другие устойчивые identifiers в ответы не попадают. Имена проходят общий sanitizer. Регистрация не удаляется при удалении только финансовых данных; Import cancellation пока не реализован и обязан соблюдать эту границу в следующем блоке.

## Undo и глубокое удаление

Category/CP configuration actions допускают консервативный Undo в течение 30 дней при отсутствии более поздних изменений workspace. Восстанавливаются исходные IDs, hierarchy, facets/review reasons, redirects, rules и source/alias assignments; удаляются только карточки, созданные данным Split. Это не выборочный rollback поверх независимых последующих edits.

Deep delete повторно использует deletion service предыдущего блока: preview показывает состав/связи/суммы/Review, whole-workspace History cleanup и reimport warning. Удаляются все текущие финансовые action previews/results/Undo patches пользователя; новая generation блокирует старые prepared payloads. Receipt содержит только технические counts и generation/revision, без scope IDs, названий, HMAC, сумм или deltas. Undo физически удалённых данных запрещён. Purchase deletion не удаляет surviving refund; потеря подтверждённой link зависимости пересчитывается как unresolved/Review, сохраняя независимые ручные решения.

## Проверки и эксплуатация

23 новых PostgreSQL18/HTTP сценария покрывают категории/hierarchy/rules/active+inactive components, явные role conflicts, Merge/Split/Undo CP, source instances/aliases, независимые user labels, card vs deep delete, surviving refunds, очистку History, generation/retries, RLS/FK/immutable identities/control-mail boundaries, stale entitlement/revision и независимые concurrent clients. Прежние core, API, HTTP/browser и desktop/mobile suites сохраняются; результаты для точного head публикуются в PR.

После migrations 0001–0007 Development operator запускает `pnpm --filter @finance/api operator migrate-entity-structure` с `APP_ENV=development` и loopback `MIGRATION_DATABASE_URL`. SQL выполняется целиком в транзакции. Forward migration обязательна до запуска нового API; rollback — восстановление предыдущего Development snapshot/версии с исходными миграциями, не DROP текущих финансовых данных. Production migration/restore acceptance не выполнен.

Границы: нет новых серверов/покупок/реальных банковских данных; 10 000 transactions на snapshot и 1 000 на deep delete. UI connection, budgets/widgets/saved views dependency providers, full reset/HMAC rotation, transaction duplicate Merge, Import cancellation/dedupe, Analyzer/blob/worker/backup cascade, полный selection Undo и scheduled cleanup впереди. Registry остаётся partial: эти проверки подтверждают только существующую серверную модель, не будущие зависимости и не завершение всего этапа 4.

Следующий [блок исключений и выборочной истории](exclusions-history.md) добавляет journal/object-version Undo для новых действий. Описанный выше консервативный Undo остаётся fallback только для legacy actions без after snapshot; исходные ограничения финансовой/структурной модели сохраняются.

Последующий [шестой серверный блок](derived-allocations.md) добавляет links на автоматически выведенные allocation portions, итеративный пересчёт вложенных цепочек, зависимый Undo и transitive link deletion. Упоминание этих nested endpoints как будущей работы выше описывает историческую границу соответствующего блока; UI, actual Import и будущие module cascades по-прежнему не завершены.
