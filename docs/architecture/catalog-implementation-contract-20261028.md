# Единый контракт реализации каталога, ACT и NAME

Дата: **28.10.2026**. Исходный SHA: `89e2619ef9f013ec5773680404dbcbbcfc13d5bf`. **Это конкретный план изменений и обязательных результатов; код приложения и сайт этим шагом не изменены.** Модельных POST 0. Следующий технический шаг — IMPL-00, затем компилятор данных и исправления source (IMPL-01/02), а не новый круг списков или согласований.

Основания: [решения каталога](./merchant-catalog-release-decisions-20261027.md), [129 состояний источников](./merchant-catalog-source-dispositions-20261027.json), [полный merchant-корпус](./merchant-catalog-complete-20261027.md), [ACT](./activity-vocabulary-20261028.md), [аудит ACT](./activity-spelling-review-20261028.md), [NAME](./operation-display-names-20261028.md), [наблюдения старого кода](./operation-display-name-baseline-20261028.json), [FIN](./merchant-catalog-financial-events-20261027.md). Все эти файлы сохранены без изменения и закреплены SHA256. Полные машинные задания, точные rule/scenario/target/router/specific-sense IDs и 23 просмотренных исходных файла: [контракт JSON](./catalog-implementation-contract-20261028.json).

## 1. Конечные технические решения

1. **Один версионированный артефакт данных** для всего merchant-каталога и ACT, а не копия большого справочника в каждом prompt. Составные section/profile IDs снимают коллизии старых T/U/C. Source disposition, период, сервис и положительные признаки обязательны. Исключённые/исторические записи не активируются новым красивым именем.
2. **Распознавание отдельно от названия.** Сначала допустимый source span → конкретный профиль/деятельность/предмет/услуга/доставка, затем собственная категория пользователя. ACT не создаёт identity сети. Тип/роль финансового события определяются действующей моделью, не брендом.
3. **NAME — read-only DTO-проекция.** Новый title не записывается обратно в semantics.merchant. В v1 ключ matching/group/sort остаётся прежним semantic merchant; универсальный merchant ID и массовая миграция правил не нужны. Одинаковые красивые имена не объединяют операции, контрагентов или компании.
4. **Банк остаётся банком.** Новые импорты используют исправленный версионированный extractor с исходной письменностью. Исторические bank facts/HMAC/source versions не переписываются. Если разрешённый старый оригинальный span не сохранился, оставить честный безопасный legacy label; raw/HMAC для восстановления не читать.
5. **Собственные категории и реальные сомнения.** Однозначная подходящая категория/синоним допустимы по смыслу, role/parent/visibility. Равные варианты → выбор. Нет Такси → не Общественный транспорт. Ясное кафе/аптека/каршеринг без лишнего Review; Go/Заправки/Парковки России без конкретной услуги — согласованные предварительные исходы с понятной причиной проверки.
6. **Модель — для остатка.** Очевидные локальные случаи решаются без POST. Только конечный подходящий контекст и refs собственных категорий; confidence не доказательство услуги. Старый serviceEvidenceMissing/prompt должен быть приведён в соответствие новой политике, а не блокировать правильный результат после matcher.
7. **Защита сохранённой работы.** Ручные назначения, личные правила, части/распределения, связи, история/Undo, повторный импорт и удаление остаются на действующих серверных границах. Выпуск не запускает массовое переименование/перекатегоризацию истории; для изменения истории — отдельная точная выборка и preview/commit.
8. **Никаких новых неоговорённых категорий.** Шесть выбранных узлов перечислены ниже. Для нового workspace — starter при создании. Для существующего — явный settings preview/commit с переиспользованием своих категорий. Скрытое/удалённое не воскрешается. Существующее одноразовое поведение Маркетплейсов (0030) не сбрасывается.

### Что реально есть в текущем коде

`classificationPlan/classificationSignal/parseClassification` уже ограничивают входы, собственные refs и role/parent. `classification-store` повторно применяет правила и ведёт assignments/cache/receipts. Но текущий `serviceEvidenceMissing` может полностью сбрасывать широкие сервисы вместо принятого предварительного исхода; prompt содержит прежние правила вендинга/телекома. Простое расширение merchantAliases этого не исправит. `operations.ts` фильтрует/группирует/sort по semantic merchant, а `ServerOperations` выводит ту же строку: именно вывод следует отделить, не подменять predicate. `financeView/operationView` — реальные точки DTO; модель пока имеет `Facet<string> merchant`, а не универсальный persisted merchant ID.

