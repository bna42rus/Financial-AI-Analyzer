# Фиксированное испытание текущего query workflow

15.10.2026. Основания: PDF 4.5, 26.1–26.9, 27; task-contract и полный
saved audit. Это отдельный ограниченный pilot существующего read-only
`analyzer-task-protocol/2`, а не новая версия старого smoke prompt.

## Что подготовлено

`apps/api/test/fixtures/task-trial-corpus-v1.json` содержит заранее написанные
вопросы, ожидаемые Query, связи с предыдущими результатами и точные totals.
Эталоны не получаются из `interpret()`, ответов кандидата или генератора,
который одновременно выводит формулировку и правильный ответ. При загрузке
все Query проверяются закрытым parser, owned synthetic IDs и общим финансовым
ядром на шести синтетических операциях. Это проверка согласованности эталонов,
не показатель точности языка модели.

| Часть | Отдельные вопросы | Диалоги по 6 ходов | Реплики |
|---|---:|---:|---:|
| Development | 32 | 6 | 68 |
| Holdout | 16 | 2 | 28 |
| Независимые повторы 12 development вопросов, ещё по 2 раза | 24 | 0 | 24 |
| Всего | 72 | 8 | 120 |

Идентичные повторные HTTP bodies получают разные occurrence=1/2 в request ID;
повтор того же ID остаётся replay и не считается независимым испытанием.
ID связывает версию эксперимента, manifest SHA-256, case ID, gate/plan и occurrence.
Верхний предел плана — 240 completion calls: максимум два на реплику.
Gate может законно завершить реплику до proposal; фактическое число ниже.

Holdout не имеет точных совпадений с прежними 96 smoke/transfer репликами
(сравнение также нормализует регистр, пробелы, ё и конечную пунктуацию).
Это не доказывает независимость семантики или представительность всех будущих
пользователей. Набор написан разработчиком по контракту, независимого внешнего
разметчика нет. После первого просмотра результатов holdout его нельзя
использовать как свежий holdout следующего адаптивного цикла. Prompts/schema
runtime в этой подготовке не менялись.

## Что проверяется

- Financial/adjacent и отрицательные контрасты медицинских, программных,
  арифметических операций; неясные реплики без задачи.
- Расходы/доходы/проверка операций; число, категории, операции, previous_same.
- Приоритет явного периода, Moscow currentDate, текущий/предыдущий месяц,
  точный диапазон и високосный месяц.
- Родитель/подкатегория, неизвестное имя, выбранный UI scope.
- Рубли/копейки, единый масштаб диапазона, строгая и включительная граница,
  signed versus absolute amount basis.
- Новая задача и сброс прежних условий, продолжение, возврат к первому
  результату, сохранение grouping/comparison при смене категории/периода.
- Ручные изменения UI period/stamps, снятие категории/суммы/сравнения,
  фиксированная граница operations.
- Unrelated, clarification и unsupported не стирают последнюю успешную задачу.
- Неподдержанные записи, web, merchant grouping и component thresholds явно
  не становятся похожим чтением.

Оценка вызывает тот же `runAnalyzerTask` и `calculateWidget`, что software
проверки нового пути. В модель не передаются эталоны, каталог, UUID, старые
totals или строки операций. Раздельно возвращаются relevance, status, binding,
каждое scalar/filter поле, точный total и запрет финансового доступа после
нефинансового gate. Ошибочная ранняя задача не заменяется правильной:
последующие ошибки помечаются earlierFailure, оставаясь в общем результате.

Этот pilot не заменяет согласованные 420 реплик всей продуктовой программы.
Не выполнены и 96 ранее виденных регрессий под новым протоколом. Нет приёмки
категоризации, документов, поиска, всех Registry actions, финального свободного
ответа модели или обучения. Прежние 612 software tests и новые unit tests
используют синтетический provider и не доказывают языковую точность GPT-OSS.

## План бюджета и остановок

Старый журнал остаётся в исходном виде: known cost 13,372140620 ₽ + unknown
holds 7,516800640 ₽ = upper bound 20,888941260 ₽. Операторский вывод VPS
совпадает с проверенным экспортом. Показанные провайдером 489 запросов,
около 475 тыс. токенов и уменьшение баланса на 13,37 ₽ совпадают с агрегатами
журнала до округления. Это агрегатная сверка, а не три новые индивидуальные
квитанции с доказанным нулевым расходом.

