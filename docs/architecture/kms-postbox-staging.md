# KMS и Postbox: подключение приложения

Источники: полный PDF §35.11 (per-user HMAC), §40.17 (письма/status/resend), §44 (monitoring/failure), §45.3–45.7 (изолированная тестовая среда); approved E-03/E-05/E-07. Stacked on #39. Полные продуктовые группы остаются partial; Production не выпускается.

## KMS

Четыре существующих KMS key/SA привязаны к staging/production × finance/control. Публичные IDs не являются credentials. PS256 JWT получает IAM token; requests идут только на официальные HTTPS endpoints с TLS verification, без redirects и с timeout. Параллельные refresh объединяются. Provider body/credentials не выводятся в errors/logs. RSA JSON и ciphertext читаются только из private regular files; symlinks/group/world-readable файлы отклоняются.

Постоянный случайный 256-bit wrapping key защищён соответствующим Yandex KMS key. Он расшифровывается при startup и остаётся только в памяти. Это **KMS-protected KEK**, а не KMS call для каждого DEK/payload. Существующий envelope v:1 (fresh DEK/nonce, AES-GCM) и синхронный Drizzle custom type сохраняются. Protected per-user HMAC key остаётся отдельно от financial tables. SQL privileges не расширяются; mail получает ключ своего outbox source, но не доступ к HMAC/password/session tables.

AAD связывает ciphertext со средой/realm, record хранит key/version ID. Missing/corrupt file или KMS outage блокирует startup; нет автоматической генерации/fallback. Staging запрещает plaintext WRAPPING_KEY_BASE64/MAIL_WRAPPING_KEY и требует реальный unlock своего ключа. Production startup закрыт. Ключ очищается при graceful stop; не обещается физическое стирание всех JS copies. KMS revocation действует при следующем unlock, уже работающий процесс не проверяет remote permission при каждом чтении.

`kms:init` — **только для новой пустой среды**. Нельзя переключить базу с existing v:1 ciphertext на новый случайный KEK: требуется отдельно обернуть исходный KEK и проверить миграцию на копии. Exclusive create не перезаписывает существующий файл. Backup обязан сохранять wrapping ciphertext; RSA credential восстанавливается отдельно. Удаление record/старой KMS version приводит к потере доступа к secrets. KEK rotation/destruction и deletion-journal replay остаются отдельной работой.

## Postbox

Transactional encrypted outbox и scoped pg-boss workers подключены к Postbox SMTPS postbox.cloud.yandex.net:465. Python 3 stdlib проверяет TLS; credentials идут subprocess через stdin, не argv/logs. Новых npm dependencies нет. Credential JSON:

```json
{"sender":"notifications@cashneuro.ru","username":"<API key ID>","password":"<API key secret>"}
```

Transport доступен только Staging, с allowlist 1–5 **тестовых ящиков**. Остальные recipients отклоняются до SMTP. Реальных пользовательских уведомлений нет. Для полной изоляции Staging нужен отдельный Postbox API key; рабочий credential автоматически не копируется. Sandbox сохраняется для Development/tests и Staging. CI не использует настоящий SMTP/provider/secrets.

sent/acceptance=postbox означает финальный SMTP 250, не доставку во входящие. Explicit 4xx/отказ до DATA дают backoff; 5xx — permanent failure. Потеря ответа после DATA, timeout/неопределённый bridge outcome или crash с незавершённым lease дают DELIVERY_UNKNOWN, без автоматического повтора. Ошибка close после acceptance его не отменяет. Message-ID стабилен, но не гарантирует provider idempotency. Admin resend остаётся явным авторизованным действием. Webhooks/bounces/reconciliation ещё не реализованы.

0023_postbox_acceptance.sql расширяет только metadata constraint; нужны 0001–0022 и installed pg-boss queues. services:migrate допускает operator только в Staging на loopback port 5411. Rollback сохраняет constraint/таблицы и исходный wrapping record; workers остановить перед rollback и проверить reader/key compatibility.

## Установка после CI

1. Read-only inventory: Node 24 path, server checkout/release, scopes/roles, migrations/queues и existing encrypted payloads. Не создавать случайный KEK до подтверждения пустой базы/плана миграции исходного KEK.
2. Разместить проверенный артефакт в /srv/cashneuro/staging/backend-current; locked dependencies (`pnpm install --frozen-lockfile --ignore-scripts`), read-only для runtime. API слушает loopback; новые firewall ports не нужны.
3. Для **новой пустой** realm из apps/api: `node --import tsx src/kms-init.ts staging/finance /etc/cashneuro/kms/staging/finance/authorized-key.json /etc/cashneuro/kms/staging/finance/wrapping-key.json`; для control заменить realm и оба пути. Root dirs 700/files 600. API и mail одного realm используют один record; другие realms/среды его не разделяют.
4. Применить 0023 через Staging operator. Root-only environment files по infra/staging/*.example; отдельные finance/control API/mail passwords, AUTH_SECRET и фактическая test admin origin. Postbox Staging — отдельный credential в /etc/cashneuro/mail/staging-postbox.json. MAIL_TEST_RECIPIENTS — только тестовые ящики. Секреты не выводить/не коммитить.
5. Проверить infra/systemd templates под фактический Node/release path. DynamicUser, read-only FS, LoadCredential и LimitCORE=0 изолируют credentials. Установить/включить только нужные Staging instances после проверки всех полей. Production unit не поставляется.
6. Настроить Caddy для двух API profiles и import-worker отдельно, сохранив frontend/infra/db health routes. Пройти synthetic HTTPS/API/auth/TOTP/reset/invitation/queue/retry и проверить **письмо из app outbox** в тестовом ящике. Проверить safe rollback/key compatibility. Отдельный SMTP smoke не заменяет этот сценарий.

Templates/examples — подготовленные файлы, не установленный runtime. Конкретные install commands требуют фактических backend path, DB role/schema/migration state и field names прежнего Postbox JSON (значения не печатать). Реальное обновление Staging и browser/app mail acceptance выполняются после CI на сервере.

## Проверки и открытые границы

Unit: JWT PS256/aud/kid/expiry; exact endpoints/AAD/version; shared token refresh; permission/network/malformed failure; unsafe files/symlinks; no overwrite; key destroy; genuine unlock capability для Staging, Production gate; recipient/header/size guards; transient/uncertain outcomes. Python tests проверяют обязательный TLS и SMTP error stages. PostgreSQL scenario с synthetic provider проверяет Staging API + KMS-unlocked key, SMTP adapter → outbox state/projection, transient retry и uncertain failure без повторной отправки.

Владелец отдельно подтвердил 4 реальных KMS encrypt/decrypt и 12 пар чужого доступа (403), SMTP письмо во входящих с SPF/DKIM/DMARC, внешний мониторинг infra/DB/домена. Это provider/server smoke из чата, не acceptance опубликованного приложения. Security audit, key disaster recovery/rotation, complete deletion recovery, inbound support, provider webhooks и release acceptance остаются открытыми.

Официальные контракты: [IAM](https://yandex.cloud/ru/docs/iam/operations/iam-token/create-for-sa), [KMS encrypt](https://yandex.cloud/ru/docs/kms/api-ref/SymmetricCrypto/encrypt), [decrypt](https://yandex.cloud/ru/docs/kms/api-ref/SymmetricCrypto/decrypt), [Postbox SMTP](https://yandex.cloud/ru/docs/postbox/operations/send-email).
