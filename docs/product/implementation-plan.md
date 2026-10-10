# План разработки сайта

Основа: согласованная версия 1.3. Этот план определяет порядок реализации; действующие правила заданы полным PDF, изменениями A/B и частью E в указанном в source-manifest объёме.

## Что уже есть

Актуальная интерфейсная версия на 7 октября 2026 года:

- Закрытый личный репозиторий владельца: https://github.com/bna42rus/Financial-AI-Analyzer. Сохранилась исходная история из двух коммитов.
- Исходные PDF/Word, версия 1.3 и согласованная техническая основа.
- Структура будущего сайта, серверной части, админки и фоновых обработчиков.
- Небольшая библиотека точных денежных сумм и проверки суммы частей операции.
- Проверка неизменности исходных документов и 10 тестов денежных primitives прошли локально.

Все четыре базовых экрана, окна загрузки/профиля и переходы к истории приняты и объединены с main через PR №2–6. Main после PR №6: `bf3e2db1e6314c84c8e28df8d9c71cbb2af21ac4`; все 88 проверок этой версии прошли в GitHub.

Этап 1 и первая интерфейсная версия этапа 2 приняты. Начат первый блок этапа 3: модель первого доступа, тестовая заявка и отдельная админка сверки оплат/подготовки приглашений. [Результат и границы](../architecture/access-admin-requests.md). Второй блок реализует Development API/DB/auth foundation с verification/application session, TOTP/recovery и reset/invalidation; [границы и security tests](../architecture/server-access-security.md). Третий Development блок подключает UI к API, manual review и invitation registration/activation. Почтовая доставка, real owner onboarding и renewal ещё предстоят. Полные финансовые требования, импорт и AI также не реализованы интерфейсной версией. Подписка Pro, защита ветки и реальные подключения сервисов не подтверждены одним наличием репозитория.

## Порядок работы

Первый блок этапа 5: [локальная подготовка и серверная validation](../architecture/import-preparation.md). Реализован text-free versioned contract с per-user HMAC, row issues и защитой prepared context; validation route не создаёт financial transactions. Этап 5 целиком не закрыт.

Второй блок этапа 5: [server acceptance/provenance/source-only dedupe](../architecture/import-ingestion.md). Durable batches/files/row issues, account alias matching, stable bank ID/one-to-one same-file instances, Possible Duplicate, checkpoints/retries/one-active-batch и privacy cascade. Следующий блок — проверенные bank adapters и безопасный source-text profile: text-free недостаточно для полноценного strict fingerprint/source restoration. Cancellation/remembered dedupe decisions/final classification-link pass/рабочий UI впереди. Источники неизменны, registry partial; результаты CI конкретного коммита в PR.

