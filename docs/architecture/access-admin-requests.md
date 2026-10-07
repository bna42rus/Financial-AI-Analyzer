# Первый доступ и административная сверка

7 октября 2026 года. Первый блок этапа 3: детерминированная модель и интерфейс для приёмки. База — main `bf3e2db1e6314c84c8e28df8d9c71cbb2af21ac4` после объединения PR №5/6. Полные PDF/Word и baseline 1.3 неизменны. Новая работа находится в `feature/access-admin-requests`.

## Что реализовано

- `packages/access/src/model.ts`: snapshot условий заявки; нормализация email и одна незавершённая заявка в переданном состоянии; неоплаченная заявка истекает через 72 часа. После payment claim автоматическое истечение прекращается. Claim требует ранее записанного внутреннего события verification, sender name/bank и не создаёт purchase или действующий доступ.
- Сверка хранит ожидаемую сумму отдельно от каждого полученного перевода. Все денежные расчёты — bigint и canonical minor-unit strings. Доплаты сохраняются отдельными records. При несовпадении явно выбираются полный snapshot тариф, доплата, отклонение с отдельным ручным возвратом либо согласованный custom период. Процентный срок из денег не вычисляется; переплата не создаёт дополнительный месяц или кошелёк. Нулевая сумма не создаёт paid purchase.
- Перед решением UI показывает последствия. Повтор того же action ID не создаёт второй payment/purchase/audit; повтор ID с другим payload и устаревшая revision отклоняются. Это защита чистого state transition, ещё не атомарная DB concurrency.
- Первая оплата создаёт `paid_not_activated` purchase и metadata приглашения. Календарный месяц сохраняется как calendar-month duration; фактическая activation/end/calendar anchor будут реализованы вместе с регистрацией. 72 часа срока ссылки независимы от срока оплаченного доступа. При отмене/истечении/замене приглашения purchase и payment сохраняются, старые metadata остаются в истории. Никакой secret link не выдаётся.
- В `apps/web` маршрут `#access` показывает тестовый путь: выбор тарифа → имя/email → отдельный экран до verification → явно обозначенная симуляция подтверждения → sender name/bank → ожидание ручной сверки. Платёжные инструкции недоступны до шага verification. Реальных реквизитов и свободной регистрации нет; цены/AI limits явно тестовые.
- `apps/admin` — отдельная сборка и Development origin 5174. Обзор, очередь новых заявок, карточка, сверка, manual payment journal, invitation metadata и audit. Продления отделены и пока не подключены. Заявки показывают snapshot, expected amount, sender и timestamps, без card/account numbers, операций и финансовых чатов.

## Границы этого блока

Все примеры opt-in, ephemeral и полностью синтетические. Пользовательский и административный примеры независимы; браузер не передаёт данные между ними. Нет fetch/POST, Storage, записи в реальные аккаунты, денежных переводов, отправки писем или фиктивного статуса sent. Clock и actor в UI — только демонстрационные inputs. Локальный actor ID, событие verification и совпадение port не дают реальные полномочия.

Не реализованы NestJS/Fastify endpoints, PostgreSQL/Drizzle и DB roles/transactions/RLS, Better Auth, verified email ownership, одноразовые hashed tokens, rate limits, real server timestamps, transactional outbox, account activation, renewal calendar anchors, suspension, reauth/TOTP/recovery, corrections/refund actions, full admin/users/tariff editor. Admin read не содержит TOTP/password/reset/invite secrets. Security requirements PDF 40.5/40.10 и E-04 остаются not_verified. Наличие separate frontend не подтверждает server isolation.

Источники: PDF 37–41, схемы/текст 38.3 на странице 51 и admin 41.1–41.6 на странице 57 сверены визуально; Word 20–21; approved B-10 и E-02/E-04. Применены узкие части 38/39/41 и B-10; они отмечены partial. A-01/B-06 renewal не подменяются моделью первого доступа.

## Проверки и изображения

`pnpm check`: hashes исходных документов, 10 денежных и 16 access-model tests, strict TypeScript обоих приложений, 20 UI projection tests и две сборки. Playwright: 62 web + 16 admin = 78 браузерных сценариев; всего 124 теста/сценария. Все 124 проверки прошли локально. После визуальной правки мобильного уведомления повторно прошли затронутые сценарии и общий check. Результат hosted CI указывается в PR.

Проверяются snapshot/expiry/verification prerequisites, money mismatch и точность копеек, repeated/stale actions, отдельная доплата, отмена/замена/истечение invitation без повторной покупки; UI opt-in, preview и честные статусы, фокус/Escape, отсутствие write requests/Storage, ширины 320/390/1024/1440 и темы. Мобильная эмуляция Chromium не является проверкой настоящего iPhone/Safari.

Скриншоты запускаемого кода: [тарифы](../screenshots/access-tariffs-desktop.png), [шаг оплаты](../screenshots/access-payment-desktop.png), [заявки в админке](../screenshots/admin-requests-desktop.png), [сверка](../screenshots/admin-payment-review-desktop.png); мобильные версии имеют суффикс `-mobile`.

## Следующий блок

Проверка владельцем понятности этой части. Затем server/DB/auth foundation: защищённый путь подтверждения почты, application session, серверные permissions, admin login с обязательным TOTP и recovery codes E-04; PostgreSQL transitions/idempotency/outbox. После этого реальные invitation registration и renewal. Покупки providers и Production release остаются отдельными решениями.
