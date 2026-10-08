# Подготовка импорта — первый блок этапа 5

Основание: полный PDF 18–20 и 35.1–35.11, approved A-02/A-05/A-06/B-03/B-08, техническая часть C-04 в объёме E. Источники PDF/Word и baseline 1.3 неизменны. Ветка основана на `feature/derived-links` (PR №18); PR не объединяется с main и приложение не выпускается. Registry остаётся partial.

## Текущая граница

Реализован общий контракт между будущими локальными парсерами и сервером. `source-adapter/1` обозначает версию этого adapter contract, а не поддержку реального формата какого-либо банка. Код не читает PDF/CSV/XLSX и не вызывает OCR/AI. Поддержка фактических вариантов Т-Банка, Ozon Bank и Сбербанка определяется только по заново проверенным санитизированным fixtures; исторические файлы не объявляются доступными.

Первый профиль `text-free/1` намеренно не переносит свободный банковский текст в сетевой payload: merchant/description, ФИО, адреса, recipient/phone, OCR, filename/password и любые дополнительные колонки остаются на устройстве. Это консервативная техническая стадия подготовки, **не изменение принятой продуктовой модели**. До полноценного импорта следующий профиль должен сохранять разрешённые sanitized description/merchant/source fields после проверенной локальной очистки. Нельзя объявить source restoration, классификацию или требование A-05 завершёнными при использовании только этого профиля. Нет произвольного текстового sanitizer, чью надёжность можно было бы ошибочно принять за доказанную на всех банковских форматах.

## Локальная обработка

`createLocalPreparation(context, signal?)` получает contextId/generation/keyVersion, текущий 256-bit per-user key и срок из уже существующего авторизованного `/finance/import-context`. WebCrypto импортирует ключ как non-extractable HMAC-SHA-256 для sign. Декодированный временный byte buffer обнуляется после importKey; исходная JS-строка и все browser/GC копии не объявляются физически уничтоженными. Нет localStorage/IndexedDB, сети, AI, telemetry или logger в пакете подготовки.

`prepare(batchId, files)` принимает bytes и строки, извлечённые локальным adapter. Создаёт новый объект только из разрешённых полей. Bytes нужны исключительно для per-user HMAC файла; filename, password и свободный текст не копируются. Сам файл не отправляется. Profile versions строго фиксированы: pipeline `local-prepare/1`, normalizer `strict-source/1`, sanitizer `text-free/1`, HMAC namespace `namespaced-hmac/1`, adapter `source-adapter/1`.

| Поле | Контракт |
| --- | --- |
| context | Собственные UUID contextId, generation и keyVersion; без key |
| batch/file IDs | UUID, которые являются идентификаторами запроса, а не полномочиями |
| bank | Закрытый enum tbank/ozon/sber/other; без произвольного bank label |
| fileHmac | Domain-separated per-user HMAC bytes; не обычный глобальный SHA |
| operationDate / postedDate | Достоверная calendar day или нормализованный UTC instant; posting date может отсутствовать |
| amountMinor / currency | Canonical signed integer string в диапазоне PostgreSQL bigint и RUB; без float |
| direction | debit/credit/unknown; debit и credit не могут противоречить знаку |
| account | Тип bank_account/card/loan_contract и HMAC; internal account assignment ещё не делается |
| bankRefHmac | Псевдоним надёжного source bank ID либо null; ordinal его не заменяет |
| ordinal | Позиция извлечённой source row внутри файла, начиная с 1; одинаковые строки остаются отдельными instances |
| issue | Только ordinal и закрытый технический code; без исходного fragment/exception message |

HMAC message identifier — JSON-array `[namespaceVersion, bank, kind, canonicalValue]`: domain разделяет account/card/loan_contract/bank_reference, bank разделяет банковские контексты. Полные поддержанные числовые account/card numbers канонизируются через NFKC, outer trim и удаление пробелов/дефисов; leading zeros сохраняются. Account требует 20 цифр, card 16–19; masked/partial значения не угадываются. Opaque loan-contract/bank-reference остаются case/punctuation/internal-spacing sensitive и допускают только ограниченный ASCII identifier alphabet; controls/invisible characters отклоняются. Это ограниченный текущий canonicalization contract, а не доказанная поддержка всех банковских identifiers. Другие типы/форматы потребуют новой версии и fixtures.

File HMAC использует отдельный namespace `[namespaceVersion,"file"]` с separator и bytes. Одинаковые bytes у разных пользователей дают разные HMAC. Даже повтор того же fileHmac не подавляет строки: дальнейшая transaction-level dedupe обязана учитывать физическое удаление и повторную загрузку. Два одинаковых платежа остаются двумя prepared rows. Межфайловое one-to-one matching пока не реализовано.

