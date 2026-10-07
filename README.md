# Персональный финансовый анализатор

Начальная подготовка репозитория. Продуктовая база: полный Master Specification + approved A/B + admin recovery E-04, версия 1.3. Структура, основной стек и базовый выбор сервисов согласованы. Текущие решения, домен/бюджет и ещё открытые условия записаны в baseline, часть E.

Обзор, Операции и Анализатор приняты и сохранены в main. В отдельной ветке добавлена первая версия «Настроек»: десять разделов, поиск и рабочее оформление; финансовые параметры доступны для просмотра. Доступны базовые версии всех четырёх экранов. AI, импорт, авторизация, API, база и полная финансовая логика предстоят. [Запуск и границы](apps/web/README.md); [состояние проекта](docs/architecture/bootstrap-status.md); [Настройки](docs/architecture/web-settings.md).

## Проверка без платных сервисов

Требуются Node.js 24 LTS и pnpm 11.25.0. Выполнить `pnpm install --frozen-lockfile --ignore-scripts`, затем `pnpm run check`. Для просмотра первого экрана — `pnpm run dev:web`.
Проверки включают источники, 10 тестов денежных primitives, strict TypeScript, 20 тестов искусственных проекций и сборку. Для браузерных проверок установить Chromium по [инструкции](apps/web/README.md) и выполнить `pnpm run test:e2e`: 44 сценария на компьютере/мобильной эмуляции. API keys и реальные банковские данные не нужны. Полные integration/security/release проверки предстоят.

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
