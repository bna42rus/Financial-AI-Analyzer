# Yandex Analyzer: ограниченное испытание Staging

Основание: полный PDF 26–29, 35.4–35.6, 51–52; утверждённые A-02/A-06/B-09/E-05. Этот этап подключает только планирование чтения по расходам, доходам и операциям, требующим внимания. AI-классификация импорта, планирование изменений естественным языком, web search и обработка страниц документов ещё не подключены. Существующие Registry v2, детерминированные расчёты и ручные preview/commit/Undo сохранены. Production model и production AI activation не утверждены.

## Контракт и приватность

Используется синхронный native REST `POST https://ai.api.cloud.yandex.net/foundationModels/v1/completion`. В каждом запросе передаются `x-data-logging-enabled:false`, фиксированный HTTPS host, `stream:false`, JSON Schema, ограниченный `maxTokens`, отключённое reasoning. Redirects и автоматические retries запрещены. API этого метода игнорирует `tools`; поэтому модель возвращает JSON-план, который backend разбирает через закрытый Registry и проверяет ownership. Доступа к произвольным SQL, административным данным или исполнению кода нет.

Первый запрос видит только sanitized question и признак наличия финансового контекста. Для `unrelated`/`ambiguous` backend сохраняет короткий статический ответ и не загружает граф операций или каталог. Только после финансовой релевантности второй запрос получает bounded каталог собственных названий счетов, категорий и контрагентов, разрешённые фильтры и текущую московскую дату. Операции, суммы результатов, банковские строки, descriptions, comments, HMAC aliases, email, sessions и credentials в модель не передаются. Browser выполняет sanitization, backend повторно проверяет вопрос и outbound labels. Чувствительные идентификаторы отклоняются до первого внешнего вызова.

Модель возвращает только read plan, clarification или unsupported. Явные даты заменяют глобальные даты; прочие условия backend сохраняет. Follow-up использует семантические условия предыдущего ответа, затем backend заново считает по актуальной базе. Все денежные результаты рассчитывает finance-core в integer minor units. AI не получает финансовый ответ для пересказа.

`x-data-logging-enabled:false` выключает improvement logging; это не обещание отсутствия всех service/audit logs и retention. Hosted Conversations, Responses state storage, tracing, uploaded files и async jobs здесь не используются. Политику хранения поставщика и регион нужно проверить отдельно перед Production.

## Учёт и сбои

Миграция `0024_yandex_analyzer.sql` добавляет технический `commerce.analyzer_request` и приватный `finance.analyzer_provider_plan`. Dispatch и проверенный receipt фиксируются отдельным scoped `finance_api` connection до завершения финансовой транзакции. Этот pool не берёт access/workspace locks и не ссылается на их строки, поэтому откат финансовой транзакции не теряет факт внешнего обращения.

Состояния: `sent`, `received`, `completed`, `failed`, `unknown`. `sent` после сбоя и `unknown` не отправляются повторно автоматически. Exact retry сверяет fingerprint/Registry/generation/revision и переиспользует сохранённый проверенный план. Если данные изменились или cache удалён, запрос блокируется; пользователь начинает новый вопрос. Неизвестный исход требует отдельного разбора оператора; автоматического освобождения резерва нет.

Одна успешная обычная AI-задача списывает одну единицу пользовательского лимита. Gate и planner tokens учитываются вместе; journal хранит этапы раздельно. Детерминированные расчёты, unrelated/clarification и некорректные планы пользовательский лимит не списывают. Принятый planner `sent/received/unknown` резервирует единицу до подтверждения/разбора; interface показывает used, remaining и reserved. Billing использует исходные `anchor_at` и `period_start` принятого запроса, включая retry после смены периода; точный retry не списывает вторично.

Отдельный технический дневной предел считает **каждое** внешнее обращение, включая gate, отказ, неизвестный исход и некорректный ответ. Обычный финансовый вопрос обычно требует двух обращений. Предел сохраняется после удаления чатов и финансового reset. Он ограничивает количество попыток, а не обещает конкретную стоимость в рублях.