Полный первичный PDF в этом docs-only снимке заново не прочитан. Manifest v1.3 и SHA256 сверены по текущему исходнику; прежние продуктовые решения сохранены. **До изменения поведения IMPL-00 требует полный checkout и чтение соответствующих разделов PDF**, как прямо предписывает AGENTS.md. Это обязательная техническая проверка, не новое согласование списков с владельцем.

## 2. Порядок реализации и точные результаты

Работы не обозначены выполненными. Независимые IMPL-01/02 после фиксации baseline могут идти отдельно, но интеграция только по указанным зависимостям. Новые пути ниже — конкретные предложенные места кода, существующие — проверенные пути репозитория. Переименование модуля допустимо только с обновлённой трассировкой и тестами.

### IMPL-00 — Зафиксировать полный исходный релиз и продуктовые ограничения

Зависимости: нет. Статус: **NOT_STARTED_PRODUCT_IMPLEMENTATION**.

Существующие точки: `AGENTS.md`, `docs/product/source-manifest.json`, `docs/product/master_spec_v1.pdf`, `package.json`.

- Полный checkout точного SHA, чистое состояние и сверка manifest/PDF; чтение соответствующих полных разделов до изменения поведения.
- Исходные checks полного приложения; сохранённые ошибки разделены на прежние/новые.
- Фактический deployed SHA, API/frontend/import-worker, DB schema, версия source/evidence, действующие admission/остаток вызовов определяются перед выпуском, а не по старым чатам.

Обязательные проверки:

- PDF SHA256 и соответствующие разделы; check:spec; существующие пакетные проверки.
- Рабочая ветка; отсутствие ключей/raw/реальных финансовых данных в артефакте.

Закрываемые результаты **только после кода и проверок**: SOURCE_PREREQUISITES.

### IMPL-01 — Скомпилировать версионированные данные всего каталога и ACT

Зависимости: IMPL-00. Статус: **NOT_STARTED_PRODUCT_IMPLEMENTATION**.

Существующие точки: `packages/finance-core/src/merchant-catalog.ts`, `packages/finance-core/src/merchant-aliases.ts`, `packages/finance-core/src/grocery-catalog.ts`.

Новые модули/артефакты: `packages/finance-core/src/catalog/generated/catalog-v1.json`, `scripts/compile-merchant-catalog.py`.

- Каждая запись подробных merchant-документов получает составной section/profile key, aliases, конечный source disposition, период, service/subject, evidence guard, category target, reason и source locator. REF указывает на цель, не копирует identity.
- 194 ACT-записи/4282 конечные формы/78 targets/32 routers/31 containment/9 guards/8 composition сохраняются машинно. Генерируемые transliteration-кандидаты имеют исходную форму/ACT-TR1, не банк-наблюдение.
- Компилятор выдаёт coverage manifest для всех 24 направлений и всех подробных строк/правил/oracles. Каждая строка: исполняемая запись, REF или явный исключённый исход с причиной. Молчаливое выпадение или активация prose без guard запрещены.
- Старые общие T/U/C namespaced по разделу; HOME-T01–44 и HT-HOME01–32 сохраняются раздельно. Frozen corpus 28 документов не переписывается.

Обязательные проверки:

- Полное покрытие строк, стабильные IDs, детерминированный output/hash при повторе, недопустимые ссылки/пустые guard/периоды останавливают сборку.
- Все 129 явных source-dispositions учтены; остальные профили используют свои положительные ограничения, отсутствие в 129 не означает blanket approval.
- 0 пересечений, решённых порядком массива; исключённый профиль не активируется через alias/REF/NAME.

Закрываемые результаты **только после кода и проверок**: CATALOG_DATA_COVERAGE.

### IMPL-02 — Сохранить допустимый исходный текст и закрыть ошибки извлечения

Зависимости: IMPL-00. Статус: **NOT_STARTED_PRODUCT_IMPLEMENTATION**.

Существующие точки: `packages/imports/src/bank-description.ts`, `packages/imports/src/safe-source.ts`, `packages/imports/src/bank-table.ts`, `packages/imports/src/bank-pdf.ts`, `apps/api/src/finance.ts`.

