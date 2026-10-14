# Контекст и денежный журнал Анализатора — этап 1

Основание: согласованные 14 октября 2026 года [архитектура и программа испытаний](analyzer-design-audit.md), PDF 26–29/35/51–52. Владелец разрешил реализацию и первый платный этап с общим потолком 1 000 ₽. Этот PR не включает платные вызовы, публикацию или переключение Staging/Production.

## Поведение

Для нового вопроса используются общие фильтры. Продолжение сохраняет прежний смысл и явно заданные условия; изменённые вручную общие фильтры заменяют соответствующие поля. Новый явный период в тексте важнее общего. Даты и дерево категорий обрабатываются связанными группами, чтобы старый конец периода/подкатегория не остались рядом с новыми общими условиями. Порядок IDs в выборе не означает изменение фильтра.

Сервер берёт предыдущий общий фильтр из сохранённого request своего чата, а не доверяет клиентскому утверждению о нём. Context version включён в binding внешнего запроса. Старые ответы остаются snapshots; новое продолжение рассчитывается из текущей БД. Полная память пользователя, сводки длинных диалогов, выбор более ранней задачи и морфологический resolver — следующие этапы, не обещание этого PR.

## Денежная точность

Тариф имеет version, RUB и отдельные цены за миллион входных/выходных токенов. Стоимость вычисляется BigInt в миллиардных долях рубля; округление вверх на границе этой единицы. Floating point и округление каждого вызова до копейки запрещены. Банковская арифметика остаётся в копейках.

Миграция 0025 добавляет отдельные project/user budgets и immutable cost receipts. Базовый пользовательский технический предел — 100 ₽ на anchor/месячный период access cycle. Общий предел Staging-испытания конфигурируется не выше согласованных 1 000 ₽. Проектный период задаётся оператором явно. Цена/лимиты существующего периода не меняются автоматически; root credential не предоставляется браузеру или модели.

Глобальный project reserve блокируется до user reserve; короткая metadata transaction завершается перед paid dispatch. Параллельный последний запрос не может занять уже зарезервированные деньги. При unknown receipt деньги остаются занятыми. Chat deletion очищает private plan, а технический расход и резервы сохраняются.

Customer task quota остаётся независимой: валидная завершённая задача — прежняя одна единица; technical error/clarification/unrelated не списывают клиентскую единицу, но их оплаченные вызовы учитываются в себестоимости. Покупка пакетов/клиентские кредиты и изменение лимита сверх базовых 100 ₽ пока не реализованы; таблицы намеренно не разрешают произвольный runtime top-up.

## Native Yandex dispatch

Перед генерацией бюджетный runtime отправляет тот же CompletionRequest, включая schema/role wrappers, в официальный tokenizeCompletion. Определяется реальное число входных tokens и версия модели. Затем резервируются вход и настроенный максимальный выход; reasoning в этом adapter отключён. Tokenizer не вызывает paid completion и не считается одной генерацией. Токенизация не заменяет sanitization: оба endpoint получают тот же ограниченный, уже очищенный текст.

Tokenization failure или недостаток бюджета не отправляет generation request. После отправки timeout/неполученная metadata держит reserve и не redispatch автоматически. Резерв не строится по числу байтов; byte caps 8/16 KiB остаются защитой размера, не ценой.

Нужна контрольная проверка реального provider: tokenizeCompletion count/schema overhead, maxTokens и usage semantics. Пока она не выполнена, это проверяемый механизм резервирования, а не утверждение абсолютной гарантии внешнего биллинга. Если фактические input/output exceed quote либо modelVersion отличается, actual cost всё равно сохраняется; проект блокирует новые paid calls до operator review.

## Usage при ошибках

Transport извлекает валидный usage envelope независимо от JSON/schema/finish status текста. Malformed JSON и truncated response несут bounded usage receipt в sanitized error; сырой текст не хранится. Runtime сохраняет его и денежный settlement до разбора плана. Metadata без usage означает NULL + unknown, никогда фиктивные нулевые tokens.

Not-sent, unknown и reported различаются. Preparing request до резервирования имеет not_sent; после durable quote — unknown, затем reported при receipt. Поэтому два одновременно готовящихся запроса не считаются историческим неоплаченным хвостом. Terminal receipt не заменяется другим и не списывается повторно.

Исторические обращения текущего периода без cost receipt требуют reconciliation: код не создаёт пользователю новый бесплатный месячный бюджет, игнорируя уже оплаченные вызовы. Для существующего Staging-аккаунта с октябрьскими trials это проверяется до повторного включения AI. Этот PR не даёт оператору кнопку «стереть историю ради нового лимита».

## Runtime и миграция

- AI остаётся выключен по умолчанию. Native adapter по-прежнему разрешён только Finance/Staging и истинным KMS/runtime guards.
- В действующей private ai-studio.json к прежним полям добавляется обязательный cost object. Старый файл не разрешает включить новый runtime без денежной политики.
- Новые таблицы FORCE RLS; cost receipts/user balances изолированы по app.user_id. Control/mail не читают эти таблицы или provider plans.
- Миграция 0025 additive и должна выполняться явно после 0024 при выключенном AI. Credential и политика не входят в Git. Production не поддерживается.
- Для rollback выключить AI и проверить оба API/прочие службы. Сохранять monetary receipts и dispatch history; не удалять 0025 ради повтора unknown request. Старый runtime не обеспечивает денежные caps и не должен быть включён после отката.

Синтетический пример cost object (не действующая конфигурация и не утверждённый Production тариф):

```json
{
  "projectId": "staging/finance/trial-20261014",
  "projectPeriodStart": "2026-10-14T00:00:00Z",
  "projectPeriodEnd": "2026-11-14T00:00:00Z",
  "projectLimitRub": "1000",
  "price": {
    "version": "yandex-native-trial-20261014",
    "currency": "RUB",
    "inputRubPerMillion": "800",
    "outputRubPerMillion": "800"
  }
}
```

Цена должна соответствовать выбранному modelUri, валюте/НДС и закреплённому тарифу. Gateway автоматически не подставляет текущую цену из интернета.

## Проверки

Core: изменённые/удалённые globals, coupled fields, порядок IDs, explicit message priority, точные rates/стоимость/резерв, malformed monetary values.

Transport: valid usage при bad JSON/truncation; missing usage; идентичные tokenizer/completion bodies; reserve-before-dispatch; отсутствие paid dispatch при preflight/budget failure.

PostgreSQL 18: actual settle/retry; paid errors без customer charge; unknown reserve; not_sent; последние деньги параллельно у одного/двух users; immutable receipt/price; provider overshoot freeze; RLS/control/mail; chat deletion; legacy reconciliation. Authenticated Finance HTTP проходит новый cost-enabled path и failure path.

Полный 180-case каталог и 420 реплик/модель не выполнены этим PR. Cloud.ru adapter, общий Gateway workflow, benchmark runner, интернет, документы/калькуляторы, merchant knowledge, полная память, новая регистрация и UI corrections остаются отдельными этапами согласованного проекта. Итог CI фиксируется на конкретном commit в PR; синтетический transport не подтверждает цену/качество реальной модели.

## Первичные источники API

- [Tokenizer.TokenizeCompletion](https://aistudio.yandex.ru/ru/docs/ai-studio/text-generation/api-ref/Tokenizer/tokenizeCompletion): принимает CompletionRequest с jsonSchema; возвращает tokens и modelVersion.
- [Тарифы Yandex AI Studio](https://aistudio.yandex.ru/ru/docs/ai-studio/pricing): проверить currency/НДС, цену модели и условие бесплатной токенизации перед испытанием.
