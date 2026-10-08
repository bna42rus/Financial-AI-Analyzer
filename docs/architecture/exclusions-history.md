# Исключения и выборочная история — четвёртый серверный блок

Основание: основной PDF 34.1–34.6, 36.1, 36.3–36.4; approved A-03/A-06/B-04/B-07 и действующие privacy/access требования. PDF/Word, source manifest и baseline 1.3 неизменны. Ветка основана на `feature/category-counterparty-structure` (PR №15). Это Development backend; подключение рабочих экранов и Production acceptance ещё впереди.

## Исключения

`set_exclusion` работает через `/finance/preview` и `/finance/commit`. Scope либо `{kind:'operations',operationIds}`, либо `{kind:'filter',filter}`. Filter принимает `from/through` банковского периода, `accountIds`, `categoryIds` (включая leaf), `counterpartyIds`. Пустой фильтр/пустой результат запрещён. Счёт и даты — effective, категории — current projected parts, CP — effective semantic label. Если часть refund подходит категории, выбирается вся банковская operation, а не создаётся фиктивная transaction. Date-only precision сохраняется; instant периоды используют московский календарь общих расчётов.

| Поле | Явное решение | Эффект |
| --- | --- | --- |
| `value:'exclude'` | Не учитывать выбранные операции | Сохраняются source facts, operations, components и links; обычные totals пропускают выбранные operations. |
| `value:'include'` | Учитывать выбранные операции | Specific override имеет приоритет над отключённой аналитикой account. |
| `value:'default'` | Вернуться к политике account | Убирается specific override; итог зависит от account.analyticsEnabled. |
| `includeRelated:false` | Только выбранные/отфильтрованные записи | Связанные operations не исключаются автоматически. Preview предупреждает, если excluded purchase/target остаётся связан с included refund/reimbursement/reversal. |
| `includeRelated:true` | Включить связанную цепочку в scope действия | Scope расширяется явно по confirmed relationships; candidate/rejected links не расширяют выборку. Preview показывает initial, related и final operation IDs. |

Ни один вариант не физический delete. Preview показывает точные IDs, смену override, предупреждения и текущие/будущие totals общим ядром. Все выбранные изменения сгруппированы одним `action_id`. Scope ограничен 1 000 operations, включая расширенную цепочку; превышение даёт отказ до записи. Explicit `/finance/summary` с `includeExcluded:true` использует те же сохранённые данные; статус included/excluded виден по parts и excludedMinor. Outbound Analyzer, его disclosure и UI теги подключаются отдельно.

## Delta и версии

Migration 0009 добавляет private `finance.action.change_set`, индекс затронутых operation IDs, revisions для components/source bindings/aliases и отдельную config revision для loan mode. DB triggers увеличивают версии при UPDATE; их нельзя понизить обычным runtime UPDATE. FORCE RLS/ownership исходных таблиц, immutable identities и scoped FK сохраняются. Control/mail не получают финансового доступа. Migration не переписывает банковские наблюдения или их суммы/даты.

Каждый поддержанный user action после этой миграции получает delta `before → after` для реально изменённых объектов: operations, account/category/CP/rule settings, links/components, matching assignments/aliases и analytics config. Нужные private alias HMAC остаются только в scoped rollback данных; public preview/history/commit показывают безопасную delta без hashes. Bank facts не клонируются в journal. Immutable source observation IDs в operation snapshot служат проверкой контекста и не являются восстанавливаемым банковским source.

Preview вычисляет tentative journal в savepoint и сохраняет его вместе с action. Перед commit сервер повторно сравнивает и impact, и journal/object versions, даже для одиночного edit. Изменения вне workspace revision не могут незаметно пройти commit. Entitlement, generation/revision и общий lock order access cycle → finance workspace проверяются сервером. Reads/navigation/filters не создают action history.

## Просмотр истории

| Endpoint | Назначение |
| --- | --- |
| GET `/finance/history` | Последние 100 committed actions за 30 дней, совместимый с прежним списком endpoint. |
| POST `/finance/history-query` | Фильтры `from/through` времени изменений (canonical UTC instant), `operationIds`, `kinds`, `beforeRevision`, `limit` 1–100. Это время изменения, не банковская дата операции. |
| POST `/finance/preview` с `restore_history` | Явные `actionIds` выбранных строк истории; список объектов, порядок восстановления, последствия и конфликты. |
| POST `/finance/commit` | Атомарное применение сохранённого просмотра при отсутствии конфликтов и изменений версий. |

