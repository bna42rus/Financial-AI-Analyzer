# Персональный финансовый анализатор

Продуктовая база 1.3: полный Master Specification PDF, контекст Word и согласованные A/B/E. Источники неизменны; требования и их покрытие находятся в [реестре](docs/product/implementation-registry.json). Полная готовность продукта не заявляется.

## Текущий статус

Последующий блок от проверенного PR №25 находится в `feature/import-cancellation-dedupe`: [отмена batch/file, direct source evidence, finite strict matching и persistent different decisions](docs/architecture/import-cancellation-dedupe.md). `main` по-прежнему ранний; infra/deployment ведутся отдельно. Для этой версии нужна migration 0014, actual exact-head CI указан в PR. Остальные абзацы ниже описывают предшествующие блоки.

В main принята первая версия четырёх экранов через PR №2–6. Следующая разработка находится в открытой последовательной цепочке PR №7–23; следующий блок находится в `feature/live-operation-review`. Его основа — `feature/live-import-ui` ([PR №23](https://github.com/bna42rus/Financial-AI-Analyzer/pull/23)), `1bc5247335a081776061831d2e3c27eae027ff7b`. Не начинать дальнейшую финансовую разработку от раннего main.

| Блок | Реализовано | Что впереди |
| --- | --- | --- |
| Доступ | Серверная заявка/оплаты/приглашения/регистрация, продления/ручной доступ, email outbox, admin TOTP/recovery | Реальные провайдеры, owner onboarding, эксплуатация и полная security acceptance |
| Финансовая основа | Accounts/categories/counterparties/rules, observations/corrections, components/links/allocations, preview/commit, история, исключения, Merge/Split, удаления/reset, одиночные правки карточки, correction preview и Undo | Полные финансовые экраны/массовые действия и будущие module dependencies |
| Импорт | Локальные PDF adapters/HMAC, ограниченные безопасные признаки/магазины, server validation/acceptance, durable provenance, account aliases, консервативный source dedupe, checkpoints/queue, privacy cascade, authenticated загрузка/история и чтение сохранённых операций | CSV/XLSX/OCR, более полный safe text profile, strict fingerprints, cancellation/dedupe decisions, final classification/link pass и полный review UI |
| Анализатор и выпуск | Приняты базовые макеты; Registry/AI полностью не реализованы | AI/provider checks, бюджеты/виджеты/views, Staging acceptance и Production |

Текущий блок — [проверка и редактирование сохранённых операций](docs/architecture/live-operation-review.md). [Загрузка PDF и восстановление результата](docs/architecture/live-import-ui.md) уже подключены. Локальные adapters и конечный safe source profile передают только проверенный payload; после приёма работа сохраняется на сервере. Полный Review/History, массовые правки, прочие форматы и финальная классификация остаются впереди. Text-free profile не закрывает полноценную source restoration или strict cross-file fingerprint. [Границы второго блока импорта](docs/architecture/import-ingestion.md). [Общий план](docs/product/implementation-plan.md). Исторический [bootstrap-status](docs/architecture/bootstrap-status.md) описывает ранние этапы, не текущую готовность.

## Проверки и Development

Нужны Node.js 24 и pnpm 11.25.0. Установить зависимости: `pnpm install --frozen-lockfile --ignore-scripts`. `pnpm run check` проверяет исходники, денежное/финансовое ядро, access/import models, TypeScript и сборки web/admin/API.

`pnpm test:security` запускает PostgreSQL/HTTP integration suite на свежем изолированном PostgreSQL 18 cluster; `pnpm test:access-browser` — сквозные HTTP/browser journeys; `pnpm test:e2e` — desktop/mobile интерфейсы. GitHub CI предоставляет PostgreSQL 18.4 и Chromium. Полные результаты конкретного коммита фиксируются в PR; synthetic tests не являются real-bank/device acceptance.

Для пользовательского интерфейса — `pnpm dev:web`, для отдельной админки — `pnpm dev:admin`. Для API/worker и операторских миграций см. [API README](apps/api/README.md). Приложения используют отдельные scoped credentials; новые import tables устанавливаются миграцией 0012, отдельный Development Finance worker запускается `pnpm --filter @finance/api dev:imports`. Real statements/identifiers/passwords/credentials не помещаются в Git, logs, AI или Staging.

## Источники и выпуск

- [Исходный PDF](docs/product/master_spec_v1.pdf) и [контекст Word](docs/product/context_handoff.docx).
- [Согласованные поправки/технические решения](docs/product/baseline.md) и [порядок применения/hash manifest](docs/product/source-manifest.json).
- [План разработки](docs/product/implementation-plan.md), [checklist](docs/product/implementation-checklist.md), [реестр требований](docs/product/implementation-registry.json).

Денежные суммы — integer minor units; bank facts/user corrections/effective fields раздельны. AI использует только будущий closed versioned Registry. Подписка Pro/защита main и реальные сервисы не подтверждаются одним наличием репозитория. Услуги не приобретались, main не объединялся с новой цепочкой и Production не публиковался.

Для Production нужны полные проверки, отдельные credentials/среды/KMS/retention, принятие владельцем конкретного Staging artifact, миграции и rollback/forward-fix план. Админка не деплоит приложение.

Локальная подготовка банковских PDF: [версии парсеров, приватность и текущие границы](docs/architecture/local-bank-parsers.md).

Безопасные банковские признаки и магазины: [профиль и ограничения](docs/architecture/safe-bank-source.md).

Рабочая загрузка PDF, история и сохранённые операции: [сценарий и текущие границы](docs/architecture/live-import-ui.md).

Сохранённые операции: [редактирование, проверка, corrections и конфликты](docs/architecture/live-operation-review.md).
