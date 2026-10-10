# Операции: страницы и сохранённые представления

Основание: полный `docs/product/master_spec_v1.pdf`, §§21.6, 23.1–23.13, 24, 33.3–33.7, 34, 36.3–36.7, 45.5; approved baseline A/B и source-manifest. Эта реализация дополняет аудит #34; историческая матрица не переписывается и не объявляет все пункты выполненными.

## Контракт

`POST /finance/operations-page`: closed `query { filter, sort, direction, group }`, `limit` 1–100, `cursor` необязателен. Ответ содержит только страницу операций, точный общий count, показатели для всей выборки и cursor. Default page = 50. Общие суммы не вычисляются из одной страницы. IDs всей выборки выдаёт отдельный `POST /finance/operations-selection` с обязательными generation/revision. Hydration заданных IDs ограничен 1000; каждый ID проверяется на существование и ownership. Выбор всех не сокращается до страницы или 1000: предел существующих массовых команд показывается отдельно.

Cursor содержит generation, revision, SHA-256 canonical query и offset. Это не bearer token и не источник authority. Параметры заново валидируются, account определяется сессией/RLS. Смена поколения, версии или фильтра отвергает cursor; произвольный offset не позволяет читать другого пользователя. Нет межпользовательского cache, raw SQL, AI или клиентской авторизации.

Поддерживаемые фильтры: effective operation day, bank/account, terminal category/subcategory/role, signed integer amount bounds, sanitized search/merchant/comment, counterparty, review reason/status/attention, confidence и source выбранного facet, inclusion, refunds/reversals, confirmed active links, matched rule, posted dates, batch/file import, possible duplicate и exact IDs. Search учитывает merchant, safe description, comment, account/category/counterparty names. Временные фильтры не пишутся в History. Bank calendar day не сдвигается с timezone профиля; динамический период определяется timezone профиля.

Операция со смешанными частями попадает в результат при подходящей **одной и той же** terminal portion; суммы включают только подходящие portions. Components заменяют parent. Excluded portions видны, но не входят в обычные расходы/доходы. Связанный возврат наследует смысл по полному графу, даже если покупка на другой странице или вне периода. Сортировка amount использует BigInt, UUID стабилизирует равные ключи. Все шесть sort и семь group modes поддерживаются.

`/finance/summary` с `compact:true` ограничивает операции и вспомогательные ID previews 100 записями, возвращая явные полные `operationCount`/`attentionCount`. Settings/Review продолжают получать полный совместимый контракт. Для preview/commit финансового действия сохраняется полный граф: pagination не меняет impact, безопасность и историю.

## Представления и миграция

`0019_operations_views.sql` создаёт tenant-owned таблицу с FORCE RLS, immutable identity, object revision и deferred unique default. Control/mail роли доступа не получают. Settings позволяет rename, duplicate, delete, default, reorder и показывает last modified. View сохраняет фильтры, dynamic/fixed period, columns/order/width, sort/group/density. Named creation/edit/default/reorder/delete проходит прежний optimistic preview/commit/receipt/Undo механизм и 30-дневную delta History. Повтор commit не создаёт второй объект. Delete view удаляет конфигурацию, а не операции.

Merge account/counterparty/operation rebinding переводит ссылку на canonical ID; category merge переводит donor ID на target. Split, исчезнувшая category/rule/import или physical deletion выставляет `needs_setup`; фильтр не расширяется молча. Restore History проверяет live references. Full wipe удаляет views при сбросе интерфейса; при сохранении интерфейса очищает текстовые финансовые фильтры и удалённые entity scopes, требует настройки заново. Новые views ограничены 100 на пользователя.

Установка Development: после 0001–0018 запустить `APP_ENV=development pnpm --filter @finance/api operator migrate-operations-views` с локальным MIGRATION_DATABASE_URL. Это additive migration: существующие финансовые записи не меняются. При rollback приложения таблицу сохраняют; runtime, использующий новый код, требует 0019. Production acceptance/артефакт/backup/migration-runner остаются отдельным release блоком.

## Интерфейс

Desktop показывает настраиваемые колонки в таблице с внутренней горизонтальной прокруткой; mobile — карточки с теми же колонками и общими фильтрами. Для доступности строки сохраняют list semantics и обычные фокусируемые кнопки. Колонки можно включать, перемещать и задавать ширину; merchant остаётся видимым. Группы не добавляют денежную сумму всей parent operation к частям. Показаны количество загруженных/всего, count selection, Expenses и Income.

Ctrl/Cmd+A выбирает все server-filtered IDs; Shift+click/↑/↓/Space используют anchor среди загруженных строк. Разрозненный выбор сохраняется при загрузке следующей страницы. Bulk editor сначала получает все выбранные строки с сервера, фиксирует epoch и не добавляет новые matching imports в команду. Другой revision требует сравнения/обновления, а не молчаливой перезаписи. Обновление прежнего набора страниц сохраняет глубину загрузки и scroll. Общие фильтры не размонтируют таблицу; итоги другого query скрываются до ответа. После Undo команды ждут актуального revision. Применение named view заменяет прежний контекст загрузки/Обзора; ручная смена общего периода снимает dynamic period.

Inline semantic edits вызывают те же действия, что Operation Card. Date/amount/source corrections остаются в карточке. Из строки или фиксированной массовой выборки можно открыть существующий редактор personal rule с предложенными общими conditions/assignments; сохранение действует на будущие imports, прошлое не переписывается автоматически. Контекстное меню доступно правой кнопкой/Shift+F10 и кнопкой выбранной операции на mobile. Возможны open, semantic fields, verify, similar merchant, history, delete и Copy ID. Review использует фиксированный список; AI Analyzer по-прежнему не подключён.

## Граница готовности

Отказ `FINANCE_SIZE_LIMIT` при >10,000 удалён. Это **серверная pagination над полным reconciliation**, а не SQL pagination/materialized projection. Убраны повторные линейные поиски transactions/components на каждую операцию и повторный credit-card scan. Сложные links требуют общего графа; его предельные память/время, многопользовательская нагрузка и длительность массовых command previews требуют отдельного профилирования. 30 секунд в synthetic CI — защитный test timeout, не Production SLA.

Финансовые bulk edit/delete/Review остаются ограничены 1000 IDs одной команды; Ctrl/Cmd+A выбирает больше и явно блокирует слишком широкую команду. продвинутый drag-resize колонок, стартовый last state/Overview Views, автоматические предложения recurring rules, AI analysis selected snapshot и реальные Safari/Android проверки не объявлены завершёнными. Полное соответствие всем §§23/33 и полный readiness release этим блоком не заявляется.

## Проверки

- Core: полный каталог фильтров, joint mixed portions, exact BigInt sort/totals на 15,001 rows, tie determinism, все sort/group, leap/year/profile timezone, closed parser/privacy rejection.
- PostgreSQL: owned pages/cursors/selection, source/effective/posted boundaries, refund cross-page и components, idempotent named config/default/Undo, dependencies/physical delete, restricted access/control/RLS/origin, 15,005 persistent rows.
- HTTP/Chromium: 10,001 persistent rows в desktop/mobile, 50→100 rows, all-results selection, server search, saved columns/width/density/fixed period/default after reload, repeat-save updates without duplication, rule creation, inline role and Undo, no financial browser storage и page overflow.
- Полный existing CI suite сохраняется. Результаты для точного опубликованного head приводятся в PR после окончания CI, а не копируются из старого #34.