- Устранить blanket подавление merchant на слове перевод: финансовый перевод и коммерческое Бюро переводов различаются по фактическому событию и допустимому полю. Не создавать merchant из ФИО перевода.
- Для новых импортов выбирать допустимый merchant span исходной письменности до legacy canonical merchantNames. Новая версия extraction/sanitizer при изменении wire semantics, совместимость старых форматов сохранена; номер версии фиксируется после полной сверки source registry.
- Никаких UPDATE старых bank facts/HMAC/dedupe/source versions ради имени. Для старой записи NAME использует только уже доступный допустимый очищенный span/provenance; если его нет — честный legacy fallback, восстановление raw запрещено.
- Разделить privacy очистку и доказательство lexical границ: Cf/underscore/цифра не склеиваются в новый alias; если sanitizer уже удалил разделитель без provenance, это не доказательство нового точного alias. Метка безопасности/typed span формируется на device из разрешённого исходного контекста без передачи raw.

Обязательные проверки:

- Новый import → API → repeated import/cancel/reset; та же строка не создаёт новый платёж и сохраняет ручные части.
- ФИО/обычные числа/слова с цифрой/перевод остаются; карты/счета/договоры/телефоны/email/паспорт/labelled IDs/полные URL скрыты.
- Две регрессии NAME-I04–I05 плюс scheme URL, REG.RU без обхода privacy, underscore/Cf отрицательные случаи.

Закрываемые результаты **только после кода и проверок**: NAME-I04, NAME-I05.

### IMPL-03 — Единый matcher identity/activity/subject/fulfillment

Зависимости: IMPL-01, IMPL-02. Статус: **NOT_STARTED_PRODUCT_IMPLEMENTATION**.

Существующие точки: `packages/finance-core/src/merchant-recognition.ts`, `packages/finance-core/src/grocery-evidence.ts`.

Новые модули/артефакты: `packages/finance-core/src/catalog-evidence.ts`, `packages/finance-core/src/activity-recognition.ts`.

- Чистая функция возвращает раздельно profile/service/activity/subject/fulfillment/source evidence/conflicts. Profile key — внутренний key справочника, не универсальный merchant ID всех операций.
- NFKC/casefold/ё-е/пробелы; конечные формы и известные U2010/U2011 внутри слов. Никакой общей транслитерации, edit-distance, OCR-подмены или удаления цифр/Cf/underscore для доказательства.
- Сначала допустимость поля/периода и реальный финансовый контекст, затем специфический сервис/предмет и адресные containment. Длиннейшая строка сама не выигрывает противоречие. Виды деятельности не придумывают известную сеть.
- Доставка/самовывоз относятся к тому же заказу/платежу; известный магазин + доставка достаточны без слова продукты. Противоположный предмет и личное решение выше; отдельный courier fee не товар.

Обязательные проверки:

- Исполнимые fixtures для всех 153 ACT-семейств и всех compiler-mapped merchant oracles; ожидается activity + evidence + conflict + fulfillment, не только категория.
- Контексты СТО/сто рублей, КТ/МРТ/УЗИ, bar/pressure, SPA/S.p.A., optika/apteka, vet/human, repair/goods, charge/car/powerbank.
- Широкий/исторический/excluded профиль и brand on goods/address/comment не назначают identity по одному вхождению.

Закрываемые результаты **только после кода и проверок**: CATALOG_MATCHING, ACT_CONTEXT.

### IMPL-04 — Сопоставить категорию владельца и объяснимую проверку

Зависимости: IMPL-03. Статус: **NOT_STARTED_PRODUCT_IMPLEMENTATION**.

Существующие точки: `packages/finance-core/src/merchant-recognition.ts`, `packages/finance-core/src/starter.ts`, `apps/api/src/classification-plan.ts`, `apps/api/src/finance.ts`.

Новые модули/артефакты: `packages/finance-core/src/category-resolution.ts`.

- Сначала manual/userVerified/применимое личное правило, включая все части; затем специфический допустимый предмет/сервис, общий профиль/ACT, только затем модельный fallback. Конфликт равных явных правил сохраняет существующий конфликт, не новый общий победитель.
- Target — смысл, не строковый ID starter. Только собственные активные role/parent-совместимые категории: явная привязка, затем однозначные допустимые exact/synonym candidates из 78 targets. Равные кандидаты → выбор; отсутствие Такси не подмена Общественным транспортом.
- Неясность сама по себе не заставляет очищать полезное предварительное предложение. Яндекс Go без услуги → Такси + проверка; Яндекс Заправки → Топливо + проверка; Парковки России → Парковки + проверка. Общий Яндекс не Go; доказанная специфическая услуга выше.
- Очевидные кафе/аптека/каршеринг без лишней проверки из-за отсутствия чека/маршрута; общий вендинг без предмета не доказанные продукты, food/coffee vending → Продукты; пекарня по принятому default → Еда вне дома, личные Продукты выше.
- Новые workspace: шесть ранее выбранных узлов в starter. Существующие: отдельное settings preview с переиспользованием собственных узлов и явным commit; не создавать/воскрешать скрытое/удалённое при входе или классификации. Marketplace 0030 один-раз поведение не сбрасывать.

