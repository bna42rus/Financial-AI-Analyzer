# Полный Обзор: расчёты, widgets и named views

Источник: полный PDF §21.1–21.13, §47.2, §33.7, §34, §52 и утверждённые A/B. Продолжение поверх PR #36; исходные документы не изменяются. Этот контракт описывает реализованный Development блок. Результаты финального commit/CI публикуются в PR.

## Состав

| Требование | Реализация и смысл |
| --- | --- |
| 21.1–21.2 | Расходы net, доходы, разница (не баланс), количество transactions с активными review reasons. Системные предупреждения об обработке, неполных imports/credit data показаны отдельно. |
| 21.3, 21.13 | Стандартные expense/income category, dynamics, period comparison, top categories, top operations, budgets, attention и top merchants. Дополнительный каталог refunds/reimbursements, own/general transfers, loan payments/costs, fees, cash, counts. |
| 21.4, 21.12 | Constructor: до 3 разрешённых метрик, time/category/subcategory/account/bank/kind/role/counterparty/merchant/operation grouping, auto/day/week/month/quarter/year, period, explicit local filters, excluded categories, top N, sort. Budget отдельный metric без бессмысленной суммы перекрывающихся лимитов. |
| 21.5 | Expense/income widgets выбирают только соответствующие terminal parts. Own transfers/cash/unresolved не становятся расходом из-за наличия суммы. Parent и компоненты одновременно не складываются. |
| 21.6, 21.9 | Point → value/action → Operations с теми же filters и metric. Exact merchant, null subcategory/counterparty, excluded category и component/link metrics имеют серверные selectors. Operations показывает сумму выбранных частей отдельно от полной суммы банковских строк. Top operation может открыть карточку. |
| 21.7 | Breakdown: transactions, gross, refunds, reimbursements, net, income, excluded, neutral, unresolved и human-readable active filters. Для widgets доступны точные значения и диагностика. |
| 21.8, 47.2 | Named Overview Views содержат фильтры, widgets и независимые desktop/mobile permutation, hidden, size и desktop width. Move/drag, hide, duplicate/remove, rename, copy, default, reorder/delete. Mobile cards на полную ширину; tap показывает value + Operations action. |
| 21.10 | Independent graph/table and deterministic text; хотя бы один слой включён. Нет фонового AI вызова. Deep AI explanation относится к следующему Analyzer/provider блоку. |
| 21.11 | Previous same length / month / year / custom comparison. Leap dates clamp; prior-only groups сохранены. Empty comparison сообщает отсутствие операций, не доказанное отсутствие расходов. При нулевой/отрицательной базе процент не придумывается. |
| 21.13 | Apache ECharts 6.1.0, modular lazy load, SVG, explicit AriaComponent/description/decal, text/table alternative и exact tooltip. Bar/line/donut/table; signed net/comparison/multi-metric donut становится bar, money + counts — table. |

## Единое финансовое ядро

`packages/finance-core/src/overview.ts` использует `operations.ts` после полного reconciliation. API загружает весь собственный graph один раз; каждый widget фильтрует конечные части. Деньги остаются BigInt integer minor units, наружу идут строки. Числовое приближение допускается только для геометрии ECharts. Значения выше safe integer отображаются точной таблицей; никакие деньги не считаются JavaScript float.

Refunds/reimbursements различаются по подтверждённым allocation kinds. Own-transfer metric считает исходящие neutral portions один раз, включая partial link. General transfers и cash явно подписаны как поступления минус списания. Loan costs отбирает interest/fee/insurance terminal components; principal не превращается в расход в economic mode. Связи учитываются даже если исходная покупка вне текущего периода.

Bank dates остаются source-local (поддерживаемые российские банки — Москва), не двигаются из-за путешествия. Profile timezone применяется к «сегодня» и динамическому периоду. Week начинается в понедельник; month/year comparison clamp сохраняет допустимую календарную дату.

Top N ограничивает список групп, не итог. Time gaps имеют zero buckets; до 370 отображаемых intervals, после предела явное сообщение и table с последними интервалами, общий итог остаётся полным. User-config bounds: до 30 widgets, до 3 metrics, top N 1–50, до 100 views. Операции не отдаются вместе с полной аналитической выборкой.

