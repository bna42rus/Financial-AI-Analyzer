# Персональный финансовый анализатор

Начальная подготовка репозитория. Продуктовая база: полный Master Specification + approved A/B + admin recovery E-04, версия 1.3. Структура, основной стек и базовый выбор сервисов согласованы. Текущие решения, домен/бюджет и ещё открытые условия записаны в baseline, часть E.

Все четыре первых экрана, окна загрузки/профиля и переходы к истории приняты и сохранены в main через PR №2–6. В `feature/access-admin-requests` начинается этап 3: модель первого доступа, тестовый путь заявки и отдельное приложение админки для просмотра очереди, ручной сверки оплат и подготовки приглашений. В продолжении `feature/server-access-security` реализована Development серверная основа: API/база, verified-email application sessions, reset/invalidation, mandatory admin TOTP и recovery-only восстановление. UI пока остаётся самостоятельным примером; доставка писем, invitation registration и настоящие сервисы предстоят. [Серверный блок и проверки](docs/architecture/server-access-security.md). [Пользовательские экраны](apps/web/README.md); [админка](apps/admin/README.md); [границы нового блока](docs/architecture/access-admin-requests.md).

## Проверка без платных сервисов

Требуются Node.js 24 LTS и pnpm 11.25.0. Выполнить `pnpm install --frozen-lockfile --ignore-scripts`, затем `pnpm run check`. Для просмотра первого экрана — `pnpm run dev:web`.
Проверки включают исходные документы, 10 денежных и 16 тестов модели доступа, strict TypeScript обоих приложений, 20 тестов искусственных проекций и обе сборки. Для браузерных проверок установить Chromium по [инструкции](apps/web/README.md) и выполнить `pnpm run test:e2e`: 62 сценария пользовательского интерфейса и 16 сценариев админки. API keys и реальные банковские данные не нужны. API strict TypeScript и две crypto проверки входят в check; `pnpm test:security` запускает 24 integration scenarios на отдельном PostgreSQL 18 (GitHub CI предоставляет базу). Полная security/release acceptance ещё предстоит.

## Где источники

- docs/product/master_spec_v1.pdf — исходный PDF без изменений.
- docs/product/context_handoff.docx — исходный Word без изменений.
- docs/product/baseline.md — approved amendments, architecture и бюджетный план.
- docs/product/source-manifest.json — hashes и порядок применения.

## Среды

Infrastructure содержит отдельные templates Development/Staging для PostgreSQL. Docker в текущем исполнении не установлен; запуск контейнеров здесь не проверялся. Пароли генерируются отдельно, не добавляются в Git. Production configuration отсутствует, поскольку providers/retention/RPO/RTO/security acceptance ещё не закрыты.

Репозиторий владельца: https://github.com/bna42rus/Financial-AI-Analyzer — private. Чтение и запись проверены; история и база 1.3 доступны. Согласованные план и оформление объединены в main через [PR #1](https://github.com/bna42rus/Financial-AI-Analyzer/pull/1), commit 4bb5d77287d675f32fb9e65d6827e03908225e64. Предшествующий bootstrap CI прошёл. Первые версии экранов сохраняются отдельными feature branches с расширенными проверками. Подписка Pro и защита main пока не подтверждены. Product data и credentials в Git не добавляются.

## План и готовность сайта

- [План разработки простыми словами](docs/product/implementation-plan.md).
- [Список реализации и проверок](docs/product/implementation-checklist.md).
- [Реестр всех разделов и подпунктов](docs/product/implementation-registry.json).

Готовность отслеживается по требованиям, коду и результатам проверок. Список задач и успешные начальные тесты не означают готовность сайта.

## Первая интерфейсная версия

Окна загрузки/профиля и переходы к истории объединены с main через PR №6. [Описание, проверка и ограничения](docs/architecture/web-shell-completion.md). Выбор файлов не запускает обработку; регистрация, серверные права и постоянное хранение относятся к следующим частям.

## Заявка и админка

Пользовательский пример: http://127.0.0.1:5173/#access. Отдельная админка запускается через `pnpm run dev:admin` на http://127.0.0.1:5174. Примеры включаются явно и независимы: данные между origins не передаются и не сохраняются. Оплаты и письма не выполняются. [Описание реализации и следующий шаг](docs/architecture/access-admin-requests.md).
