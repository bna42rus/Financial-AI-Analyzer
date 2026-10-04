# Персональный финансовый анализатор

Начальная подготовка репозитория. Продуктовая база: полный Master Specification + approved A/B + admin recovery E-04, версия 1.3. Структура, основной стек и базовый выбор сервисов согласованы. Текущие решения, домен/бюджет и ещё открытые условия записаны в baseline, часть E.

Сейчас реализованы только точные integer money primitives, проверка component sums и проверка неизменности исходных документов. Web/admin/API, imports, Registry, authentication и database schema ещё не реализованы. Этот пакет не является работающим сайтом или Production release.

## Проверка без платных сервисов

Требуется Node.js 24 LTS. Выполнить `npm run check`.
Тесты не требуют npm install, API keys или реальных банковских данных. Native Node запускает TypeScript с type stripping; это не TypeScript typecheck. Compiler/build/lint/integration/e2e/security checks добавляются при bootstrap приложений и обязательны до Staging release.

## Где источники

- docs/product/master_spec_v1.pdf — исходный PDF без изменений.
- docs/product/context_handoff.docx — исходный Word без изменений.
- docs/product/baseline.md — approved amendments, architecture и бюджетный план.
- docs/product/source-manifest.json — hashes и порядок применения.

## Среды

Infrastructure содержит отдельные templates Development/Staging для PostgreSQL. Docker в текущем исполнении не установлен; запуск контейнеров здесь не проверялся. Пароли генерируются отдельно, не добавляются в Git. Production configuration отсутствует, поскольку providers/retention/RPO/RTO/security acceptance ещё не закрыты.

Репозиторий владельца создан: https://github.com/bna42rus/Financial-AI-Analyzer — private. Чтение и сохранение изменений через подключение проверены; оригинальная история из двух коммитов и база 1.3 доступны. План сохранён в отдельной ветке, открыт [draft PR #1](https://github.com/bna42rus/Financial-AI-Analyzer/pull/1). [Bootstrap CI #2](https://github.com/bna42rus/Financial-AI-Analyzer/actions/runs/37210531621) для коммита fee3c177c582041e03a4899439aab86723f888f5 завершился успешно. Это проверка источников и денежных primitives, а не всего сайта. Подписка Pro и защита main пока не подтверждены. Product data и credentials в Git не добавляются.

## План и готовность сайта

- [План разработки простыми словами](docs/product/implementation-plan.md).
- [Список реализации и проверок](docs/product/implementation-checklist.md).
- [Реестр всех разделов и подпунктов](docs/product/implementation-registry.json).

Готовность отслеживается по требованиям, коду и результатам проверок. Список задач и успешные начальные тесты не означают готовность сайта.