Доступность в списке истории предварительная: object/version checks выполнены, `requiresPreview:true` и `dependenciesChecked:false` сообщают, что полная FK/dependency проверка ещё обязательна в preview. History response содержит revision cursor `nextBeforeRevision`, action ID/time/intent, operation IDs, public changes, `undone`, `undoable`, `rollbackStatus` и конфликты. История операции включает также components, link endpoints и затронутые derived projections. Период/вид действия/operation filter выбирает строки; восстановление всегда принимает конкретные IDs выбранных actions. Массовый action остаётся одним целым: просмотр перечисляет все его объекты, даже если action найден через одну operation. Нельзя молча отменить только часть grouped action.

## Выборочная отмена

`restore_history` принимает до 100 own committed action IDs. План строится в порядке committed revision от нового к старому и виртуально проверяет последовательные состояния одного объекта. Возвращается самое раннее выбранное before, без промежуточной записи и двойного эффекта. Не выбранная более поздняя правка того же объекта, ABA edit, отсутствующий объект, changed source context, already rolled back action, истёкшие 30 дней или generation дают видимый conflict. Изменение другой записи не блокирует отмену.

Server trial replay отдельно проверяет FK и актуальные dependencies, включая новые children, rules, source/alias assignments и link calculations. Новые immutable observations, ссылающиеся на созданный Split account, блокируют удаление этой карточки при rollback. Не создаётся старый transaction/source для удовлетворения ссылки. Confirmed link, ставший невозможным из-за более позднего контекста, также не восстанавливается молча. Конфликты оставляют всю выборку без изменений; commit возвращает `ROLLBACK_CONFLICT`. Клиент должен пересмотреть выборку и получить новый просмотр, а не передать overwrite flag.

Одиночный `undo` новой journal action использует те же object conflicts. Он сохраняет прежний `UNDO_CONFLICT` для несовместимой отмены. У unrelated workspace edit больше нет искусственной блокировки Undo, но сам preview/commit всегда привязан к актуальной workspace revision. После успеха original actions помечаются undone; повторный commit возвращает прежний outcome. Action восстановления записывается как аудит, но не является новой бесконечной Undo/Redo цепочкой.

Actions до migration 0009 не имеют достоверного after snapshot для произвольного replay: response явно показывает `legacy`; выборочный restore возвращает `LEGACY_HISTORY`. Их прежний консервативный Undo допускается только без последующих workspace revisions. Нельзя задним числом выдумать отсутствующий delta. Истёкшие actions не отображаются в доступной истории и не восстанавливаются.

## Удаление и границы

Physical delete остаётся отдельным необратимым действием. Его current receipt очищает `change_set` и affected-operation index; предыдущие financial action journals/previews/results пользователя удаляются существующим deletion service. Generation блокирует старые restoration previews/prepared source payloads. Receipts не содержат удалённых IDs, сумм, текстов, HMAC или financial deltas. Cancel Import/full reset и future-module cascades ещё впереди; обычный restore их не реализует.

25 новых PostgreSQL18/HTTP сценариев проверяют scoped/chain exclusion, account override, effective/Moscow/category/CP filters, journal grouping, single and selected rollback, unrelated edits/ABA/conflicts, dependencies/components/links, source changes, CP matching Undo, hash privacy, physical journal cleanup, 30-day/legacy boundaries, history pagination/filter/no-write, ownership/entitlement/concurrency/retries и изменение объекта без workspace revision. Полные предыдущие tests, hashes, types/builds и браузерные suites выполняются в GitHub; exact-head evidence публикуется в PR.

Development operator после migrations 0001–0008: `APP_ENV=development` + loopback `MIGRATION_DATABASE_URL`, `pnpm --filter @finance/api operator migrate-exclusions-history`. SQL атомарен. Forward migration нужна до нового API. Для невыпущенного Development rollback — прежняя сборка/disposable snapshot; таблицы настоящих данных не удаляются ради отката. Production migration/restore acceptance не выполнен.

Development bounds: snapshot до 10 000 transactions, history scan до 10 000 committed actions, rollback до 5 000 объектов/100 actions, exclusion до 1 000 операций. При превышении явный отказ до изменения; крупные scopes/pagination/journal scaling предстоят. Cleanup 30-дневных записей выполняется при writes; отдельный scheduled retention worker ещё не реализован. Automatic Import/AI changes grouping, UI timezone conversion/history screens, budgets/views/widgets providers, nested derived endpoints, Analyzer Registry, full reset/HMAC custody/rotation, blob/queue/backup retention и нагрузочные испытания остаются впереди. Registry partial; весь этап 4 и Production не объявляются завершёнными.