План следующего ограниченного эксперимента: **не более 20 ₽ дополнительных
cost+holds** внутри прежних 45 ₽. Даже весь этот дополнительный предел вместе
с прежним upper bound равен 40,888941260 ₽. Он не увеличивает approved cap,
не освобождает 7,52 ₽ и не обещает, что весь набор обязательно поместится.
До каждого будущего dispatch нужен полный reserve, сейчас 2,152001920 ₽
при прежнем тарифе/окне; из-за него остановка может наступить раньше, чем
израсходованы все 20 ₽. Точный применимый тариф ещё надо подтвердить.

Будущий paid runner обязан до сети fsync-ить reserve в том же cumulative
учёте, проверять incremental/global cap и maximum calls, не повторять unknown,
сохранять расходы parse failures, останавливать новый unknown/model drift,
и исполнять один замороженный набор без редактирования prompt между фазами.
Development и повторы выполняются до holdout. При их провале holdout остаётся
нетронутым; результаты разбираются по всему завершённому development набору,
а не по последнему failed вопросу. Критическая ошибка scope/ownership/money
блокирует принятие независимо от среднего процента. Незавершённый набор
никогда не получает статус passed.

**Эти правила реализованы в отдельном `--live-pilot` и проверены fault/replay/
budget тестами.** Прежние paid flags остаются paused; preflight не начинает
генерацию и не имеет env bypass. Тариф и окно подтверждены; immutable revision
Cloud.ru не выдаёт. Поэтому разрешён только ограниченный provisional pilot
наблюдаемого сервиса, внутри уже утверждённого бюджета. Он не является
приёмкой неизменяемой модели и не разблокирует runtime/staging/release.
Alias/fingerprint не объявляются immutable версией. Это явное ограниченное
допущение после preflight, а не замалчивание прежнего условия допуска.

## Одна бесплатная команда оператора

`src/task-trial-main.ts --dry-run` проверяет весь корпус и даёт manifest с
hashes corpus, source files, prompts/schema, versions, sampling, budget и IDs.
Не читает keys/ledger и не вызывает сеть.

`sudo /usr/bin/node --import tsx src/task-trial-main.ts --preflight`:

1. Проверяет protected directories и читает прежний ledger read-only.
2. Проверяет точные cost/counts и личности всех трёх старых unknown.
   Изменившийся baseline останавливает её до credentials/сети.
3. Читает существующий root-only Cloud key в памяти и делает ровно один
   `GET https://foundation-models.api.cloud.ru/v1/models`, с timeout и запретом
   redirects. Нет POST completions, retry, reserve, нового lock или записи ledger.
4. Выводит exact model alias, hash его metadata, только разрешённые числовые
   поля и наличие version/context/pricing полей; произвольный provider text и
   ключ не выводятся. Alias остаётся unverified даже при наличии поля revision.
5. Снова проверяет, что ledger не изменился за время GET. Выводит paidCalls=0,
   неизменные расходы и конкретные незакрытые условия paid trial.

Официальные первоисточники, просмотренные 15.10.2026:

- https://cloud.ru/docs/foundation-models/ug/topics/api-ref__specs — GET models
  и POST chat/completions; catalog не является доказательством неизменности.
- https://cloud.ru/docs/foundation-models/ug/topics/overview__available__models
- https://cloud.ru/docs/foundation-models/ug/topics/guides__llm-prompt-request
- https://cloud.ru/docs/foundation-models/ug/topics/guides__activity

Новый прямой просмотр **current-version PDF версии 261015**, стр. 8,
строки 271/272, подтвердил тариф внутреннего gpt-oss-120b: 15,86 ₽ вход /
61 ₽ выход за миллион, с НДС. Отдельные partner-model строки 193/194 не
подставляются вместо них. Числовые ставки прежние, legacy price version
сохранён ради совместимости квитанций; свежая authority/version 261015
отдельно связана с pilot artifact. Предыдущие расходы не пересчитываются.
Pilot имеет currentTariffConfirmed=true и immutableModelVersionVerified=false;
ordinary preflight manifest сам по себе по-прежнему не разрешает оплату.

## Проверка подготовленного кода

