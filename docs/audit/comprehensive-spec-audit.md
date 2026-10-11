# Полный повторный аудит — 10 октября 2026

Найдены и исправлены **шесть конкретных дефектов**. Проанализированы 455 записей PDF, 39 утверждённых уточнений, все 9 указателей приложения A и 30 разделов Word. Сопоставление по каждому пункту: [читаемая матрица](comprehensive-spec-matrix.md) и [структурированный audit/evidence](comprehensive-spec-matrix.json).

**Полного соответствия продукта пока нет.** 494 строки — индекс требований, включая родительские заголовки, а не 494 успешных acceptance tests. Статусы основного registry сохранены: 264 partial / 191 not_verified у PDF, 25 partial / 14 not_verified у уточнений. Этот аудит не переводит их в completed.

Основа изменений: remote #33 head `6fec5fe2f56dd845690e49f8a952858d4e354e5c`, дерево `6ad574f5abf9a93f8219a926180db21108aad159`; локальный исходный parent имеет то же дерево. PDF/Word SHA проверены, исходники не менялись. Все ссылки registry существуют. Старые audit/plan заметки читаются как исторические срезы; исправлена ошибочная запись worker README о якобы отсутствующем import worker.

## Исправленные ошибки

| ID | Риск и прежнее поведение | Исправление и проверка |
| --- | --- | --- |
| F01 P1 | Порядок links менял финансовые результаты. Последовательная invalidation позволяла одному из взаимно неоднозначных links победить в зависимости от входного порядка. Менялись September/October totals. | Все ambiguous IDs вычисляются на одном неизменном snapshot и отклоняются вместе. [graph.ts](../../packages/finance-core/src/graph.ts), [graph.test.ts](../../packages/finance-core/test/graph.test.ts) |
| F02 P1 | Editable financial text пропускал passport/email/invisible identifiers. Guard распознавал длинные номера/телефоны, но не passport/email/opaque labelled IDs; invisible Cf разделяли номер. | NFKC + Cf joining до проверки, email/passport/labelled identifier masks; server отклоняет raw text без writes/reflection. [text.ts](../../packages/privacy/src/text.ts), [text.test.ts](../../packages/privacy/test/text.test.ts), [finance-client.test.ts](../../apps/web/src/finance-client.test.ts), [finance.test.ts](../../apps/api/test/finance.test.ts) |
| F03 P2 | Неверный delimiter отклонял валидный CSV. Проба чужого разделителя объединяла разрешённые cells в >4000 chars и немедленно выбрасывала LOCAL_LIMIT. | Лимит относится к кандидату; проверяются остальные delimiters, oversized настоящий cell всё равно запрещён. [bank-table.ts](../../packages/imports/src/bank-table.ts), [bank-table.test.ts](../../packages/imports/test/bank-table.test.ts) |
| F04 P1 | XLSX formula error marker создавал dedupe evidence. Придуманный !INVALID_FORMULA попадал в optional description и превращался в общий strict-description HMAC. | Unsupported/formula/date/error cells не дают text evidence; required fields становятся row issues, cached formula text не используется. [xlsx-reader.ts](../../packages/imports/src/xlsx-reader.ts), [tabular-fixtures.ts](../../packages/imports/test/tabular-fixtures.ts), [import-tabular.spec.ts](../../apps/web/e2e/import-tabular.spec.ts) |
| F05 P1 | 1000 допустимых rows не помещались в HTTP limit. Closed bank-local/1 профиль: 1000 rows с двумя instants/HMAC/merchant занимает 607505 bytes; route лимит был 524288 bytes. | Только validation/accept routes допускают 1 MiB; schema всё ещё ограничивает files/rows/fields. Auth остаётся 8 KiB. [server.ts](../../apps/api/src/server.ts), [import-validation.test.ts](../../apps/api/test/import-validation.test.ts) |
| F06 P1 | Установленная PDF.js попадала в advisory range. pdfjs-dist 5.6.205: pnpm audit high=1, GHSA-hq66-cqwq-w95j / CVE-2026-16633. Advisory касается scripting=true без блокирующей CSP; эксплуатация в нашем low-level importer не доказана. | Pinned pdfjs-dist 6.2.108 + lockfile; pnpm audit не нашёл advisories; CI отклоняет high/critical. Low-level getDocument всё ещё отключает eval/XFA и network fetch. [package.json](../../apps/web/package.json), [pnpm-lock.yaml](../../pnpm-lock.yaml), [pdf-reader.ts](../../packages/imports/src/pdf-reader.ts), [bootstrap.yml](../../.github/workflows/bootstrap.yml), [import-tabular.spec.ts](../../apps/web/e2e/import-tabular.spec.ts) |