## API, persistence и concurrency

- POST `/finance/overview`: bounded агрегированные KPI/points/context, generation/revision, budget choices и warnings; no-store.
- POST `/finance/overview-views`: собственные конфигурации.
- `save_overview_view`, `delete_overview_view`, `reorder_overview_views`: обычный финансовый preview/commit, lease на revision/generation, action_id idempotency и History delta/Undo.
- Durable financial rate limits разделяют чтения (240/IP/min) и записи (120/IP/min); route limits остаются 120 read или 60 write/min, authentication quotas неизменны. Автоматические чтения widgets на двух устройствах не расходуют бюджет сохранений.
- Temporary filters/navigation/point hover/unfinished drag не создают writes. Сохранение завершённой конфигурации — отдельное явное действие.
- Default-view late response не затирает пользовательский фильтр. Late analytics не возвращается после unmount/filter/access loss. Новый filter/revision скрывает старые totals до свежего расчёта.
- Widget/view drafts остаются в памяти. После чужой revision форма блокируется; отмена не уничтожает черновик. Сохранение использует revision открытия draft, не подставляет свежую автоматически.
- Merge переназначает global/local/excluded-category references. Split/deletion/budget removal помечает dependent view `needs_setup`, сохраняет старые selectors и требует явного исправления. Ссылки принадлежат тому же tenant; foreign IDs не дают authority.
- Financial reset удаляет overview views или сохраняет только очищенную interface configuration с `needs_setup`. Account/counterparty/import/rule references, merchant/search/amount conditions, конкретные budgets и пользовательские financial titles не переживают wipe. Browser stores не содержат financial data, drafts или layouts; разрешены только appearance и opaque interface epoch.

## Миграция и откат

Применяется `0021_overview_views.sql` после `0020_budgets.sql` owner-ролью стандартным способом миграции из runbook. Создаёт `finance.overview_view`, FORCE RLS, unique default на tenant, immutable identity, revision/modified_at triggers; у control/mail ролей нет доступа. Существующие банковские записи не изменяются.

До применения снять проверяемый backup по runbook и сначала проверить на Staging. При rollback приложения сохранить таблицу и history data; предыдущий artifact не использует эту конфигурацию. Не удалять таблицу/функции пока новые snapshot kinds могут читаться старым History/reset кодом: старый artifact не совместим с новым `overview_view` journal. Forward-fix или возврат к artifact с совместимым History registry безопаснее. Production acceptance/deployment остаётся отдельным решением владельца.

## Проверка и границы

Core тесты проверяют весь metric/grouping catalog, точное совпадение point/Operations selector, source-local dates, leap/custom comparisons, gaps, zero/negative values, layouts, schema/privacy и 15 001 большие суммы. PostgreSQL тесты: preview/idempotency, complete 15 003 graph, cross-period refund, components/exclusions, defaults/layouts/history/Undo, dependency repair, reset, ownership/RLS/control/mail/access. Реальные Chromium HTTP journeys desktop/mobile используют 15 003 transactions. UI suite проверяет constructor, text/graph, full catalog, deterministic values, merchant drill, saved views/reload, resize/duplicate/mobile hiding, stale drafts, late default/financial responses и access revocation.

Mobile означает Chromium emulation, не Safari/iOS acceptance. Эти сценарии не подтверждают multi-user Production SLA. Настоящие services/Staging acceptance, profile timezone settings и глубокий AI analysis остаются в соответствующих следующих блоках; Overview читает существующий серверный timezone contract. Historical demo сохраняет отдельно обозначенные искусственные данные и не подменяет серверный экран.

CI распределяет все уникальные сценарии между jobs: bootstrap выполняет 321 PostgreSQL и 22 реальных HTTP теста, overview-checks — оставшиеся 9 PostgreSQL и 2 HTTP теста Обзора. Большие 15k journeys не запускаются повторно внутри bootstrap. Полные локальные команды `test:security` и `test:access-browser` сохраняют все 330/24 сценария; общий набор CI остаётся 850 уникальных тестов. Отдельные budget/UI subsets служат дополнительной проверкой и не увеличивают этот счётчик.
