# Полный финансовый сброс — пятый серверный блок этапа 4

Основание: полный PDF 11.3, 35.11, 36.2–36.7, 51.3–51.4; approved A-02/A-06/B-03 и C-07 в рамках Development. PDF/Word/baseline 1.3 неизменны. Ветка основана на `feature/exclusions-history` (PR №16). Реализован серверный сброс текущих поддержанных таблиц и жизненный цикл ключа; весь этап 4 и Production не объявляются завершёнными.

## Сценарий и подтверждение

GET `/finance/epoch` возвращает собственные generation/revision, keyVersion и interfaceEpoch без загрузки финансового графа. Он позволяет подготовить сброс, даже если граф больше текущего лимита обычного `/finance/state` в 10 000 операций.

POST `/finance/preview` принимает обычные `actionId/generation/revision` и intent:

```json
{"kind":"reset_financial","keepCategories":true,"keepRules":true,"keepInterface":true}
```

Все три решения обязательны и булевы. Scope — все финансовые данные текущего пользователя. Preview перечисляет точные counts operations/observations/components/links/accounts/aliases/counterparties/source bindings/history/prepared contexts и удаляемых categories/rules, число сохраняемых настроек и правил, которым потребуется перенастройка. Он сообщает irreversible delete, reimport warning, смену ключа и инвалидирование старых загрузок. Preview не удаляет данные, не меняет ключ и не сохраняет банковские факты, суммы, тексты или списки удаляемых IDs. Для проверки неизменности он хранит private SHA-256 fingerprints текущих строк и workspace context; они очищаются после успеха.

Окончательный POST `/finance/commit` требует `{actionId,confirmReset:true}`. Для сброса необходима действующая собственная session с входом не более пяти минут назад (тот же Development fresh age, что и auth foundation). Старой session нужен `password` в этом же окончательном запросе; пароль проверяется Argon2id по собственному credential. Его нет в intent/history/audit/receipt. Пять password proof попыток за пять минут на пользователя сохраняются вне откатываемой транзакции и не обходятся сменой IP. UI объединит password proof и окончательное подтверждение в один шаг; дополнительный бессмысленный confirmation не вводится.

Permissions/verified email/active entitlement, generation/revision/preview expiry, object fingerprints и workspace config revision проверяются перед выполнением. Превью устаревает также при новой подготовке загрузки или новой записи history после показа counts. При конфликте ничего не удаляется: нужен новый просмотр. Повторный commit выполненного action возвращает прежний metadata-only receipt без повторного сброса/ротации. Сброс не имеет Undo и не отменяет оплату/доступ/identity account или его sessions.

## Что очищается и сохраняется

Одна транзакция удаляет links, все operations/source observations и активные/неактивные components, account/CP source bindings, все aliases/accounts/counterparties (включая merged cards), все прежние action previews/results/journals и deletion receipts, prepared ingestion contexts. Categories/rules удаляются либо сохраняются по явному выбору. Системный loan mode возвращается к cashflow.

У сохранённых rules удаляются ссылки conditions на accounts/CP и assignments на CP. При удалении categories удаляются category/subcategory assignments. Такое правило отключается и получает `needs_setup` («Нужно настроить привязку»); удалённые IDs не остаются в конфигурации. Оно не продолжает работать с молча расширенным условием. Независимые merchant rules и прежнее enabled/disabled состояние сохраняются. Сохранённые categories не переименовываются и не пересоздаются.

При `keepInterface:false` меняется interfaceEpoch, при true он сохраняется. Это серверный сигнал будущему подключённому UI сбросить свои настройки. Нынешняя демонстрационная финансовая оболочка ещё не слушает API; reset её локальных настроек, диалогов и примеров этим серверным блоком не заявляется. Они будут подключены на этапе рабочих экранов. Прежний frontend не хранит HMAC key.

Receipt содержит counts, preservation choices, служебные revisions/epochs и факт необратимости; не содержит старых object IDs, amounts/text/HMAC, private fingerprints, before/after deltas или ключей. Для другого пользователя данные и ключ остаются прежними. Проверка 10 001 операции подтверждает работу сброса выше обычного graph limit; крупные объёмы, latency/locks, фоновые chunks/progress и recovery journaling ещё требуют отдельных испытаний.

## Ключ и подготовка импорта

Migration 0010 вводит `protected_keys.pseudonym_key`: один текущий криптографически случайный 256-bit key на пользователя. Его ciphertext находится отдельно от финансовых таблиц, имеет envelope encryption с новым DEK/nonce и проверяемую привязку purpose/user/version внутри зашифрованного payload. SQL capabilities ограничены текущим tenant и ожидаемыми generation/key version; direct SELECT protected schema не выдан даже finance API. Control/mail не имеют доступа ни к таблице, ни к capabilities. Runtime UPDATE keyVersion заблокирован trigger; ротация выполняется только через scoped definer capability.