Обязательные проверки:

- Каждый из 78 targets и 32 routers: own renamed/nested supported parent-child/role both/hidden/deleted/duplicate/missing. Не расширять глубину/foreign IDs неявно.
- Предварительная категория и конкретная причина проверки видны; уровень уверенности модели не заменяет service evidence. Отдельная неясность доставки не добавляет лишний category Review при очевидном parent.
- Ручная часть/категория/правило, изменение дерева пока запрос в полёте; пользовательский выбор не меняет банк/сумму/merchant.

Закрываемые результаты **только после кода и проверок**: OWN_CATEGORY_RESOLUTION, REVIEW_POLICY, SIX_SELECTED_NODES.

### IMPL-05 — Собрать NAME как чистую read-only проекцию

Зависимости: IMPL-03. Статус: **NOT_STARTED_PRODUCT_IMPLEMENTATION**.

Существующие точки: `packages/finance-core/src/merchant-recognition.ts`, `packages/finance-core/src/rules.ts`.

Новые модули/артефакты: `packages/finance-core/src/operation-display.ts`.

- Восемь полей NAME по 48 правилам, 12 typed transforms и 36 finite styles; default source script, TimeWeb исключение. Неописанный profile/script сохраняет допустимый исходный label.
- Обрезка geo/acquirer/legal/branch только по доказанному typed span после identity. Кафе Москва/Магазин Россия/Столовая Иннополис/СБЕР 24 Москва Рус не чистятся общим regex.
- Ozon Fresh/Go/Cloud/значимые цифры не теряются. Title + фактические qualifiers/event/aggregator дают идемпотентный composite. Исторические Leroy Merlin/Tele2/Boxberry сохраняют период.
- Не переписывать semantics.merchant для нового display, category/role/Review/source/HMAC/parts/links/rules. Protected личные имена сохраняются; style не recognizer и не category proof.

Обязательные проверки:

- Все 86 NAME-семейств превращены в исполнимые входы с typed preconditions и точными 8 выходами; отдельно malformed/injection/privacy/ownership/idempotence.
- NAME-I01–I03 исправлены с before/after regression; NAME-I06 merchantEquals/contains/descriptionContains/legacy TimeWeb truth table не изменилась из-за display.
- Полное deep equality всех input graph/source facets до/после formatter; UI ellipsis не обрезает underlying value/единственный Fresh.

Закрываемые результаты **только после кода и проверок**: NAME-I01, NAME-I02, NAME-I03, NAME-I06, NAME_PROJECTION.

### IMPL-06 — Закрыть FIN-интеграцию до общей активации

Зависимости: IMPL-00, IMPL-02. Статус: **NOT_STARTED_PRODUCT_IMPLEMENTATION**.

Существующие точки: `packages/finance-core/src/model.ts`, `packages/finance-core/src/graph.ts`, `packages/finance-core/src/allocation-graph.ts`, `packages/finance-core/src/operations.ts`, `packages/finance-core/src/overview.ts`, `apps/api/src/finance.ts`.

- FIN-I01: банковский календарный день source-local; профиль today/relative ranges и UI timestamps отдельны. Смена часового пояса пользователя не сдвигает выписку; неизвестный source zone не заменяется Москвой/поездкой. Не менять глобально operationDay на profile timezone.
- FIN-I02: проследить import/reimport/cancel/reset для полученных и уплаченных процентов с направлением/предметом, защитой manual. Изменять defaultRole/callers только по подтверждённому end-to-end маршруту, не по одному имени interest.
- FIN-I03: существующие loanMode/components/links/incomplete flags проверить, не заменить новой моделью. Cashflow кредит весь платёж; Economic principal neutral, interest/fee/insurance expense; account override выше global.
- FIN-I04: фактический BNPL договор отображается только совместимой существующей моделью. Неподдерживаемый договор получает конечный BLOCKED_UNSUPPORTED_CONTRACT с причиной и без выдуманного долга/дублированного расхода; новый универсальный kind не создаётся.