| Этап | Что делаем | Что можно проверить | Условие завершения |
| --- | --- | --- | --- |
| 1. Основа и список требований | Проверяем доступ, историю и документы; создаём список реализации и проверок | Материалы версии 1.3 доступны в закрытом проекте; изменения сохраняются; результаты проверок читаются | Успешный цикл изменения в отдельной ветке и автоматической проверки; все разделы PDF и согласованные изменения учтены |
| 2. Первая версия экранов | Создаём четыре раздела: Обзор, Операции, Анализатор, Настройки; кнопки загрузки и профиля; историю внутри Настроек и доступ из Операций | Переходы, понятные пустые экраны, мобильное отображение и клавиатура | Сайт запускается в Development; тестовые примеры включаются отдельно и не создают фиктивные операции в новом аккаунте |
| 3. Доступ и защита | Реализуем заявку, подтверждение email, ручную проверку оплаты, приглашение, регистрацию, вход и отдельную админку | Новый посетитель проходит согласованный путь; доступ одного человека не открывает данные другого | Сервер проверяет полномочия; старые сессии прекращаются после сброса пароля; TOTP и резервное восстановление администратора проверены |
| 4. Финансовая основа | Реализуем операции, счета, категории, контрагентов, правила, связи и части операций | Покупки, доходы, собственные переводы, возвраты, компенсации, наличные, кредиты и отмены правильно учитываются | Исходные банковские факты и решения пользователя разделены; нет двойного учёта; спорный остаток виден |
| 5. Импорт | Реализуем локальное чтение файлов, очистку реквизитов, обработку форматов, поиск дублей, историю и отмену импорта | Повторная выписка не дублирует записи; две одинаковые реальные покупки сохраняются; проблемные строки объясняются | Проверены пересекающиеся выписки, частичный успех, отмена и загрузка после полного сброса с другого устройства |
| 6. Рабочие экраны | Подключаем реальные расчёты к фильтрам, таблице, карточке операции, пошаговому разбору, графикам и бюджетам | Можно исправить операции и увидеть изменение итогов; открыть объяснение любой суммы | Обзор, бюджеты и Анализатор используют одну финансовую логику; история 30 дней и конфликты отмены проверены |
| 7. Анализатор | Реализуем разрешённые текстовые запросы и действия, контекст диалогов, документы, внешний поиск и лимиты | Запрос с другими датами имеет приоритет над верхним фильтром; изменение показывает нужное подтверждение | AI не получает произвольный доступ к базе; права проверяются перед показом последствий и выполнением; удалённые данные исчезают из зависимых ответов |
| 8. Реальные сервисы | Испытываем модели Yandex AI Studio, Postbox и выбранное размещение Timeweb; согласуем открытые параметры и точную смету | Реальные письма доходят; модель выполняет проверочные задачи; тестовый сайт обновляется и восстанавливается | Подтверждены доступ агента, приватность, доставка, качество и расходы; платные услуги подключаются только после отдельного решения владельца |
| 9. Общая проверка | Проходим все требования, безопасность, работу на телефоне, сбои, резервное восстановление и нагрузку | Владелец проверяет целые сценарии на отдельном тестовом сайте с искусственными данными | Есть результаты автоматических и ручных проверок; нет незакрытых обязательных требований; определены legal/retention/RPO/RTO и другие условия запуска |
| 10. Настоящий запуск | Готовим конкретную проверенную сборку, настройки домена, миграции и план восстановления | Владелец видит, какая версия выпускается и как её восстановить при проблеме | Production публикуется отдельным действием после принятия Staging и разрешения владельца; выпускается та же проверенная сборка |

Этапы обозначают зависимости, а не водопад: тесты и проверки добавляются вместе с функциями. Проверка моделей, доставки писем и инфраструктуры может идти параллельно с завершением остальных функций после появления соответствующих безопасных интерфейсов. Пока реальные аккаунты или бюджет недоступны, применяются явно обозначенные тестовые заменители; они не подтверждают готовность настоящего подключения.

## Как проверяем

1. GitHub запускает автоматические проверки при изменениях. Начальные проверки источников и денежных primitives прошли. Для первого экрана workflow дополнен типами, UI-расчётами, сборкой и браузерными сценариями. По мере реализации добавляются проверки базы, API и безопасности.
2. Агент запускает сайт и проверяет реальные действия в браузере и через API на искусственных данных.
3. Владелец открывает отдельный тестовый сайт и проверяет понятность и удобство. Тестовая ссылка появится после настройки запуска и доступа; наличие документов в GitHub такой ссылкой не является.

Зелёная проверка означает успех только перечисленных проверок. Она не означает готовность всего сайта. Готовность определяется [списком реализации](implementation-checklist.md), доказательствами проверок и принятой тестовой версией.

## Ближайший результат

После приёмки интерфейса начат этап 3 — доступ и защита: заявка, подтверждение email, проверка оплаты, приглашение, регистрация, вход, восстановление пароля и отдельная админка. Серверные проверки прав и разграничение аккаунтов реализуются вместе с этими сценариями. Покупки услуг и Production остаются отдельными решениями владельца.

### Первая версия Настроек

[Экран и результаты проверки](../architecture/web-settings.md). Добавлены десять разделов, поиск, параметры оформления, сброс и точные переходы к операциям. Настройки финансовой логики пока для чтения; полноценные редактирование, persistence, API/права и история/удаление предстоят.

### Загрузка, профиль и история

[Окна и границы реализации](../architecture/web-shell-completion.md). Кнопки загрузки доступны из всех экранов и пустых состояний. Выбор файлов не означает импорт. Профиль содержит аккаунт, безопасность, доступ, поддержку и рабочую быструю смену темы. История доступна из списка и карточки операции с явной выборкой; настоящие history/Undo предстоят.

### Первый доступ и админка