POST `/finance/import-context` принимает `{contextId}` и только после собственного verified active session возвращает `contextId/generation/keyVersion/key/algorithm/keyBytes/expiresAt`. Key предназначен исключительно локальной подготовке в памяти, не для AI/телеметрии/logs/localStorage/IndexedDB. Ответ имеет no-store; серверные request/auth loggers отключены. Это не bank upload и не Analyzer tool. Одинаковый пользователь на разных устройствах получает тот же текущий key; другие пользователи — независимые keys. Нормальная подготовка/повторный импорт и выборочное удаление не ротируют key. Full reset атомарно заменяет ciphertext текущего key, generation и keyVersion новым контекстом. Ротация сама по себе не заменяет выполненное удаление остальных данных.

Prepared contexts не содержат файлов, names, numbers, normalized rows или bank fragments. Development TTL — 30 минут, до 100 активных contexts; expired/invalidated contexts очищаются при следующей подготовке, превышение даёт `IMPORT_CONTEXT_LIMIT`. Это контекст local preparation, а не реализованный import batch или финансовая очередь.

Все внутренние source/account/alias acceptance primitives теперь требуют **обе** версии (`generation`, `keyVersion`); прежнего generation-only контракта нет. Будущий Import/worker использует `withPreparedImport` в одной DB transaction: проверка собственных context ID, generation/key version и срока до записи и после неё. Общий lock order access cycle → finance workspace сериализует acceptance и wipe. Старый job/payload не может после wipe добавить transaction, alias, component/link через action или cache в той же транзакции. Нет raw fallback или автоматического пересанитизирования старого payload под новую версию.

`IMPORT_CONTEXT_CHANGED` предлагает «Данные были сброшены на другом устройстве. Загрузите файл заново»; истёкшая подготовка имеет отдельный `IMPORT_CONTEXT_EXPIRED`. Новый import должен заново выполнить локальные sanitization/HMAC с текущим key. Уже исполняющаяся атомарная acceptance либо завершается до reset и входит в проверяемый scope, либо делает старый preview неактуальным; она не пишет после reset под старым контекстом.

## Проверки и миграция

27 новых PostgreSQL18/HTTP сценариев: стабильность/разделение ключей, concurrent initialization/idempotency, role/tenant isolation и tampering, auth/access, точный preview и confirmation, все восемь preservation combinations, merchant/scoped rules, полный cascade и inactive parts, metadata-only history, old generation/key version/foreign/expired contexts, fresh reimport, selective delete key stability, повторный commit, source acceptance recheck/rollback и гонка с reset, revoked/expired/stale confirmations, out-of-protocol update, new preparation after preview, второй пользователь, 10 001 operation, recent auth и durable password-proof limit. Старые DB suites адаптированы только к обязательной key version; прежние assertions сохранены. Полные hashes/types/builds/core/browser checks запускаются в GitHub, exact-head evidence добавляется в PR.

После migrations 0001–0009 Development operator: `APP_ENV=development` и loopback `MIGRATION_DATABASE_URL`, `pnpm --filter @finance/api operator migrate-financial-reset`. Миграция транзакционная; до неё новая API-сборка не выпускается. Для невыпущенного Development rollback — прежняя сборка/disposable snapshot, без удаления настоящих данных. Production KMS adapter и процедура миграции/forward fix/restore acceptance ещё не приняты.

## Оставшиеся границы

Development использует существующий KEK adapter, а не реальный provider KMS. Не обещается физическая zeroization всех JS/HTTP/browser копий key. Backups, historical key destruction/retention, независимый durable deletion journal и replay при восстановлении должны быть реализованы до Production.

Actual parsers/OCR/dedupe, HMAC namespaces/canonicalization, local worker cancellation/logout, реальная import queue и отмена batch — этап импорта. Они обязаны использовать этот versioned contract и подключить собственные copies/jobs к deletion service; текущая очистка prepared contexts не доказывает очистку ещё не существующих import queues/blobs. Chats/AI/documents/caches/budgets/views/widgets и внешние provider copies будут иметь собственные cascade handlers. Full user account deletion и его sessions/access/payment consequences — отдельный блок. Рабочий UI, nested derived endpoints, scheduled retention, пагинация, нагрузка, реальное размещение и Staging acceptance также впереди. Registry остаётся partial.