Обязательные проверки:

- FIN-T01–T96 и параметризация FIN-P01–P14 исполняются с фактическими source/effective/parts/link/preconditions, собственными timezone и unknown-zone cases.
- 25000=20000+4500+500: Economic expense 5000 RUB, Cashflow 25000; кредитная покупка expense, погашение neutral, неполнота кредитки не превращает repayment в expense.
- Refund реального периода/частичная ёмкость/инвалидные links; own transfers/cash/loan issue не создаются по одному бренду; NAME не меняет итоги.

Закрываемые результаты **только после кода и проверок**: FIN-I01, FIN-I02, FIN-I03, FIN-I04.

### IMPL-07 — Подключить сервер и ограниченный модельный fallback

Зависимости: IMPL-04, IMPL-05, IMPL-06. Статус: **NOT_STARTED_PRODUCT_IMPLEMENTATION**.

Существующие точки: `apps/api/src/classification-plan.ts`, `apps/api/src/classification-store.ts`, `apps/api/src/finance.ts`, `apps/api/src/operations.ts`, `apps/api/src/classification-admission.ts`, `apps/api/src/classification-tariff.ts`.

- Сначала deterministic evidence + own resolver; на модель только остаток допустимых unresolved запросов, не весь 3 MB справочник и не все 4282 формы на каждый POST.
- Устранить расхождение текущих prompt/serviceEvidenceMissing с новой политикой Go/vending/telecom/marketplace. Переиспользовать closed finite per-request refs, role/parent constraints и anti-injection. Confidence 95 не доказательство услуги/товара.
- Версии engine/evidence/catalog hash входят в cache/signature; новые версии не приписываются старым квитанциям. Результат старой политики не становится новым PASS.
- Перед apply повторить ownership/status/entitlement/admission/generation/revision/current rules/tree/source-deletion/parts checks под workspace lock. Queue/cached/retry не перезаписывают решение, принятое пока модель отвечала.
- Историческая автоперезапись всего workspace не запускается выпуском. Новый импорт/явная классификация по прежнему разрешённому workflow; bulk change старых решений только отдельным preview/commit с точным выбором, журналом и Undo.

Обязательные проверки:

- API integration/security: own/foreign/deleted/reset/stale/current rule added/hidden category/unknown HTTP/partial response/out-of-order/cache policy change.
- HTTP timeout в пределах provider; sent/unknown не повторить POST автоматически, расход settled/reserved и customer quota не сбрасываются.
- Локальные clear cases расходуют 0 model POST; серверная авторизация не зависит от клиента/AI.

Закрываемые результаты **только после кода и проверок**: SERVER_INTEGRATION, CACHE_COMPATIBILITY.

### IMPL-08 — Подключить интерфейс и сохранить поиск/группировку

Зависимости: IMPL-05, IMPL-07. Статус: **NOT_STARTED_PRODUCT_IMPLEMENTATION**.

Существующие точки: `apps/api/src/finance.ts`, `apps/api/src/operations.ts`, `packages/finance-core/src/operations.ts`, `apps/web/src/operations-client.ts`, `apps/web/src/ServerOperations.tsx`, `apps/web/src/ServerOperation.tsx`, `apps/web/src/ServerOverview.tsx`, `apps/web/src/ServerReview.tsx`, `apps/web/src/ServerAnalyzer.tsx`.

- DTO получает additive optional display projection/version; старый клиент/сервер сохраняет legacy fallback. classification.merchant и существующие contracts остаются для matching. Общая pure function для списка, карточки, Review, Analyzer и доступных export surfaces.
- Точная merchant-фильтрация, saved views/cursors/group/sort используют прежний semantic key; NAME style не склеивает группы/людей/компании. Никакого нового универсального merchant ID или массовой миграции правил. Отображение может совпасть без объединения операций.
- Свободный search может дополнительно искать безопасный display label только версионированно с сохранением старых hits; merchantExact и selection/summary не меняются. Изменение query-семантики инвалидирует cursor/query hash и просит reload, не меняет молча текущую выборку.
- Показывать продавца/услугу/доставку и очищенное банковское описание отдельно; input редактора личного merchant не подменять UI projection, чтобы Save другого поля не записал красивый title. Review понятным языком; no tech IDs в продукте.
- Plain text, без HTML/autolinks/command execution. Для текстового CSV/табличного экспорта — безопасная строковая ячейка без formula execution; значения source не меняются. Исторические before/after отображают свой snapshot, не нынешнюю identity другого периода.

