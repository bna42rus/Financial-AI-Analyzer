# Персональный финансовый анализатор

Начальная подготовка репозитория. Продуктовая база: полный Master Specification + approved A/B, версия 1.2. Структура и основной стек согласованы. Российские инфраструктурные кандидаты и условия минимального бюджета записаны в baseline, часть D.

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

Предлагаемый remote: private GitVerse Free на аккаунте владельца. Remote не создан и не подключён. Настройка branch protection и hosted CI требует авторизованного доступа. Product data и credentials в Git не добавляются.
