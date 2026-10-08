# Приём и сохранение импорта — второй блок этапа 5

Основание: PDF 18–20, 35–36 и approved A-02/A-05/A-06/B-03/B-08. Основа `feature/import-preparation`, PR №19, `f2ca98b13f4666a80dcb0c970a31e4734edd4538`. Источники PDF/Word и baseline 1.3 неизменны. Новая ветка `feature/import-ingestion`; main/Production не изменяются. Registry partial.

## Граница

Сервер принимает только проверенный normalized contract `text-free/1`. Нет реальных bank PDF/CSV/XLSX adapters, OCR, открытия защищённых файлов, safe merchant/description profile или AI. `source-adapter/1` — версия контракта, не поддержка конкретного банка. Это основа сохранения, не готовая функция загрузки выписки. Полноценный strict fingerprint и A-05 source restoration требуют следующего профиля с проверенными очищенными текстами. Фактический statement period отсутствует во входном contract и не выдумывается.

## Приём и checkpoint

POST `/finance/import-accept` проверяет verified active own user/entitlement, Origin/session/rate limits, generation/keyVersion, свежий собственный context и закрытый contract. После атомарного сохранения возвращает 202 `stage: server_accepted`. POST `/finance/import-status` с `{batchId}` возвращает count-only результат своего batch. Нет отражения money/dates/text/HMAC/key/filename/password/raw file. Development guard 512 KiB/10 файлов/1000 строк относится только к accept/validation; остальные маршруты сохраняют 8 KiB.

`ingestion_batch` хранит epoch/versions/status/idempotency digest; `ingestion_file` — bank, file HMAC, позицию и row count; `ingestion_row` — ordinal и временно validated canonical row либо технический issue; `ingestion_account` — обнаруженные счета. После обработки row payload удаляется и сохраняется связь с append-only observation. Это durable transaction/file/ordinal provenance и created/reused/updated effect для будущей cancellation. Каждый новый import добавляет observation даже при unchanged facts.

Partial unique index и locks access-cycle → workspace разрешают одну active загрузку на user. Тот же batchId/canonical payload возвращает текущий outcome; изменённый payload конфликтует. После server acceptance retry уже не зависит от local TTL, но проверяет access/epoch. Новый contextId той же epoch не меняет digest. Повтор fileId в другом batch запрещён. Acceptance увеличивает workspace revision, инвалидируя старые финансовые previews.

Отдельный `dev:imports` worker использует scoped Development `finance_api`. Durable `ingestion_dispatch` даёт scheduler только tenant/batch IDs/retry metadata. Это единственный межпользовательский SELECT queue metadata; financial tables сохраняют FORCE RLS. Control/mail/Public не имеют grants. Каждая стадия повторно проверяет access/epoch и обрабатывает максимум 50 строк в одной транзакции. Два workers сериализуются. Перезапуск продолжает pending rows, ошибка полностью откатывает checkpoint и оставляет retry через 60 секунд без exception/SQL/payload logs. После принятия браузер не требуется, но отдельный worker должен работать. Production orchestration/monitoring/отдельные worker credentials ещё впереди.

## Счета, source matching и corrections

Счёт находится по source alias kind/HMAC и bank. Новый alias автоматически создаёт системный счёт; loan-contract получает `loan`, card/bank-account — `other`, потому что профиль не доказывает debit/credit subtype. Полных или masked digits/HMAC в имени нет. User name/type не перезаписывается. Несогласованный alias bank становится `ACCOUNT_MATCH_CONFLICT`, другие строки продолжают обработку. Merge/split assignment применяется отдельно от bank facts.

Matching использует immutable observations/source aliases, а не effective edits. Один transaction используется максимум один раз на file, в том числе через checkpoints:

1. Same file HMAC + ordinal + одинаковые source facts узнают конкретный instance; файл целиком никогда не подавляется.
2. Единственный доступный stable bank reference в том же bank/source alias узнаёт operation при изменении source date/amount.
3. Date/amount equality разных файлов без stable ID недостаточна в text-free profile: обе transactions сохраняются с `possible_duplicate`. Repeated-reference collision также не выбирает произвольную operation. Candidate pairs имеют tenant FK/cascade.
4. Две одинаковые реальные строки одного файла сохраняются отдельно. Ordinal не становится bank ID между файлами. Несколько observations одной transaction не являются несколькими кандидатами.

HMAC shape не доказывает честность client parser. Unknown source kind/empty merchant профиля не являются новыми банковскими semantic decisions. При обновлении source pointer user corrections/verified facets/comment/exclusion/decomposition сохраняются. При unchanged facts прежний source остаётся выбранным, но новый provenance всё равно записывается. New operations получают unresolved semantics, затем актуальные personal rules и review из общего reconciliation. Реальный валидный zero получает review, missing date/amount никогда не заменяются guessed facts.

## Счётчики и privacy cascade

Для файла/batch `counts.rowsFound = pending + created + existing + updated + notImported + removed`. Created/existing/updated в `counts` — исходы строк; одна shared transaction может встречаться в нескольких file outcomes. Отдельный `transactionCounts` считает distinct surviving canonical operations: total/created/existing/updated/review. Для одной transaction в пределах выбранного file/batch применяется приоритет created → updated → existing, поэтому первые три категории не пересекаются и складываются в total. Review не прибавляется к outcomes. Blocked/missing-fact rows входят в notImported, а не Review transactions. Issue содержит ordinal/technical code/nextStep для local verification/reupload.

Physical deletion cascades observation provenance/candidate records. Старый отчёт вычисляется заново и отражает removed rows вместо финансовой копии прежнего результата. Reimport отсутствующего instance создаёт новый ID. Любое selective delete инвалидирует pending rows всего пользователя, очищает staged payload/dispatch и меняет generation. Preview считает pending/provenance/candidate effects. Full reset считает и очищает все новые tables перед key rotation. Старый worker не может воскресить удалённое.

Cancellation ещё отсутствует: ordinary delete не заменяет удаление конкретного file/batch с выбором последнего remaining source, shared restoration, manual-edits preview и privacy cascade. Dedupe rejection/merge decisions, global/AI classification, final automatic link pass и рабочий Import UI ещё впереди.

## Проверки и следующий блок

Pure matching и PostgreSQL/HTTP сценарии проверяют idempotency/TTL, one-active/races, partial counts, identical instances, stable-ID/ambiguity, manual edits, crash/restart, ownership/grants, deletion/reimport и reset. Результаты полного CI конкретного коммита фиксируются в PR после завершения. Synthetic fixtures не доказывают real-bank или real-device acceptance.

Следующий блок — проверенные локальные bank adapters и безопасный source-text profile с sanitized merchant/description, измеренными file/page/device limits и dedupe corpus. Затем cancellation/remembered dedupe decisions/final passes/UI. Реальные выписки потребуются для adapter fixtures; real financial data и identifiers не помещаются в Git, AI, logs или Staging.
