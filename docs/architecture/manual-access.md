# Ручной доступ — Development

Пятый блок этапа 3 продолжает ветку `feature/access-renewal`. Источники: PDF 38.7, 39.8–39.10, 40.14/40.16, 41.3/41.4/41.9–41.12; approved A-01, B-06 и B-10. Original PDF/Word/baseline не редактируются.

## Поведение

- TOTP admin выдаёт новый доступ по email: дни (в том числе 7/30), календарные месяцы (3/12), fixed end или indefinite; внутренний тип Paid/Test/Free/Other и обязательная причина. Тип Paid — классификация, не доказательство поступления денег. `manual_grant` хранится отдельно от `purchase`, payment journal и renewal ledger. Фиктивный payment/access request не создаётся.
- Относительный срок начинается при успешной регистрации. Fixed end остаётся выбранным абсолютным временем, indefinite имеет `access_end=NULL` и отдельный canonical flag. Ссылка имеет независимый срок 1–720 ч. Сама ссылка не подтверждает владение почтой: нужен отдельный proof из transactional outbox, как и для оплаченного приглашения. Password выбирает пользователь; после регистрации нужен обычный вход.
- Истёкшая/отменённая ссылка сохраняется. Replacement сохраняет условия grant, инвалидирует старую ссылку и её proof; срок относительного доступа не запускается при reissue. Fixed grant с уже прошедшим end не активируется и не продлевается автоматически через новую ссылку.
- Для существующего пользователя доступны компенсация/добавление дней или месяцев, изменение end, indefinite и end-now. Причина обязательна. Перед commit — read-only preview; сервер повторно проверяет revision, continuous/restored/indefinite/absent mode и quota snapshot. Exact retry по action ID не повторяет изменение; другой payload/actor конфликтует. Suspension независим и не меняется.
- Общая per-user transaction advisory lock синхронизирует ручные изменения и renewal. Active compensation сохраняет anchor и текущий usage. Restoration после expiry получает DB wall-clock anchor; no grace. Fixed correction хранит отдельное миллисекундное end offset относительно прежней календарной сетки, не переносит quota anchor. Последующие continuous renewals сохраняют offset, restoration очищает его. Продуктовый выбор другой timezone/DST остаётся впереди; Development фиксирует Europe/Moscow.
- Manual/indefinite access всегда получает конечную quota policy: immutable tariff quota snapshot или explicit override 0–1e9. Existing policy можно сохранить, но неизвестная policy не означает unlimited. Изменение tariff между preview и commit требует нового preview. Это политика лимита; реального AI usage/enforcement/reset в блоке нет. Существующий usage не сбрасывается. Продления на indefinite не создаются; прежние заявки остаются для чтения, административная сверка требует сначала конечного срока.
- Admin History хранит actor, DB time, reason, before/after и policy. Пользовательский `/session` читает canonical finite/indefinite state; старый identity flag используется только при отсутствии canonical cycle. Причины/notes не попадают в пользовательскую projection или уведомление.

## Граница полномочий

Control не получает SELECT/UPDATE в identity или finance. `commerce.account_directory` содержит только разрешённую административную projection user ID/email/name/registered_at/status; migration-owned SECURITY DEFINER triggers обновляют её при изменении identity metadata/status. Search path фиксирован, таблицы квалифицированы, прямой EXECUTE от PUBLIC/runtime roles отозван. Finance не читает directory, manual notes или audit. Runtime roles остаются non-owner/non-superuser; FORCE RLS canonical cycle и transaction-local tenant context сохраняются.

Новые email/reservation операции используют общую email lock с публичной заявкой/регистрацией. Existing account/pending application/pending manual grant не получает вторую параллельную выдачу. Public response остаётся generic. Все grant/invitation/cycle/action/audit/outbox изменения транзакционны; отказ outbox откатывает весь переход.

## API и миграция

| Endpoint | Действие |
| --- | --- |
| `GET /control/accesses` | TOTP: пользователи, canonical доступ, ручные приглашения, история и quota tariffs; Development списки ограничены 100 строками |
| `POST /control/manual-preview` | TOTP: read-only consequences |
| `POST /control/manual-access` | TOTP: atomic grant/compensation/correction, action ID + revision/mode/quota |
| `POST /control/manual-invitation-action` | TOTP: cancel/reissue с обязательной причиной |
| `POST /control/invitation-link` | Копирование действующей paid или manual ссылки; событие аудита |

После миграций 0001–0003 один раз выполнить `APP_ENV=development pnpm --filter @finance/api operator migrate-manual` с local operator connection. Миграция 0004 forward-only: nullable canonical end, explicit indefinite, offset/quota policy, metadata directory/triggers, отдельный manual grant и audit, exclusive paid/manual invitation source. Existing paid cycles получают quota snapshot; operator-provisioned access переносится без выдуманного quota. Нет deployment или подключения облака.

## Проверки и оставшиеся функции

`security.test.ts`: real PostgreSQL scenarios для closed/TOTP endpoints, validation, read-only preview, duplicate/concurrent email, action retry/conflict, independent proof, relative/fixed/indefinite activation, canonical precedence, suspension/isolation, calendar compensation, restoration, quota/revision/renewal conflicts, end-now, link expiry/cancel/reissue, rollback и expiry during lock wait. `browser.test.ts`: обе real HTTP/DB journeys дополняются ручной компенсацией, indefinite → finite, blocked navigation и выдачей/регистрацией manual email на desktop/mobile. Финальный exact-head run фиксируется в PR после его успешного завершения. Existing money/projection/security/UI checks и source hashes сохраняются.

Development/synthetic. Actual email/reminder worker, owner onboarding, other timezone/DST, actual AI quota, массовая компенсация, payment corrections/refunds, suspension/unsuspension actions, deletion/retention, pagination/search и полная release acceptance остаются отдельными блоками. Наличие зелёных проверок не означает готовность всего сайта. Main и настоящие сервисы этот блок не меняет.