Parsed plan cache имеет FORCE RLS и следует каскаду удаления chat/source/full reset. Технические dispatch tombstones и billed usage сохраняются, не содержат вопроса, provider transcript или финансового результата и не возвращают квоту. Control и mail не имеют доступа к request/cache; Control сохраняет прежний доступ только к техническому billed usage.

## Включение и отключение

По умолчанию AI выключен. `AI_ENABLED=1` разрешён только для `APP_ENV=staging`, `API_PROFILE=finance`, настоящего KMS runtime и локальной `finance_staging` на порту 5411. Metadata pool использует ограниченную роль `finance_api`; privileged owner URL ему не передаётся. Control и Production не могут включить адаптер.

Настройки — приватный JSON `ai-studio.json`, переданный через systemd `LoadCredential`. API key не передаётся в environment, аргументах процесса, browser bundle, Git или чате. Source credential root-owned 0600; в сервисе используется отдельная приватная копия 0600, как для действующих KMS credentials. Finance wrapper должен условно добавить `ai-studio.json`; Control wrapper не получает этот credential.

Поля настройки: `realm=staging/finance`, `apiKey`, `modelUri`, `allowedEmails` (1–5 точных адресов), `maxDailyCalls` (1–30), `maxTokens` (128–2048), `timeoutMs` (1000–10000). Разрешены явные native model URI `gpt://<folderId>/aliceai-llm`, `/yandexgpt-5.1`, `/yandexgpt-5-pro`, `/yandexgpt-5-lite`; aliases `latest` и arbitrary endpoints запрещены. Разрешённая семья ещё не означает принятого качества для всего Analyzer Registry. Для испытания нужны отдельный service account с ролью `ai.languageModels.user`, подходящий API key и решение владельца о лимите реальных обращений.

Порядок: immutable build конкретного проверенного commit → additive migration 24 только в Staging → Finance credential/private copy → Finance-only drop-in → restart/health → browser acceptance с реальным провайдером. Действующие BasicAuth/Caddy маршруты сохраняются. Перед изменением deployment проверяются фактические symlinks, Caddy roots и unit drop-ins; Production не затрагивается.

Отключение: `AI_ENABLED=0`, restart Finance API, проверка health и детерминированного вопроса. Миграция совместима с отключённым адаптером; таблицы с billing/dispatch не удаляются и лимит не обнуляется. Для rollback к прежнему backend снимаются только новые AI credential/drop-in изменения, восстанавливаются сохранённые backend/frontend symlinks и проверяются оба API, import/mail workers и HTTPS. Нельзя удалять технический журнал ради повторной отправки неизвестного запроса.

## Проверка

CI использует отдельный disposable PostgreSQL 18 и синтетический HTTP transport без внешнего ключа. Проверяются native contract, bounded response/final status/schema, sanitization, ownership, финансовый gate, квота/резервы, concurrency, rollback/retry, точный anchor, daily cap, RLS, deletion и startup boundaries. Дополнительно выполняются существующие Analyzer/auth/mail/owner tests, pure finance tests, type checks и обе frontend builds.

Успешный CI не подтверждает реальные schema quality, доступность выбранной модели, retention, регион или фактическую стоимость. Они проверяются отдельным bounded live испытанием после приватной настройки Staging.

Официальные источники, проверены 13.10.2026:

- [Native completion API](https://aistudio.yandex.ru/en/docs/ai-studio/text-generation/api-ref/TextGeneration/completion)
- [Отключение improvement logging](https://aistudio.yandex.ru/en/docs/ai-studio/operations/disable-logging)
- [Аутентификация](https://aistudio.yandex.ru/en/docs/ai-studio/api-ref/authentication)
- [Модели и поддерживаемые API](https://aistudio.yandex.ru/en/docs/ai-studio/concepts/generation/models)
- [Structured output](https://aistudio.yandex.ru/en/docs/ai-studio/concepts/generation/structured-output)