На commit `20af685e30836981080e983c54218d09d15c8f19` полный CI
[38738230119](https://github.com/bna42rus/Financial-AI-Analyzer/actions/runs/38738230119)
успешен: **625/625** (246 core, 132 API unit, 82 web, 161 PostgreSQL 18.4,
4 Chromium browser tests desktop/mobile). Включены 13 новых проверок
корпуса, оценки, отсутствия повторного dispatch и GET-only preflight.
Все model responses синтетические; платных вызовов ноль. Команда оператора
должна использовать этот точный проверенный source commit. Следующий
evidence-only commit не меняет исполняемые файлы.

## Реализованный операторский запуск и отчёт

`sudo /usr/bin/node --import tsx src/task-trial-main.ts --live-pilot` — явно
платный операторский режим. Никакого production/staging flag нет. Он действует
только 15.10.2026 по Moscow, дате свежей проверки тарифа; перед каждым новым
POST дата проверяется снова. На другой день нужны актуальная проверка тарифа
и новый проверенный artifact. Сохранённый отчёт доступен независимо от даты.

CLI проверяет private state directories, неактивность прежнего operator PID
и эксклюзивно берёт общий diagnostic.lock. До ключей/сети проверяется ledger
и неизменность frozen state. Первый запуск требует ровно проверенный baseline
492 records /13,372140620 ₽ known /7,516800640 ₽ holds. Private artifact
`task-pilot-v1.json` содержит hash полного code/prompt/schema/corpus/price/
provider binding, digest всех прежних reserve/receipt, их IDs и исходный
upper bound, allowlist новых 240 request IDs и cap. Создаётся только `wx`,
0600 + fsync file/directory; никогда не заменяется. Его отсутствие после
новой оплаченной записи не позволяет снова выдать начальные 20 ₽.

На каждом live-вызове один GET каталога заново сверяет snapshot
`b27d11d11429899c431d95d974e69a5dfb7e56797fe127584992a2782432db68` и оба
context limits 131072 с операторским preflight. Это detection gate, не
доказательство неизменности весов. Provider model, bounds и fingerprint
каждой квитанции проверяет прежний ledger; drift останавливает новые POST.

Перед POST fsync reserve в исходном smoke-ledger, с сериализованной проверкой
20 ₽ incremental cost+holds и старых 45 ₽ global. После HTTP usage fsync-ится
в исходный ledger **до** closed parser и cache. Ledger value содержит только
wire SHA, без сырого provider text. Закрытый payload после этого сохраняется
в private 0700 cache, каждый файл 0600 + fsync. Invalid payload получает
фиксированный код и null cache, сохраняя стоимость. Отражённый ключ также
отклоняется в payload/fingerprint. Отсутствующий/повреждённый cache после
квитанции — явная остановка, никакой повторной оплаты.

Неизвестная доставка/usage оставляет полный reserve и lock. Receipt fsync
failure не повторяет запись/dispatch. При обычной известной ошибке private
cache или semantic failure lock можно освободить: дальнейший повтор всё
равно упирается в существующую квитанцию/отсутствующий cache. Никакие прежние
unknown receipts или operator evidence locks не снимаются/не исправляются.

Порядок: 68 development →24 independent repetitions → только после всех
**92 точных успешных slots** — 28 holdout. На semantic failure выполняется
полная доступная development/repetition часть для общего разбора, но holdout
не открывается. Unknown usage, budget, drift, cache/ledger faults прерывают
дальнейшие вызовы сразу. Неполный набор не проходит; даже **120/120** означает
лишь `provisional_pilot_passed`, с `modelAccepted=false`,
`immutableModelVersionVerified=false`, `runtimeAiEnabled=false`.

Прогресс печатается после каждых шести завершённых реплик. Итог содержит
stop/phase, завершённые/успешные реплики, отдельные field metrics, failed
rows, technical error codes, paid attempts/replays, incremental и общий cost.
`paidCallsThisRun` считает новые попытки отправки; фактический расход отдельно
подтверждают receipts, а unknown удерживает reserve.

После запуска бесплатный разбор:

```sh
sudo /usr/bin/node --import tsx src/task-trial-main.ts --report-pilot
```

Он не читает keys, не вызывает даже GET, не создаёт lock/cache/receipt и
восстанавливает тот же actual context из сохранённых payload. Запись, которой
нет, остаётся пропуском с `BENCH_REPLAY_ONLY`; completed prefix остаётся
видимым. Прежний `--preflight` проверял baseline до оплаты; после новых
records используется именно `--report-pilot`, а не новый сброс baseline.

Software positive scheduler test использует один синтетический вопрос во
всех 120 slots: это проверка фаз, стоимости, replay и критериев завершения,
не замена языкового испытания настоящего фиксированного корпуса. Другие
fault tests проверяют реальные shared workflow/HTTP/parser/finance paths.