[Модель, интерфейс и границы](../architecture/access-admin-requests.md). Этот блок представлен для проверки на synthetic примерах. Development server/DB/auth foundation с verified-email application session, обязательными TOTP/recovery codes админки и reset/invalidation реализован в PR №8; real DB evidence фиксируется в нём. Третий Development блок — UI/API, transactional invitations/registration/activation; далее renewal и доставка.


Третий Development блок: [оплата, приглашения, регистрация и UI/API](../architecture/invitation-registration.md). Реализованы server preview/commit, independent email proof и activation; real mail delivery, owner onboarding и Production остаются впереди. Результаты real PostgreSQL/HTTP/browser checks фиксируются в PR; источники не изменены.


Четвёртый Development блок: [продление доступа](../architecture/access-renewal.md). Own verified-session заявки, change/cancel до claim, отдельная TOTP admin очередь, server preview/commit, canonical paid cycle, A-01 restoration/B-06 calendar anchor, suspension independent, RLS и transactional no-double-extension. Реальные reminders/delivery/оплаты, manual grants/refunds и AI usage/quota впереди; registry partial, источники неизменны. Exact-head проверки фиксируются в PR.


Пятый Development блок: [ручная выдача и изменение доступа](../architecture/manual-access.md). Отдельные manual grants/invitations, fixed/indefinite policy, индивидуальная компенсация и корректировка end; TOTP, preview/revision/action IDs, canonical session, metadata-only admin directory, атомарный audit/outbox. Деньги не выдумываются, suspension/usage не сбрасываются. Mass compensation, actual mail/AI/runtime/hosting и полный release acceptance впереди; exact-head checks фиксируются в PR.


Шестой Development блок: [письма, доставка и напоминания](../architecture/mail-notifications.md). Encrypted outbox → отдельные scoped pg-boss workers → durable synthetic inbox; queued/sent/failed, backoff/leases/crash handling, TOTP admin resend/audit, реальные HTTP/browser сценарии через доставленное письмо, reminders из текущего доступа. Реальная Postbox доставка, обслуживание почтового домена, будущие maintenance/email-change события и release acceptance впереди. Источники неизменны, registry partial.

Этап 4, первый серверный блок: [финансовая модель и общее ядро](../architecture/finance-foundation.md). Собственные accounts/categories/counterparties/rules, append-only source observations и отдельные corrections, signed components/allocations, canonical totals, частичные возвраты/own transfers и loan modes. Generation/revision, backend access/RLS, preview/commit, idempotency и ограниченный Undo. Импорт, entity migrations/deletion, nested derived links, broad exclusions и подключение рабочих экранов следуют отдельными блоками; финансовая основа в целом ещё не завершена. Exact-head проверки фиксируются в PR.

Этап 4, второй серверный блок: [account Merge/Split и выборочное удаление](../architecture/account-structure-deletion.md). Отдельные source bindings/aliases сохраняют bank facts; явное распределение, dependency/rule status, preview/commit и консервативный Undo. Удаление операций/периода/account очищает текущие financial copies, не удаляет surviving refunds за scope и блокирует старые payloads. Full reset/HMAC rotation, остальные entity migrations, UI и будущие imports/Analyzer/blob cascade впереди. Exact-head проверки фиксируются в PR; источники неизменны, registry partial.

Этап 4, третий серверный блок: [категории и контрагенты](../architecture/category-counterparty-structure.md). Category Merge/Delete/hierarchy-role migration, CP source/alias Merge/Split и card delete отличаются от физического удаления финансового scope. Явные role decisions, dependencies/rules, versioned preview/commit и консервативный Undo. UI, budgets/widgets/views, discovery/import cancellation, full reset/HMAC rotation и будущие module cascades впереди. Источники неизменны, registry partial; exact-head проверки фиксируются в PR.

Этап 4, четвёртый серверный блок: [исключения и выборочная история](../architecture/exclusions-history.md). Явные operations/filter/confirmed-chain overrides сохраняют данные, History хранит before-after delta и показывает object/dependency conflicts. Одиночный и выбранный rollback атомарны и не мешают unrelated edits. Deep delete очищает новые journal/index copies. UI, automatic Import/AI grouping, scheduled retention, full reset и future-module cascades впереди; источники неизменны, registry partial. Exact-head результаты в PR.