Обязательные проверки:

- Desktop/mobile: все 8 NAME полей/однополе composite/длинные неизвестные/клавиатура/детали source/ручное имя/выбор категории.
- Worldclass/XFit/TimeWeb private rules + saved merchant filters/group totals/cursors/reload; коллизия двух display labels не объединяет записи.
- Ozon 50/50 food/clothes: итог один, merchant Ozon, другая покупка не наследует split; refund к части, reimport/Undo сохранены.

Закрываемые результаты **только после кода и проверок**: UI_NAME, SEARCH_RULE_COMPATIBILITY, SPLIT_REGRESSION.

### IMPL-09 — Полная офлайн-проверка одной сборки

Зависимости: IMPL-01, IMPL-02, IMPL-03, IMPL-04, IMPL-05, IMPL-06, IMPL-07, IMPL-08. Статус: **NOT_STARTED_PRODUCT_IMPLEMENTATION**.

Существующие точки: `package.json`, `apps/api/test/classification-integration.test.ts`, `packages/finance-core/test/merchant-recognition.test.ts`, `packages/imports/test/safe-source.test.ts`, `apps/web/e2e/operations.spec.ts`.

- Одна immutable сборка, data hashes, версии и полный manifest реально исполненных case IDs/входов/ожиданий/результатов. 153 ACT +86 NAME — минимум описанных семей, не 239 автоматически исполненных unit tests. Merchant/FIN/negative/parameterized cases отдельны.
- Полное покрытие rules/guards/routers/dispositions/24 разделов и назначение каждого oracle на fixture либо конечный unsupported guard. Никакого зеленого статуса только за наличие строки в markdown.
- Проверки по фактическим package scripts полного checkout; targeted tests сначала, затем pnpm check, integration/security и e2e. Существующие baseline failures не смешивать с новыми и не объявлять overall PASS при обязательной ошибке.

Обязательные проверки:

- Unit/property: normalization/boundary/idempotence/read-only/integer parts; integration: new/repeated/cancel/delete/reset/race.
- Security/RLS/Registry/deletion/access; desktop/mobile API-connected import, filters, Analyzer, Review, rename and split.
- Измерить p50/p95 matcher/NAME на фиксированном синтетическом объёме, warm/cold отдельно, отсутствие массовых POST; фиксировать среду и сравнение с исходным кодом, без придуманных SLA.

Закрываемые результаты **только после кода и проверок**: OFFLINE_ACCEPTANCE.

### IMPL-10 — Адресный свежий модельный прогон после офлайн-прохождения

Зависимости: IMPL-09. Статус: **NOT_STARTED_PRODUCT_IMPLEMENTATION**.

Существующие точки: `apps/api/src/classification-smoke-main.ts`, `apps/api/src/classification-admission.ts`, `apps/api/src/classification-tariff.ts`, `scripts/run-classification-check.sh`.

- До первого POST получить действующие provider/model/tariff/admission/истечение и фактические cumulative settled/sent/unknown/reserved calls. Исторические 70 вызовов — общий лимит согласованного этапа, не 70 новых на каждую версию. Исторические денежные лимиты не расширяются фразой о копейках.
- Если прежний admission истёк/лимит исчерпан, не перебирать обходы/не создавать новый без учёта прошлых вызовов. Сначала подготовить точный ограниченный набор/квитанцию continuation; применить уже существующее разрешение только в его границах.
- Свежие синтетические случаи на одной сборке: очевидные аптекa/общепит/оптика, неоднозначный агрегатор, own synonyms/missing taxi, service conflict, marketplace/delivery, protect user/parts. Прямой deterministic case не обязан вызывать модель.
- Сохранить raw synthetic response/finish reason/parse/semantic validation/usage/receipts. Replay отдельно, new model measurement отдельно; объяснения оценивать по смыслу. Повторный запрос только по конкретной исправленной причине и в остатке.

Обязательные проверки:

- Архив неизменен при replay; fresh policy/hash/fixture/preconditions; bounded calls/token caps/HTTP timeout.
- Stop при schema/meaning error с сохранённой диагностикой; не тратить весь лимит на повтор одной ошибки и не считать guarded old model mistake свежим model PASS.

Закрываемые результаты **только после кода и проверок**: MODEL_ACCEPTANCE.

### IMPL-11 — Релиз Staging одной сборкой и приёмка владельца

Зависимости: IMPL-09, IMPL-10. Статус: **NOT_STARTED_PRODUCT_IMPLEMENTATION**.

