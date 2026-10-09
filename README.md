# Персональный финансовый анализатор

Продуктовая база 1.3: полный Master Specification PDF, контекст Word и согласованные A/B/E. Источники неизменны; требования и их покрытие находятся в [реестре](docs/product/implementation-registry.json). Полная готовность продукта не заявляется.

## Текущий статус

Актуальная разработка — `feature/settings-rule-editors` поверх [PR №29](https://github.com/bna42rus/Financial-AI-Analyzer/pull/29), `64b5ea1718c717cee7cea0f71421962cad158e99`: [структурные настройки и персональные правила](docs/architecture/settings-rule-editors.md). Подключены Merge/Split счетов и контрагентов, перенос/объединение/удаление категорий, редактор условий AND и назначений правил, приоритет/включение/удаление, фиксированная историческая выборка и отдельное подтверждение её применения. Структурные формы имеют preview и защиту от устаревшего снимка; изменения записываются в History с Undo. Требуются миграции 0001–0016.

`main` содержит раннюю версию интерфейса. Полная актуальная версия находится в последовательной цепочке рабочих PR; продолжать финансовую разработку нужно от её проверенного конца. Результаты CI конкретного коммита указаны в PR. Подключение инфраструктуры и приёмка Staging ведутся отдельно.

| Блок | Реализовано | Что впереди |
| --- | --- | --- |
| Доступ | Серверная заявка/оплаты/приглашения/регистрация, продления/ручной доступ, email outbox, admin TOTP/recovery | Реальные провайдеры, owner onboarding, эксплуатация и полная security acceptance |
| Финансовая основа | Accounts/categories/counterparties/rules, observations/corrections, components/links/allocations, preview/commit, история, исключения, Merge/Split, удаления/reset, одиночные правки карточки, correction preview и Undo, редакторы связей/распределений | Физическое удаление/reset в UI, полные карточки/статистика, остальные массовые действия и будущие module dependencies |
| Импорт | Локальные PDF adapters/HMAC, ограниченные безопасные признаки/магазины, server validation/acceptance, durable provenance, account aliases, консервативный source dedupe, checkpoints/queue, privacy cascade, authenticated загрузка/история и чтение сохранённых операций | CSV/XLSX/OCR, более полный safe text profile, более широкие fingerprints/matching, final classification/link pass и групповые предложения Review и полный AI workflow |
| Анализатор и выпуск | Приняты базовые макеты; Registry/AI полностью не реализованы | AI/provider checks, бюджеты/виджеты/views, Staging acceptance и Production |

[Одиночные правки карточки](docs/architecture/live-operation-review.md), [отмена импортов и решения по дублям](docs/architecture/import-cancellation-dedupe.md), [объединение дубликатов](docs/architecture/duplicate-merge.md) и [редакторы связей/частей](docs/architecture/operation-relations.md) работают поверх сохранённых финансовых данных. [Загрузка PDF и восстановление результата](docs/architecture/live-import-ui.md) подключены. [Массовая правка и ручной Review](docs/architecture/review-bulk-actions.md) подключены. [Структурные настройки и редактор правил](docs/architecture/settings-rule-editors.md) подключены. Создание правил/удаления из массовых действий, физическое удаление/reset в UI, групповые предложения Review, recurring patterns, остальные форматы, финальная классификация, бюджеты и AI-Анализатор ещё предстоят. [Общий план](docs/product/implementation-plan.md). Исторический bootstrap-status описывает ранние этапы, а реестр покрытия не объявляет весь продукт готовым.

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

Следующий Development-блок — структурные редакторы Settings и правил. Фактический полный CI окончательного head фиксируется в PR.