Невалидные обязательные дата/сумма/account/currency/direction/reference становятся техническими row issues без canonical row. Нет amount=0/guessed date для прохождения schema. Реально переданный валидный ноль с direction unknown отличается от отсутствующей суммы; экономический смысл такой строки потребует последующего Review. Один файл с LOCAL_READ_FAILED не уничтожает валидные строки других файлов. Ошибка безопасно не извлечённого файла имеет только status/error и найденный технический row count.

`dispose()` закрывает сессию, снимает AbortSignal listener и отпускает CryptoKey reference. AbortSignal проверяется до/после async key initialization, а active/expiry — до/после HMAC. Отменённая in-flight стадия не возвращает payload. UI/logout/reset ещё должны подключить эти hooks; их автоматическая интеграция этим блоком не заявляется. При expiry нужна новая разрешённая локальная подготовка. Без WebCrypto нет fallback к обычному hash или отправке raw file.

## Серверная проверка

POST `/finance/import-validation` доступен только Finance profile и собственному verified active user с действующим entitlement. Тот же общий Origin/JSON/session/rate-limits применяется до выполнения. Prepared context принадлежит пользователю; generation, keyVersion и TTL проверяются через `withPreparedImport` под locks access-cycle → finance-workspace до проверки строк и после неё. Wipe/выборочное удаление инвалидируют старый payload; full reset меняет HMAC, selective delete сохраняет ключ. Чужой context UUID и подставленная свежая generation со старой keyVersion не дают полномочий.

Backend независимо проверяет dates/precision, integer range/signs, RUB, closed alias types/HMAC shape и processing versions. Отсутствующая обязательная дата/сумма/account в wire row тоже становится отдельным issue и не отменяет валидные строки. Неизвестные поля отклоняют payload целиком, включая вложенный raw field в row с другой ошибкой. Structural file/ordinal errors нельзя молча исправлять: IDs должны быть уникальными, rows+issues точно покрывают rowsFound, ordinal уникален и лежит в диапазоне. Отчёт разделяет found/valid/not prepared и blocked files, не объявляет их created/existing/review transactions.

Ответ имеет `stage: validation_only`, IDs, counts и technical issues. Он не отражает source dates/money/text, HMAC/file fingerprints или key. Нет financial write, сохранения payload, history rows, queue, AI/web call, account matching или creation transactions. Повтор возвращает тот же deterministic report, не потребляет context. HMAC shape не является доказательством честности клиентского extractor: это собственный пользовательский input, который должен повторно валидироваться при будущей записи. Этот endpoint **не server acceptance фонового batch**; браузер ещё нельзя закрывать с ожиданием завершения настоящего импорта.

Development resource guards: до 10 файлов и 1000 найденных строк на подготовленный запрос, bodyLimit 512 KiB только у validation route. Все прочие auth/password endpoints сохраняют прежние 8 KiB. Эти пределы — временные guards контракта, не согласованные Production/device file/page limits; будущая очередь должна поддержать нужный bounded chunking, точные batch counts и checkpoint retries. Новых таблиц/миграции нет. Новых финансовых copies/jobs для deletion cascade этот блок не создаёт.

## Проверки и дальнейшая работа

23 pure WebCrypto/contract сценария: allowlist/no-leak, independent HMAC reference, key/user/bank/kind namespaces, file HMAC, canonicalization, source ordinals/identical purchases, partial/blocked file, date precision, integer bounds/signs, invisible IDs, lifecycle/dispose/abort/expiry, malformed key, independent backend facts validation/missing fields, nested field smuggling, count-only report, versions и structural/size guards.

13 PostgreSQL/HTTP сценариев: authorized no-store/report/no financial writes, partial result, no reflection, anonymous/unverified/suspended/expired access, foreign context, full reset/old key, selective delete/stable aliases, expired context, 1000 rows above auth limit, unchanged auth bound, malformed/oversize JSON, unsupported versions, method/origin/query/control isolation и deterministic retry. Chromium checks на desktop/mobile проверяют настоящий WebCrypto, сетевой payload, отсутствие local/session/IndexedDB storage и отмену in-flight стадии. Это synthetic fixtures и эмуляция Chromium; это не real-device acceptance iOS Safari/Android Chrome. Exact-head GitHub evidence добавляется в PR после завершения всех checks.

Следующий серверный блок — [accepted normalized batches](import-ingestion.md) с durable provenance, source-only dedupe и one-active-batch constraint, запись валидных observations и точные partial counters. Перед включением полноценного импорта нужны безопасные source texts, проверенные real-bank adapters, extraction/OCR/password opening, file/page limits по измерениям, browser worker/logout lifecycle, classification/link pass и queue retries. Затем cancellation file/batch с точным preview, восстановлением shared observations, сохранением manual decisions и privacy cascade. Unknown-format AI fallback получает только проверенную безопасную структуру. Полная feature/UI, dedupe corpus, нагрузки, Staging/Production и будущие module copies остаются незавершёнными.