Существующие точки: `scripts/update-staging-release.py`, `scripts/install-assistant-staging.py`, `scripts/diagnose-classification-staging.py`.

- Единый SHA API/frontend/import-worker и data hashes, connected API origin, reproducible build/check manifest; до switch — синтетический smoke, backup тестовой БД/конфигурации и конкретная rollback-команда.
- Проверить WorkingDirectory/права каждого родительского пути/code group/DynamicUser. Ограниченные timeout/START/OK/error-output на каждом шаге, systemctl failure с stderr/journal и неблокирующий rollback. Не оставлять пользователя с тихо зависшей командой.
- Если миграция действительно нужна — additive/versioned, transaction/preflight/backup; старый код совместим с оставленной схемой. NAME сам не требует новой колонки/таблицы. Не назначать номер миграции до сверки полного актуального registry.
- При сбое вернуть code/frontend конфигурацию без восстановления старой БД поверх новых пользовательских данных и без потери receipts/parts/history. Чистка temp не удаляет archive/release/ключи.
- Приёмка в connected Staging: импорт файла, банковское описание/NAME, категории/Review, собственные правила, поиск/части/повторный импорт/удаление/Undo; видимый SHA. Только после фактической приёмки отдельное решение Production по AGENTS.

Обязательные проверки:

- Health API/import worker/frontend/Caddy + синтетический connected E2E после переключения и тест rollback.
- Учёт расходов/admission не сброшен; реальные данные не копируются в тестовые fixtures/логи; owner acceptance записана отдельно от installer success.

Закрываемые результаты **только после кода и проверок**: STAGING_ACCEPTANCE.

## 3. Данные, совместимость и неизменяемые границы

| Интерфейс | Хранение | Назначение и право |
|---|---|---|
| CompiledCatalog | Статический артефакт сборки, version/hash | Профиль/формы/source disposition/периоды/guards/targets/oracles; никакого права писать операции |
| RecognitionEvidence | Чистый промежуточный результат | Раздельные identity/activity/service/subject/fulfillment и provenance/conflict; без финансовой authority |
| CategoryResolution | Preview либо существующий классификатор | Own IDs/уверенность/предварительность/причина/версия; сервер заново проверяет перед записью |
| OperationDisplay | Additive optional DTO | 8 полей NAME, версия; title/event/service/delivery/via/composite/description ref/explanation; никакой записи в graph |

У каждой категории модель выбирает только разрешённые refs текущего запроса; core resolver обязан учитывать и допустимую собственную вложенную пару category/subcategory. Широкий родитель может быть правильным ответом, не вынужденным Review. Два одинаковых имени под разными parent/role — неоднозначность, не first-match. Удалённые/скрытые узлы не восстановить по словарю.

Совместимость user rules проверяется на уровне истинности merchantEquals/merchantContains/descriptionContains, особенно Worldclass/World Class/XFit/legacy Таймвэб. Новый display не поступает в rule predicate. Изменение распознавания identity также не должно незаметно расширить действие старого правила: нужна адресная compatibility-проверка, а изменение истории лишь отдельным действием. Group key не равен display title. Дополнительный свободный поиск по title не отменяет старые hits/merchantExact и вводится с query-version/cursor invalidation.

Преобразование имён не раскрывает реквизиты. Очищенное описание отдельно доступно по существующему доступу; ФИО/обычные цифры/слова с цифрой/слово перевод не маскируются целиком. Карты/счета/договоры/телефоны/email/паспорт, распознаваемые labelled IDs и интернет-ссылки маскируются прежней политикой. Никакого обхода URL через домен из каталога или замены .ru на ру.

Нормализация ACT не должна «создать» слово из `ap_teka`, цифр или удалённого Cf. Privacy sanitizer и matcher имеют разные задачи: provenance безопасности нужного span сохраняется на локальной границе, а не реконструируется по raw на сервере. Фактический финансовый перевод сохраняет текст/ФИО, но не назначает merchant известного бюро; коммерческое Бюро переводов не теряет торговое имя по одному substring.

### Шесть ранее выбранных узлов

- Связь и интернет / Аренда пауэрбанков — POWERBANK selected target.
- Здоровье и спорт / Спортивное питание — SPORT selected target.
- Техника и электроника — MP selected target.
- Здоровье и спорт / Стоматология — HU01–HU20 retained selected target.
- Здоровье и спорт / Оптика — HU01–HU20 retained selected target.
- Здоровье и спорт / Медицинские изделия — HU01–HU20 retained selected target.