Этап 4, пятый серверный блок: [полный финансовый сброс и версия ключа](../architecture/financial-reset.md). Count-only preview, обязательное подтверждение и recent authentication, выбор сохранения categories/rules/interface epoch, атомарная очистка поддержанных copies и ротация защищённого per-user key. Source acceptance проверяет generation и key version, prepared contexts инвалидируются, старые payloads не восстанавливают данные. Рабочий UI, actual Import/queue/parser/canonicalization, nested derived endpoints и production deletion/backup replay впереди. Registry partial; exact-head результаты в PR.

Этап 4, шестой серверный блок: [связи производных частей](../architecture/derived-allocations.md). Явные allocation endpoints, несколько поколений reversals, точные terminal-part totals, category/loan/source recalculation, shared capacities и отказ повторному matching. Deferred tenant-bound references, single/bulk Undo dependency checks и transitive selective-delete cascade. Рабочий UI, actual Import/queue/parser/dedupe/cancellation, automatic matching и Production acceptance впереди. Registry partial; exact-head результаты в PR.

Этап 5, третий блок: [локальные PDF-парсеры](../architecture/local-bank-parsers.md). Поддержаны наблюдаемые структуры Т-Банка, Ozon и обеих форм Сбера, отдельные даты/знаки/RUB, локальный пароль и очистка reader/session, text-free payload и конкретные parser versions. Payment-account contract не означает кредит. Другие форматы/OCR, safe descriptions, strict dedupe, cancellation, classification/links и live UI впереди; coverage partial, источники неизменны. CI evidence в PR.

Этап 5, четвёртый блок: [конечный safe source profile](../architecture/safe-bank-source.md). Versioned event/merchant codes, независимая серверная проверка, canonical sanitized labels, append-only source enrichment с защитой verified edits и текущими personal rules. Справочник намеренно ограничен; произвольные описания/неизвестные магазины, полноценные fingerprints и live UI впереди. Registry остаётся partial, baseline 1.3 и оригиналы неизменны.

Этап 5, пятый блок: [рабочая загрузка PDF и восстановление результата](../architecture/live-import-ui.md). Authenticated выбор файлов автоматически запускает локальную подготовку; сервер получает только закрытый sanitized payload. Пароль используется локально, сетевой повтор сохраняет batch ID, server accepted сохраняется в истории и background worker продолжает после закрытия браузера. Результат разделяет canonical operation counts, технически непрочитанные строки и semantic review; операции/счета/итоги читаются из финансового API. Полное редактирование/review, другие форматы/OCR, cancellation принятого batch и final classification/links остаются впереди. Registry partial; exact-head CI evidence в PR.

Этап 6, первый интерфейсный блок: [проверка и редактирование сохранённых операций](../architecture/live-operation-review.md). В рабочей карточке подключены восемь editable fields, независимое подтверждение facets, pre-request sanitization, server edit и Undo. Correction mode сохраняет источник, показывает server before/after и требует explicit commit. Coherent epoch, current/attempted conflict UI, безопасный delta rebase и тот же action ID при сетевом повторе защищают новые изменения. Полные inline/bulk/History/Review, links/components/duplicate editing и Analyzer остаются впереди; coverage partial и exact-head CI evidence в PR.

## Сверка полной спецификации 9 октября 2026

В отдельной ветке выполнен аудит 455 записей полного PDF, 39 согласованных A/B/C/E и контекста Word. [Результат, исправления и оставшиеся требования](../audit/spec-screen-audit.md), [полная матрица по пунктам](../audit/spec-screen-matrix.json). Сохраняемая рабочая версия теперь имеет 4 основных экрана, 10 вложенных Настроек, общие серверные фильтры, исправленные подписи финансового смысла/банковские даты, History/Undo и доступные настройки справочников. Это не закрывает полный этап и не означает готовность к Production.

Прошли 292 локальные проверки, включая полный web UI (82 сценария) и admin UI (16). Владелец явно разрешил сохранение подготовленных исходников, тестов, аудита и synthetic скриншотов в приватный bna42rus/Financial-AI-Analyzer, создание PR и полный CI. Результат PostgreSQL/HTTP CI окончательного коммита фиксируется в PR; этот блок не объединяет ветку с main и не выпускает Production.

