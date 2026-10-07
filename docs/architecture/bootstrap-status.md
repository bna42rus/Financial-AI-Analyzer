# Состояние проекта

Обновлено 7 октября 2026 года. Продуктовая база 1.3, исходные PDF/Word и agreed A/B/E сохранены без изменений.

Закрытый репозиторий владельца: https://github.com/bna42rus/Financial-AI-Analyzer. Документы, чтение/запись и GitHub CI проверены. История исходной базы сохранена. Подписка Pro и защита main пока не подтверждены.

## Принятая интерфейсная версия

Обзор, Операции, Анализатор и Настройки, окна загрузки/профиля и переходы к истории объединены с main через PR №2–6. Main после PR №6: `bf3e2db1e6314c84c8e28df8d9c71cbb2af21ac4`; [88 проверок после объединения](https://github.com/bna42rus/Financial-AI-Analyzer/actions/runs/37617425642) прошли. Первая интерфейсная версия этапа 2 принята. [Обзор](web-overview.md), [Операции](web-operations.md), [Анализатор](web-analyzer.md), [Настройки](web-settings.md), [загрузка/профиль/история](web-shell-completion.md).

Примеры явно включаются и существуют только в памяти. Файлы ещё не обрабатываются; аккаунты, API, финансовая база, истинная история/Undo и AI не подключены.

## Первый блок этапа 3

В `feature/access-admin-requests` добавлены чистая модель заявки/ручной оплаты/приглашений и интерфейс для приёмки: публичный тестовый путь `#access`, отдельная админка на Development origin 5174. Очередь, карточка, preview, mismatch decisions, отдельная доплата, payment journal, pending purchase/invitation и audit работают на synthetic данных. [Границы и проверки](access-admin-requests.md).

Конфигурация проверок: 10 денежных + 16 domain + 20 projection tests, strict TypeScript и две сборки, 62 web + 16 admin browser scenarios. Hosted результат фиксируется в новом PR. Это не полная security/runtime acceptance.

Следующий блок: server/DB/auth foundation, verified email/application session, admin TOTP и одноразовые recovery codes E-04, ownership/permissions, transactional idempotency/outbox, затем invitation registration/activation и renewal. Client actor/verification events примера не дают полномочия. Не проверены реальные email delivery, DB concurrency/RLS, secure tokens и runtime isolation.

## Остальная работа и запуск

Предстоят общее финансовое ядро, imports/privacy/HMAC/dedupe, components/links, Registry/AI, настоящие история/Undo, бюджеты/графики/виджеты/saved views, полный пользовательский и административный контур, эксплуатационные и общие проверки.

Облачные среды/доступ к провайдерам, legal/retention/RPO/RTO и конкретная смета ещё не подтверждены. Docker здесь не установлен; инфраструктурные шаблоны не запускались. Основа будущего размещения — Timeweb RU, managed PostgreSQL после проверки цены/возможностей. Домен и настоящие тарифы остаются открытыми. Услуги не приобретались, Production не публиковался.

Для Production нужны все требования и проверки, принятие владельцем конкретного Staging artifact, миграции и план восстановления. Оплата/провайдеры/Production остаются отдельными решениями владельца. Админка не управляет deployment.
