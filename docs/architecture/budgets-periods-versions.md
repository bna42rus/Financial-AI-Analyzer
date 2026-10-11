# Бюджеты: периоды, фильтры и версии лимитов

Бюджет хранит финансовый фильтр, календарь, net/gross basis, версии лимита и enabled. Он не создаёт кошелёк и не изменяет банковские операции. Основные источники: полный PDF §22–22.9, §5/§8/§9/§24/§29/§36/§37, approved B-03/B-06/B-07, Word §8. Исходные PDF/Word сохранены без изменений; полное соответствие продукту не заявляется.

## Расчёты и календарь

`finance-core/budgets.ts` использует общий `queryOperations` после reconciliation всего графа. Category/role/subcategory/inclusion фильтруют совместно конечные части, поэтому parent и components не складываются. Связанный возврат относится к категории покупки, даже если покупка вне периода/страницы. Default — включённые расходы, net; gross игнорирует уменьшения. Explicit `includeExcluded` одинаково действует в бюджете и итогах Operations; unresolved остаётся диагностической суммой, не выдуманным расходом. Пересекающиеся budgets независимы и не суммируются в основной аналитике.

Week начинается в понедельник; month/quarter/year календарные. Fixed включает обе граничные даты. Custom monthly сохраняет anchor month, число начала и шаг 1–12 месяцев; число 29–31 при отсутствии в месяце прижимается к последнему дню. Custom days сохраняет anchor date и интервал 1–366 дней. Периоды смежные, inclusive end = next start − 1 день; поддерживаются високосные месяцы и смена года. Собственная IANA timezone записывается при создании. Смена timezone профиля не переносит anchor. Даты банковских операций следуют существующему общему банковскому контракту; этот блок не переопределяет даты фактов.

Деньги — decimal integer strings / BigInt. Отрицательный net хранится как есть; использовано = max(0, fact), remaining не превышает limit, excess refunds показывается отдельно. При превышении сохраняется signed remaining и отдельный over amount; процент вычисляется точно с округлением до 0.01%. Нулевой limit допустим: процент неопределён, а превышение вычисляется точно. No rollover.

## Хранение и действия

Additive migration `0020_budgets.sql` после 0001–0019: `finance.budget`, immutable tenant identity, object revision, FORCE RLS. Control/mail роли не имеют доступа. Development operator: `pnpm --filter @finance/api operator migrate-budgets` с отдельными migration credentials. При откате приложения таблица сохраняется; destructive DROP без резервной копии не является rollback plan.

Закрытые действия `save_budget`, `set_budget_limit`, `delete_budget` используют существующие authority/ownership/entitlement checks, optimistic generation/revision, preview/commit, idempotent receipts, delta History и dependency-aware Undo (30 дней). В preview нет постоянной записи budget. Лимит изменяется только с текущего либо следующего периода по серверным часам; effective boundary фиксируется в preview. При пересечении границы периода до commit нужен новый preview. Изменение current заменяет только версию с текущей границей, сохранённая next-версия не исчезает. Исторические границы не переписываются. Fixed не имеет next и завершённый fixed limit нельзя редактировать. Calendar/timezone существующего бюджета не меняются; для другого календаря создаётся новый budget. Filter/basis/name/enabled можно редактировать отдельно от лимита.

Account/counterparty/category merges переназначают ссылки; ambiguous Split и исчезнувшие зависимости дают `needs_setup`, не расширяют фильтр. Repair включён в журнал того же действия и Undo. Selective deletion очищает финансовую историю и делает зависимые scopes недоступными; конфигурация не содержит копии операций. Full financial reset всегда удаляет budgets, независимо от сохранения оформления/категорий. Delete budget удаляет только конфигурацию; финансовые операции остаются.

## Интерфейс и проверка

Settings → Budgets: создание и редактирование условий, точные карточки/расшифровка, просмотр периода по дате, версии лимита, current/next, временное выключение, подтверждение удаления и переход в Operations с теми же условиями. Общие filters не ограничивают сохранённый budget. Устаревшая форма блокируется при новой revision; поздние ответы не возвращаются после unmount/access loss. Отмена preview сохраняет черновик; чужая последующая revision блокирует его, но не закрывает. Форма закрывается после подтверждённого собственного action receipt. Если выбранные объекты уже удалены, пользователь может явно очистить фильтр и проверить новое условие в preview; автоматического расширения нет. Формы не сохраняют финансы в browser storage.

Проверки: core calendar/BigInt/negative net/15 001 rows; PostgreSQL preview/commit/idempotency, refund across periods, components, explicit excluded, versions/Undo, period crossing, anchor invariants, deletion/reset, tenant roles, stale writes, 15 003 rows; реальные HTTP/Chromium journeys desktop/mobile — create/confirm/next/reload/disable/drilldown/delete/Undo. Полные результаты относятся только к final head и записываются в PR после CI. Short budget job повторяет тот же subset и не прибавляется к общему числу уникальных тестов.

## Открытая область

§22.7 Analyzer NL/closed Registry/provider/quota ещё не реализован; GUI budgets не подтверждает его готовность. Overview budget widgets и их references появятся в блоке полного Overview: сейчас widget storage нет, и delete preview явно сообщает ноль references. Дополнительная многопользовательская нагрузка/SQL projection, реальные Safari/Android, Staging owner acceptance, backup/PITR restore и Production остаются отдельно. Серверный reconciliation всё ещё читает полный собственный граф; bounded budget response не является SQL pagination или Production SLA. Лимит конфигураций — 100 budgets на пользователя. В этой ветке нет подключения внешних сервисов, покупок, merge main или выпуска Production.