Не добавлять новых общих категорий под каждый из 194 ACT-смыслов; router может выбрать существующий совместимый собственный узел либо дать конечное уточнение/поддерживаемый parent. Новый брокерский/страховой каталог вне scope. Эти решения уже определены, отдельного повторного согласования не требуется.

## 4. Что считается закрытием NAME-I/FIN-I

| Находки | Что уже известно | Кто и как закрывает |
|---|---|---|
| NAME-I01–I03 | 15 прежних наблюдений включают потери неизвестных Москва/Россия/Иннополис, Fresh и ошибочную общую очистку prefix/geo | IMPL-05: конкретные regression fixtures до/после, typed guards, unknown identity retained |
| NAME-I04–I05 | Прежний код подавляет бюро переводов и может русифицировать до NAME | IMPL-02: extractor regression + новый импорт/reimport/reset/dedupe/source invariants |
| NAME-I06 | Совместимость будущего formatter с правилами, не шестой доказанный баг | IMPL-05/08: правило/точный фильтр/group truth table, no semantic write |
| FIN-I01 | operationDay instant жёстко использует Москву, day precision сохраняется | IMPL-06: source-local day и profile-relative clock отдельно, границы суток и unknown zone |
| FIN-I02 | defaultRole interest не принимает направление, downstream ещё может менять исход | IMPL-06: реальный end-to-end источник/направление/reset, а не предположенный общий фикс |
| FIN-I03 | Credit/components/loanMode/neutral links уже существуют | IMPL-06: проверка принятой модели без дублирования parent |
| FIN-I04 | Нет универсального BNPL контракта в модели | IMPL-06: фактический совместимый mapping либо явный unsupported contract без нового долга/расхода |

Все десять пунктов остаются **NOT_FIXED/NOT_RUN на уровне реализации** до фактического выполнения. Конечный безопасный неподдерживаемый исход для неизвестного BNPL — предусмотренное поведение, а не заявление о полной поддержке всех договоров. Документальные вопросы источников и согласований не открываются заново.

## 5. Проверки, ресурсы и выпуск

- 24 merchant-направления, 129 явных dispositions, все исходные подробные rules/oracles и оба набора HOME не теряются при компиляции. Coverage JSON обязан иметь адресные строки, не одну цифру «всё покрыто».
- 194 ACT/4282 формы/40 общих правил/9 guards/8 composition/31 containment/18 specific edges/78 targets/32 routers; 153 будущих semantic families. 48 NAME rules/12 transforms/36 styles/86 будущих families. Трассировка всех ID в контракте не означает, что сценарии исполнены.
- Тестировать перенос merchant-контекста и варианты алфавитов/падежей/транслитерации на точных конечных формах; отрицательные prefix/suffix/code/Cf/OCR, совпадения между разделами, конфликт доказательств, отсутствие/дубли/удаление собственных категорий.
- Повторить существующие regression checks финансов, split, imports/dedupe, links, access/security/deletion и UI только на синтетике; сравнить protected/source/effective/ID/суммы/роли до и после NAME. Модель не нужна для форматирования имени.
- Полный checkout использует реальные package scripts: `pnpm run check:spec`, `pnpm test`, затем `pnpm run check`, security integration и e2e. В docs-only снимке полный build не объявляется выполненным. Старые ошибки baseline не скрывать за статусом отдельных новых тестов.
- Перед моделью — действующий admission и фактические расходы/вызовы. **70 cumulative — не 70 новых на каждую попытку**; старые денежные ограничения не сбрасывать. Архив/replay отдельно от свежих POST. Выданное ранее разрешение продолжается только внутри действующего лимита и срока.
- Staging получает один SHA/data hash: API, connected frontend, import worker. Backup, bounded команды с понятным прогрессом, stderr/journal при отказе systemctl, права всех родительских директорий, готовый rollback, no loss of receipts/user data. Приёмка владельца — отдельная запись после installer success. Production этим планом не переключается.

[Проверка контракта](./catalog-implementation-audit-20261028.json) проверяет только целостность/полноту связей плана. Повторно пройдены прежние документальные/лексические проверки ACT и NAME с SHA-проверенными исходниками; это не новая модельная проверка. Её PASS не исполняет 239 ACT/NAME-семейств, merchant/FIN-кейсы, не исправляет десять находок и не принимает runtime. Точный повтор: `python3 scripts/audit-catalog-implementation.py`.
