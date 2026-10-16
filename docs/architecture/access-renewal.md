# Продление доступа — Development

Четвёртый блок этапа 3 продолжает PR №9. Источники: PDF 38.1/38.2, 39, 40.4, 41.5/41.6; утверждённые A-01, B-06, B-10 и C-02. **A-01 заменяет старое правило PDF 39.5**: после реального истечения новый период начинается при административном подтверждении, даже если пользователь отметил перевод до окончания.

## Поведение

- Verified identity session открывает своё продление при активном, истёкшем или suspended аккаунте. Один незавершённый request защищён unique index и общей блокировкой cycle. До claim можно явно сменить тариф или отменить заявку; после claim финансовые параметры фиксируются. Цена, длительность и AI quota берутся из DB snapshot, а не из браузера. `availableForRenewal` независим от `availableForNew` и публичной видимости.
- Claim требует sender name/bank, фиксирует server timestamps и transactional encrypted notification outbox. Пользователь не вводит сумму, карту или реквизиты. Claim не продлевает доступ, не создаёт grace period и не исчезает автоматически до решения. В PDF 39 для renewal не задан срок автоматического истечения; first-access expiry не переносится на него.
- В админке отдельно показываются первый доступ и продления. Mandatory TOTP/session proof проверяются до preview и commit. Revision/action ID, actor и DB wall clock проверяются на сервере. При changed cycle revision или переходе через expiry после preview commit требует новый расчёт. Для expired cycle показанное время предварительное: actual anchor фиксируется при commit.
- Деньги и права записываются отдельно. Expected/actual integer minor units, каждый дополнительный перевод, mismatch decision/reason, top-up и ручной возврат при rejection сохраняются в money ledger. Продление создаёт один `access_extension`; оно не создаёт новую registration purchase/invitation. Exact retry возвращает already_committed; changed payload/action ID conflicts не добавляют срок.
- Canonical paid clock — `commerce.access_cycle`. `/session` читает его вместе с identity suspension. Control profile не получает grants к identity/finance и не может снять suspension. Старый identity access_end остаётся compatibility fallback только для аккаунтов без cycle. Registration создаёт cycle атомарно; forward migration переносит уже активированные purchases.
- Cycle/request/payment/action/extension/audit/outbox сохраняются одной транзакцией. Ошибка outbox откатывает весь переход. Оба profiles блокируют cycle перед renewal request; SQL RLS ограничивает finance роль transaction-local user context, который очищается при возврате соединения в pool.

## Календарный расчёт

Development snapshots фиксированы в `Europe/Moscow`; другие timezone/DST и profile picker ещё не реализованы. В непрерывном cycle сохраняется исходный anchor. Calendar boundaries вычисляются PostgreSQL от anchor плюс накопленный номер месяца; 31 января → 28/29 февраля → 31 марта → 30 апреля, без дрейфа на 28-е. Day grants — отдельное точное смещение 24 часа. Формула Development: local anchor + accumulated calendar months, затем accumulated day offset. При добавлении дней calendar/quota grid не сдвигается; новая monthly boundary сохраняет явное смещение дней. Это техническая композиция календарной сетки и дневных grants, проверяемая отдельно, а не пропорциональный пересчёт денег в дни.

После фактического expiry anchor и счётчики нового cycle начинают отсчёт от DB wall clock подтверждения. Early renewal не меняет anchor. Реального AI usage/quota enforcement пока нет; этот блок не выполняет usage reset и не выдаёт несуществующие значения использованного лимита. Позднейший AI runtime обязан использовать ту же cycle grid и соблюдать A-01/B-06/B-10.

## API и миграция

| Endpoint | Права и действие |
| --- | --- |
| `GET /access/renewal` | Own cycle, безопасная текущая/последняя заявка, доступные renewal tariffs |
| `POST /access/renewal-create` | Session owner + tariff ID; не более одной открытой заявки |
| `POST /access/renewal-change` | Own request ID/revision + DB tariff, только до claim |
| `POST /access/renewal-cancel` | Own request ID/revision, только до claim |
| `POST /access/renewal-claim` | Own request ID/revision, sender name/bank; повторная отметка после top-up |
| `GET /control/renewals` | TOTP admin: отдельная очередь, платежи, extensions и audit |
| `POST /control/renewal-preview` | Read-only money decision + текущие consequences |
| `POST /control/renewal-review` | Action ID, request/cycle revision, expected mode; atomic commit |

После `migrate` и `migrate-invitations` выполнить **один раз** `APP_ENV=development pnpm --filter @finance/api operator migrate-renewal` с local operator connection. Скрипт `0003_access_renewal.sql` forward-only, переносит active purchases. Scoped API credentials не выполняют migrations. Synthetic seed tariff теперь явно допускает renewal; ранее созданный Development tariff надо явно настроить оператором, existing snapshots не переписываются. Нового хостинга/сервиса для блока не нужно.

## Проверки и границы

`apps/api/test/security.test.ts` добавляет 10 real PostgreSQL scenarios: own API/RLS/pool reset, concurrent creation/change/cancel/freeze, preview/no double extension, expired restoration/no grace, suspended renewal, top-up/no note leak, rejection, 31st/leap/calendar/day offsets, transaction rollback и expiry during lock wait. Два real HTTP/browser journeys desktop/mobile продолжают registration до renewal и проверяют отсутствие финансовой кнопки после suspension. Общие money/projection/auth/UI checks сохраняются. Итоговый head/run фиксируется в PR, mobile Chromium не заменяет real Safari acceptance.

Остаются reminders/worker/real email delivery, реальные реквизиты и тарифы, manual free/fixed/indefinite grants, corrections/refunds с отдельным access impact, actual AI usage/quota, owner onboarding, KMS/hosting, cleanup/observability и full security/release acceptance. Облачные сервисы и Production не подключены. Реестр отмечает **partial**, PDF/Word/baseline неизменны. Слияния с main этот блок не выполняет.

Primary calendar reference: https://www.postgresql.org/docs/18/functions-datetime.html.