Пока владелец занят Timeweb, разработка на synthetic данных продолжается. Следующий основной блок этапа 5 — полная отмена batch/file с source restoration/provenance/privacy cascade и строгая cross-file дедупликация/запоминание решений. В связке с этим нужны рабочие links/components/rules/structural editors и полный Review; далее budgets, полный Operations/Overview и Analyzer Registry/quota/provenance. Внешние подключения остаются в согласованном порядке E; финальный Staging deployment/rollback/restore и owner acceptance ещё требуются.


## Следующий блок импорта — отмена и finite strict fingerprint

В `feature/import-cancellation-dedupe` от PR №25 добавлены preview/commit отмены batch/file, unique/shared restoration и direct source evidence, private metadata receipt без Undo, сохранение remaining jobs/пустых accounts, History filters и переходы к surviving operations. Exact-instant finite-profile fingerprint и persistent «разные операции» используют source facts; полная дедупликация произвольных descriptions и duplicate Merge с B-07 ID/Undo ещё открыты. [Границы и проверка](../architecture/import-cancellation-dedupe.md). Фактический полный CI окончательного коммита — в PR; main/Production не меняются.

Следующий финансовый блок: duplicate merge/review и рабочие links/components/rules/structural editors, расширенный безопасный source profile и corpus; затем budgets и полный Operations/Overview/Analyzer. Shared cancellation legacy imports без записанного собственного evidence блокируется до проверки происхождения. Инфраструктура настраивается отдельно; новый runtime требует operator migration 0014.

### Development: объединение дубликатов после PR №26

В `feature/duplicate-merge` добавлены явный canonical ID и выбор банковского source, выбор существующих ручных значений, dependency preview для links/components, сохранение immutable original instances через tenant-scoped ID aliases, 30-day checked Undo, canonical-aware import/dedupe/cancellation/deletion. [Детали и границы](../architecture/duplicate-merge.md). Требуется operator migration 0015 после 0014; старый runtime не является безопасным rollback после первого merge. Фактический CI этой версии фиксируется в PR. Следующий блок — полноценные review/links/components/rules/structural workflows и расширенный безопасный source corpus; budgets/Operations/Overview/Analyzer и Staging acceptance остаются по плану.

В `feature/deletion-reset-ui` подключены [физическое удаление и полный финансовый сброс](../architecture/deletion-reset-ui.md) поверх PR №30. Exact scope/count preview, обязательные preservation choices, recent password proof в том же подтверждении, exact network retry, очистка локального рабочего состояния и interface epoch. Full user account deletion, Production backups/replay, будущие module cascades и Staging acceptance остаются открыты. Exact-head CI фиксируется в PR после завершения.


### Development: расширение импорта и групповой Review после PR №31

В `feature/import-review-expansion` добавлены [20 canonical merchants, локальная keyed description identity и групповые предложения Review](../architecture/import-review-expansion.md). Profile/adapter версии 2 сосуществуют со старыми закрытыми payloads; strict source dedupe сохраняет one-to-one и date-only ambiguity. Предложение показывает fixed session scope, backend повторно проверяет session/current anchor/version/сходство и сохраняет один action/Undo. Требуется migration 0017; после первого нового import rollback требует совместимого reader/worker или forward-fix. Результаты полного CI и визуальной проверки конкретного head фиксируются в PR. CSV/XLSX/OCR, arbitrary sanitized descriptions/fuzzy corpus, final classification/link pass, полный AI/Registry, budgets/Operations/Overview и Staging acceptance остаются следующими самостоятельными блоками.

### Development: локальные таблицы и OCR после PR №32

В `feature/local-tabular-ocr` добавлены [CSV/XLSX, local OCR и конечные cash/transfer signals](../architecture/local-tabular-ocr.md). Самоописывающиеся таблицы не требуют mapping wizard; неизвестные структуры блокируются до будущего AI fallback. OCR assets строятся из pinned dependencies и загружаются только с того же сайта, cache выключен; OCR не создаёт merchant/strict description evidence. `bank-local/1` / `bank-source/3` сохраняют legacy readers и записывают parser на каждую source observation. Migration 0018 после 0017 обязательна; после первого нового import нужны compatible reader/worker или forward-fix. Exact-head CI и screenshots фиксируются в PR. Реальные bank exports, mobile Safari/device corpus, arbitrary sanitized descriptions, unknown-format AI fallback и final classification/link matching остаются открыты.