По F06 официальное сообщение maintainer: [GHSA-hq66-cqwq-w95j](https://github.com/mozilla/pdf.js/security/advisories/GHSA-hq66-cqwq-w95j). В приложении не воспроизведено выполнение PDF script; установленная уязвимая версия заменена, а совместимость проверяется настоящим local PDF/OCR browser suite.

## Новые и повторные проверки

- Link-order regression плюс 100 generated scenarios: ambiguous links не получают случайного победителя, source facts/manual category неизменны, суммы в месяцах одинаковы.
- 10 001 synthetic financial fact в pure core: exact integer totals, exclusion и cross-period refund без изменения source. Локальное измерение около 137 ms — справочная величина этого процесса, не обещание Production throughput.
- Privacy passport/email/opaque labels, fullwidth glyphs/Cf bypass, local/server parity, idempotent sanitizer; обычные суммы/даты/имена сохраняются. HTTP raw text не пишет action и не отражает input.
- CSV: comma/semicolon/tab с длинными разрешёнными cells; истинный oversized cell остаётся заблокирован.
- XLSX: description formula не даёт cached text или invented strict-dedupe evidence; required-cell formula/date/XML/external relationships остаются conservative. Desktop/mobile browser regression.
- Полный 1000-row closed bank profile >512 KiB: validation без финансовых writes, acceptance создаёт durable batch; >1 MiB и malformed JSON получают static errors, auth limit 8 KiB сохраняется.
- Повторяется весь существующий набор: exact money/property cases, partial refund/own transfer/loan/reversal, capacity/source corrections, canonical duplicate IDs/conflicts/Undo, provenance/shared-file cancellation, reset/delete generation/key fences, stale UI responses, snapshot Review/rules/structure/bulk/history, server ownership/access/TOTP/recovery/payment/renewal/mail isolation и migrations.
- Source-integrity проверка дополнена целостностью новой matrix: все 494 IDs без пропуска/дубликатов, hashes текста, все referenced files, 9 appendix maps и 30 Word sections; no fabricated full-clause completion.
- Dependency audit добавлен в CI для high/critical. Проверка secrets на tracked text показывает только результат, не секреты; реальные банковские файлы в fixtures/Git не добавлялись.

Локально прошли **254 теста**: 169 core/access/import/privacy, 77 web unit и 8 API crypto/mail; TypeScript web/admin/API и обе production-mode frontend сборки. `pnpm audit --json`: 313 зависимостей, advisory counts = 0. Эти builds не являются Production deployment.

Локальный Chromium отсутствовал; его download mirror вернул повреждённый архив. Тот browser attempt завершился на launch до исполнения assertions. Полные новые HTTP/PostgreSQL/browser проверки выполняются в isolated GitHub CI с official PostgreSQL 18.4 и установленным Chromium; итоговый exact-head run, job conclusions и точные количества публикуются в описании этого audit PR. Результат старого PR #33 не переносится на новые изменения. Mobile emulation Chromium не является iOS Safari acceptance.

## Оставшиеся расхождения и порядок работы

P1 означает обязательную работу до завершения v1/release, а не автоматически воспроизведённую эксплуатацию. P2 — дополнительное product/device/операционное завершение. Часть пунктов требует разработки, часть реального подключённого окружения и приёмки владельца.

| ID | Приоритет | Область | Что ещё требуется |
| --- | --- | --- | --- |
| G01 | P1 | AI и Action Registry; PDF 26, 27, 28, 30, 55 | Нет рабочего финансового чата, Financial Relevance Gate, versioned AI Registry, minimum-context tools и защиты document/web prompt injection. Наличие обычного preview/commit API не реализует AI. |
| G02 | P1 | AI quota и документы; PDF 29, 30, 35, 54 | Нет рабочего учёта AI usage/cost/reserve, сообщений 80/95/100%, stateless provider adapter, local document page permissions и удаления финансовых результатов/чатов. Entitlement anchor реализован отдельно и не доказывает quota. |
| G03 | P1 | Бюджеты; PDF 22, 31, 32, 52 | GUI/storage budgets, periods, net/gross, versions, History/Undo и dependency repair реализованы. Analyzer/Registry, Overview widgets/references и real-environment acceptance остаются открытыми. |
| G04 | P1 | Обзор; PDF 21, 47 | Базовые KPI и category drilldown работают. Нет полного набора динамики/comparison/top widgets, конструктора, сохранённых layouts/views, независимого порядка mobile и связанных budget widgets. |
| G05 | P1 | Операции; PDF 23, 24, 47 | Поиск/review/exclusion, snapshot selection, карточка, bulk semantic edits и links/components реализованы. Не завершены desktop configurable table/columns, весь каталог фильтров, grouping/sorting, Saved Views и полный набор inline edits. |
| G06 | P1 | Импорт; PDF 18, 19, 20 | Известные локальные PDF/CSV/XLSX/OCR профили конечные. Нет unknown-format AI fallback, общего безопасного description profile, полного global/AI classification и final automatic transfer/refund linking. Нельзя считать любой банковский формат поддержанным. |
| G07 | P1 | Privacy acceptance; PDF 18, 26, 28, 30, 35, 54, 55 | Общий editable-text guard закрывает проверенные классы идентификаторов; это не доказательство универсальной sanitization. Нужен более широкий adversarial corpus и проверка каждого будущего AI/web/log outbound gate до включения внешнего AI. |
| G08 | P1 | Секреты и восстановление; PDF 35, 36, 44, 54 | Development envelope wrapping key не равен принятому внешнему KMS. Нет независимого deletion recovery journal/replay outside application backup, restore fail-closed, проверенного PITR/RPO/RTO/остатков backup. |
| G09 | P1 | Staging runtime и релиз; PDF 45, 46, 54, 55 | compose.staging.yml поднимает только PostgreSQL. API/import/mail entrypoints пока ограничены Development. Нет полной сборки среды с apps/workers, immutable release artifact, deploy/migration/rollback/smoke и owner acceptance на реальном сервере. |
| G10 | P1 | 10 000+ и нагрузка; PDF 23, 45 | loadFinance явно отклоняет >10 000 operations; UI получает весь graph, selection/bulk ограничены. Pure-core test на 10 001 факт проходит, но это не завершённый PDF-45.5 seed/runtime/performance scenario. Нужны paging, серверная фильтрация и нагрузочные/конкурентные измерения. |
| G11 | P1 | Maintenance/Monitoring; PDF 42, 43 | Нет рабочего maintenance scheduler, независимого uptime monitor/emergency control, incidents/degraded state machine и проверенного email/recovery при отказах инфраструктуры. |
| G12 | P1 | Реальный email; PDF 38, 39, 40, 41, 43, 50, 54 | Работают encrypted sandbox queues, leases/retries/deduplication и шаблоны. Реальный Postbox adapter, domain auth, доставляемость/security links и секреты провайдера не проверены. |
| G13 | P1 | Сервисы безопасности; PDF 40, 54 | Argon2id, CSRF/origin, cookie/TOTP/recovery/server permissions проверяются synthetic HTTP/PG. Нет completed Production TLS/CSP/proxy-IP acceptance, compromised-password policy и полного session/security-settings management; реальные password managers тоже требуют проверки. |
| G14 | P1 | Административные workflows; PDF 41 | Access/payment/invitations/renewal/manual grant/mail/audit foundation реализован. Не все разделы PDF-41: financial admin isolation остаётся обязательной, а maintenance/incidents/global rules/AI usage/provider settings/user deletion/support workflows ещё нужны. |
| G15 | P1 | Legal/Support/профиль; PDF 31, 37, 38, 39, 40, 47, 50, 54 | Тексты legal/versioned acceptance, seller/refund/support реквизиты и workflow, email change/полный user account deletion и режим deletion при expired/suspended access требуют отдельного завершения. Подключение Postgres само по себе их не закрывает. |
| G16 | P2 | Реальные устройства и Accessibility; PDF 18, 47, 48, 49 | Chromium desktop/mobile viewport не равен Safari/iOS или Android. Нужны реальные OCR/device memory/time/keyboard checks, screen reader, focus, contrast, touch targets, reduced-motion и визуальная acceptance всех рабочих экранов. |
| G17 | P1 | Кредиты/классификация; PDF 12, 13, 14, 15, 16, 17 | Core поддерживает cashflow/economic components и source/facet priorities. Полная кредитная полнота/предупреждения, все категории starter taxonomy и global/product/AI evidence, повторяемость персональных правил и бесконфликтная миграция будущих budgets/views ещё не завершены. |
| G18 | P2 | История и каскады будущих модулей; PDF 20, 34, 35, 36, 52 | Текущие financial tables/links/rules/imports/review очищаются и проверяются. Будущие AI chats/results, budgets, widgets, saved views, web caches и independent restore replay отсутствуют; нельзя объявлять cascade для этих модулей проверенным. |
| G19 | P2 | Import local worker; PDF 18, 54 | PDF.js/OCR используют workers, но CSV/XLSX extraction/preparation ещё не вынесены целиком в отдельный import Worker. Custom bounded CSV/XLSX reader заменяет рекомендованные PapaParse/SheetJS в узком профиле; это documented technical substitution, не отмена форматных требований. |
| G20 | P2 | Операционные статусы и источники; PDF 18, 20, 53, 55 | Wire/storage статусы accepted/processing/partial/invalidated и UI labels требуют завершённого соответствия публичной state machine; не считать совпадение enum единственным критерием. Исторические заметки registry/plan описывают старые этапы и не являются текущим evidence. |
| G21 | P1 | Внешняя acceptance; PDF 44, 45, 46, 54 | Текущая среда не имеет подтверждённого доступа к настроенному пользователем Timeweb host. Настройка владельцем идёт параллельно; инфраструктура не объявляется отсутствующей. После подключения проверить реальные роли/SSL/secrets/backups/KMS/monitoring/restore и owner acceptance с тем же artifact. |
| G22 | P2 | Overview/account visibility; PDF 11, 21, 23, 31, 32, 33 | Account analytics inclusion участвует в расчётах; defaultVisible/display defaults ещё должны последовательно управлять каждым экраном и Saved View. UI preference не должна менять финансовый source of truth. |

## Сверка 55 разделов

| PDF | Раздел | Наблюдение | Незакрытая работа |
| --- | --- | --- | --- |
| 1 | Назначение и статус документа | Сохранены неизменные PDF/Word, source manifest и утверждённая precedence A/B/E; по каждому clause есть индекс. |  |
| 2 | Резюме проекта | Репозиторий содержит Development foundations финансового ядра, import, доступа и интерфейса; полный продукт ещё не готов. |  |
| 3 | Основные продуктовые принципы | Сохранены integer money, source/corrections/effective layers, user-scoped permissions и conservative unresolved decisions. |  |
| 4 | Общая структура продукта | Рабочая оболочка имеет четыре раздела; синтетический demo не заменяет server workspace; общий core используется сервером. |  |
| 5 | Финансовая модель: почему банковской строки недостаточно | BankFact/corrections/Semantics/components/links разделены; reconciliation не переписывает source. |  |
| 6 | Сущность transaction | Transaction сохраняет источник и отдельные corrections/facets; проверены ownership, exact money и дата факта. |  |
| 7 | operation_kind и analytics_role | kind/role/confidence/source/userVerified независимы; neutral/unresolved исключены из income/expense. |  |
| 8 | Components, Links и Allocations | Components заменяют parent, allocations проверяют capacity/dependencies/verified conflicts. F01 устраняет зависимость результата от порядка конфликтных links. |  |
| 9 | Базовая логика учёта по типам операций | Refund действует в своей дате, cashback income, cash neutral, own transfer/debt neutral; partial remainder остаётся unresolved. Core проверен и на 10 001 факте. |  |
| 10 | Review Reasons: почему операции могут требовать внимания | Review reasons независимы; attention считает operation IDs; invalid required import row остаётся technical issue без вымышленной transaction. |  |
| 11 | Счета (Accounts) | Account aliases HMAC/user scoped; rename/type/analytics/loan mode и merge/split/rebinding имеют server commands и SettingsStructure UI. | G22 |
| 12 | Кредиты и кредитные карты | Cashflow/economic decomposition и кредитные allocations реализованы в core/operation editors; refund/reversal следуют противоположному знаку и своей дате. | G17 |
| 13 | Категории и подкатегории | Category/subcategory role/dependencies, rename/migrate/merge/delete работают через server preview/commit и structural UI. | G17 |
| 14 | Стартовый справочник категорий | Есть стартовые категории; полное соответствие taxonomy/глобальным правилам не объявлено. | G17 |
| 15 | Контрагенты | Counterparties/aliases/discovered/registered/ignored/self и merge/split поддерживаются server/SettingsStructure; банковские номера не отображаются. | G17 |
| 16 | Персональные правила классификации | Personal rule editor/parser/corpus поддерживает finite conditions/assignments, future apply, explicit existing snapshot и facet priorities. | G17 |
| 17 | Confidence, Source и Verification | Confidence/source/userVerified отдельно; independent verification и review conflicts проверяются core/HTTP. | G17 |
| 18 | Импорт банковских выписок | Local finite PDF/CSV/XLSX/OCR, password handling, WebCrypto/HMAC, strict server validation, durable acceptance/checkpoints реализованы. F02–F06 исправляют реальные privacy/parser/size/dependency дефекты. | G06, G07, G16, G19, G20 |
| 19 | Дедупликация | Source-only strict/fuzzy candidate matching, repeated same-file rows, one-to-one evidence, different-pair persistence и controlled duplicate merge/undo реализованы. | G06 |
| 20 | История импортов и отмена импорта | Import history/report/status/file scope и cancellation preview/commit сохраняют shared provenance, очищают unique rows и fencing generation. | G06, G18, G20 |
| 21 | Обзор (Overview) | Connected Overview использует server core totals/filter context, exact net/gross/refund explanations и category drilldown. | G04, G22 |
| 22 | Бюджеты | Persistent GUI budgets реализованы; см. [контракт](../architecture/budgets-periods-versions.md). Analyzer/Overview widgets и acceptance остаются открытыми. | G03 |
| 23 | Экран «Операции» | Connected Operations: поиск, attention/status/excluded, snapshot multi/range selection, bulk semantic edits, карточка, deletion и Review переход. | G05, G10, G22 |
| 24 | Карточка операции | Operation card: sanitized source/corrections/facets, links/components, duplicate decisions, exclusion/history/delete; user fields проходят shared local/server text guard. | G05 |
| 25 | Review Flow | Persistent Review sessions фиксируют IDs/progress, skip/back/pause/resume, групповой scope, independent facets; group mutation одна с Undo. |  |
| 26 | AI- Анализатор | Рабочего AI чата/gate/tools нет. Реализованный explicit Review в Analyzer не является AI. | G01, G07 |
| 27 | Action Registry Анализатора | Обычный backend mutation service проверяет permissions/preview/commit; versioned AI Action Registry и relevance/tool orchestration отсутствуют. | G01 |
| 28 | Интернет и актуальность внешних данных | Рабочего Analyzer web/freshness adapter и separate web privacy gate нет. | G01, G07 |
| 29 | AI- лимиты | Access cycle anchor/date math реализован; AI usage/quota/reserve/cost metering отсутствует. | G02 |
| 30 | Финансовые документы в Analyzer | Bank statement local import существует; financial document/page-to-AI flow и one-time permissions отсутствуют. | G01, G02, G07 |
| 31 | Настройки | Connected Settings содержат accounts/categories/parties/rules/structure/import history/financial history/deletion/reset и appearance; не все разделы продукта завершены. | G03, G15, G22 |
| 32 | Настройки аналитики | Analytics inclusion и loan mode изменяют общий core; настройки budgets/global/AI workflows пока не завершены. | G03, G22 |
| 33 | Настройки интерфейса | Theme/density/textSize/motion сохраняются как только визуальные preferences; financial content/keys/drafts не persist в browser storage. | G22 |
| 34 | Change History и Undo | 30-day History/deltas/recent restore/Undo проверяют conflicts, generation и dependency state; deletion/cancel/reset irreversible receipts не восстанавливают удалённые данные. | G18 |
| 35 | Данные и конфиденциальность | Local-first source contract не отправляет raw numbers/files/passwords; editable financial fields санитизируются. Wipe rotates key/generation; admin DB roles не читают finance. | G02, G07, G08, G18 |
| 36 | Исключение и физическое удаление | Exclusion отличается от physical deletion. Preview/commit, operation/period/account scope, dependency cleanup, key/generation fence и reauth full reset реализованы. | G08, G18 |
| 37 | Публичный сайт | Есть публичные/access entrypoints и synthetic application flows; окончательные legal/support/public content не приняты. | G15 |
| 38 | Тарифы и получение первого доступа | First-access proof, payment claims/operator decision, invitation registration и manual finite grants проверяются HTTP/PG. | G12, G15 |
| 39 | Продление доступа и ручные оплаты | Renewal/admin review/manual adjustments/access-cycle anchor и sandbox reminders реализованы; early renewal не сбрасывает monthly anchor. | G12, G15 |
| 40 | Авторизация, безопасность администратора и системные уведомления | Better Auth/Argon2id, verified email, tokens/sessions, server origin/rates, TOTP и E-04 recovery codes реализованы в Development. | G12, G13, G15 |
| 41 | Административная панель | Control origin/API/DB roles изолированы; TOTP capabilities и audit; payment/renewal/manual access/delivery UI работают, но административный продукт неполный. | G12, G14 |
| 42 | Технические работы (Maintenance) | Есть требования/runbooks; рабочего maintenance scheduling/runtime state machine нет. | G11 |
| 43 | Monitoring, Incidents и Degraded Mode | Есть архитектурные требования; external monitoring/incidents/degraded mode не реализованы и не приняты. | G11, G12 |
| 44 | Резервное копирование и восстановление | Backup/PITR/independent deletion replay/restore drill не выполнены на реальной инфраструктуре. | G08, G21 |
| 45 | Development, Staging и Production | CI поднимает isolated official PostgreSQL 18.4 и synthetic fixtures; это не полный Staging. >10 000 runtime load пока блокируется. | G09, G10, G21 |
| 46 | Процесс внесения изменений и релизов | Feature branches/stacked PR и automated checks используются. Production immutable promotion/migrations/rollback/smoke/owner gate ещё впереди. | G09, G21 |
| 47 | Mobile UX | Connected routes и desktop/mobile Chromium сценарии покрывают узкие workflows; full mobile layouts/device acceptance не завершены. | G04, G05, G15, G16 |
| 48 | Accessibility | Keyboard/focus/labels/dialog/appearance checks есть; полного WCAG/screen-reader/device acceptance нет. | G16 |
| 49 | Error States и Graceful Degradation | Import static errors, retry/idempotency/network uncertainty, stale responses, generation/access fencing проверяются; отсутствующие AI/infra failures не приняты. | G16 |
| 50 | Поддержка | Полноценный support workflow и реальные контакты/доставка не завершены. | G12, G15 |
| 51 | Матрица подтверждений | Direct reversible edit/Review vs impact confirmation/destructive full reset имеют отдельные server guards и UI paths. |  |
| 52 | Матрица зависимостей сущностей | Текущие graph/import/rules/review/history dependencies проверяются; budget и Operations view dependencies подключены; будущие widget/AI-result зависимости требуют нового cascade. | G03, G18 |
| 53 | Основные State Machines | Access/invitation/payment/import/Review state machines реализованы частично; maintenance отсутствует, enum mapping не равен полной acceptance. | G20 |
| 54 | Открытые решения технического этапа | Node24/TS/React/Fastify/Postgres/pg-boss/Better Auth/OCR выбраны. E уточняет стек/provider/SMS; legal/retention/RPO/RTO и Production security остаются открытыми. | G02, G07, G08, G09, G12, G13, G15, G19, G21 |
| 55 | Технический справочник и итоговые правила | Core types перечисляют financial kinds/roles/sources/links/components; full privacy/AI/release checklist частичен. | G01, G07, G09, G20 |

## Принятый приоритет приложений и открытые решения

PDF остаётся основным. A-01…A-11 / B-01…B-10 применяются только в уточнённом объёме; E имеет приоритет над конфликтующими техническими C/D. E-04 сознательно заменяет обязательный admin SMS recovery кодами и не допускает email/Telegram bypass. E-05 фиксирует provider candidates, но не закрывает privacy/quality/delivery trials. E-08 не становится выполненным от прохождения CI. C/D исторические prices не представлены как актуальная смета, покупок не было.

Приложение A — 9 указателей на встроенные диаграммы; отдельно проверена связь с соответствующими clauses и confirmation matrix 51. A-11 редакционно уточняет схемы без изменения финансовой модели. Word содержит исторический контекст, не добавляет новый override; все 30 разделов сохранены в matrix.

## Границы доказательств

Автоматические tests подтверждают перечисленные сценарии и Development foundations. Не выполнены полноценный независимый pentest, реальные iOS/Android OCR benchmarks, legal acceptance, provider trials, cloud restore/PITR/KMS/monitoring и full Staging/Production promotion. Это явно незакрытые пункты, а не скрытые успешные проверки.

Настройка Postgres и остальных сервисов владельцем идёт параллельно. Этот аудит не утверждает, что сервер отсутствует или что его конфигурация уже проверена: у текущего процесса нет подтверждённого подключения к этому host. Следующий инфраструктурный этап должен проверить конкретное окружение и тот же одобренный artifact. Код, synthetic тесты и сопоставление PDF выполняются независимо от него.
