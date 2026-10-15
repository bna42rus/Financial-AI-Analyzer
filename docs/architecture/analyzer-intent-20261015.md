# Извлечение намерения и серверный выбор контекста

Основание: PDF 4.5, 26.1–26.8, task contract и полный аудит 170 сохранённых
ответов. Владелец 15.10.2026 согласовал смену схемы. Реализация находится
в той же feature/analyzer-model-bench; сайт и runtime AI не включались.

## Новая граница

Один completion возвращает relevance, action и только явно названные
metric/grouping/comparison, дословную ссылку на результат и edits условий.
В ответе нет binding, new/nearest, handles, keep, дат ISO вместо исходного
периода или вычисленных копеек. Нет model-generated SQL/полномочий.
Input извлекателя содержит только очищенный question и hasFinancialTasks.
Каталог, TaskBook/descriptors, filters, операции, UUID и старые totals модели
не передаются. До финансового чтения проверяется полный payload и relevance.
Ошибочный relevance не исправляется regex; он остаётся модельной ошибкой.

Программа компилирует sparse intent в прежний закрытый TaskDecision:

- Самостоятельная явно названная metric начинает задачу на текущих globals.
- Отсутствие metric продолжает последнюю задачу; отсутствие любого другого
  поля означает сохранение, а не сброс к default.
- Явный начальный связующий оборот «А/Теперь/Тогда/И» с повторённой metric
  продолжает последнюю совместимую задачу; при отсутствии такой задачи
  самостоятельная metric использует globals.
- Явная дословная ссылка разбирается программой: ordinal, ближайший или
  единственный совместимый результат. Несовместимость/неоднозначность
  требует уточнения. Модель не выбирает t1 и не видит список результатов.
- Чёткий запрос новой задачи/работы с нуля начинает новый scope. Без названной
  metric новая задача требует уточнения, а не подставляет старую метрику.
- Цитаты scalar проверяются на соответствие заявленному полю. «По категориям»
  не может подтвердить income, «такси» — grouping=none, а условие «по операциям
  не выше суммы» — список операций. Это валидация извлечения, не замена gate.

Существующие локальные ownership/catalog lookup, даты, BigInt money,
independent condition groups, manual UI touches и fixed operation boundary
сохранены. Источник расчёта — актуальная БД через прежнее общее финансовое ядро.
Неподдержанное выражение периода требует уточнения. Дополнительный attention
filter при metric=attention отклоняется, чтобы он не сохранялся скрытым условием.
Инвариантная проверка обнаружила и исправила общий баг: при продолжении
attention-задачи default operation перезаписывал уже выбранный формат; теперь
default действует только при отсутствии предыдущего представления.

## Файлы и проверка

- packages/analyzer/src/task-intent.ts — закрытый parser, compiler и prompt.
- apps/api/src/analyzer-intent-model.ts — один extraction + local proposal.
- apps/api/src/task-intent-transport.ts — json_object, прежний usage parser.
- createTestCloudIntentProvider — явное test-only подключение к существующим
  HTTP/PostgreSQL guards, commercial receipts/cache и atomic commit.
- task-intent-trial.ts / task-intent-trial-main.ts — отдельный frozen batch.

Компактная schema использует общий vocabulary значений edits; ОБЯЗАТЕЛЬНЫЙ
прежний field-specific parser дополнительно проверяет все типы, имена, цитаты
и запрещённые комбинации до cache/catalog. Ни generic schema, ни модель
отдельно не являются authority. Prompt factoring обратим без потери schema.

Локально проверены 92 слота development/repeat на независимо размеченных
literal intentions, 126 комбинаций metric/presentation/comparison/изменений
условий, запрет лишних authority полей, оплата и бесплатный replay. Scheduler
на синтетических HTTP responses проходит 120 разных request IDs. Это software
проверки, НЕ результат GPT-OSS. 28 holdout не использовались для подгонки.
Исторический реальный результат остаётся 52/92; offline audit воспроизводит его.
PostgreSQL tests дополнительно проверяют single-call HTTP, сохранение amount
scope, restart replay, billing rejected payload и отсутствие финансового чтения
после unrelated. Полный CI фиксируется отдельно по завершении.

## Один новый операторский batch

Entry point: `src/task-intent-trial-main.ts --live`; повтор той же команды
становится бесплатным saved report, в том числе после частичного результата.
68 development + 24 independent repeats; 28 holdout открываются лишь после
92/92. Максимум 120 paid completion calls. Нет оплаты второго plan, скрытых
retry, изменения prompts внутри run или подстановки golden parents.

Admission привязан к 665 записям, exact ledger head
5d5271f31c34cf41ac47712fff2718f666c85744b9df11618010968c7d4d05fb
и прежнему JSON-v1 frozen hash. Новый checkout/artifact/cache/lock отделены
от старых. Старые receipts, artifacts, holds и locks не переписываются.
Секрет остаётся в прежнем root-private key file.

Сохраняется ORIGINAL cumulative 20 RUB incremental cap от upper 20888941260,
global 45 RUB и project cap. Остаток 6.441024920 RUB. Резерв по-прежнему на
весь documented context 131072 + 1200 output tokens: 2.152001920 RUB.
Следовательно новый POST возможен, пока фактический новый расход плюс полный
следующий резерв помещаются в остаток. Для прохода всех 120 ходов расходы
предшествующих POST должны оставить резерв; меньшие bytes/один вызов не
доказывают, что это произойдёт. Budget stop честно означает неполный batch.
Лимиты/holds не уменьшаются для обхода admission.

Usage/receipt/cache fsync предшествуют проверке и private encrypted rejection
evidence. Unknown usage немедленно останавливает следующие POST. HTTP error
сохраняется в bounded encrypted capsule; console показывает fixed/redacted
diagnostics. Новый unknown hold не объявляется бесплатной ошибкой.

Fresh dispatch разрешён только 15.10.2026 Moscow с прежним подтверждённым
тарифом/metadata snapshot; после этой даты guard требует сверку. Immutable
provider revision не подтверждена. Даже успешный batch не включает AI и не
заменяет полную продуктовую приёмку 420 ходов/96 исторических regressions.

Новая схема уменьшает обязанности модели, но не доказывает универсальную
языковую точность. Новые парафразы, пропущенные/неверные mentions и отказ модели
измеряются реальным независимым запуском. Дообучение не выполнялось.
