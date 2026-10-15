# Задачи Анализатора: контракт условий и исполнение

15 октября 2026 года. Основание: PDF 4.5 и 26.1–26.8; согласованный
analyzer-design-audit.md F03–F08, F16, F22–F23; полный разбор сохранённых
решений в analyzer-benchmark-audit-20261015.md. Это следующая реализация
общих правил после аудита, а не очередная инструкция под один failed вопрос.

## Статус

Реализованы task-context/1, task-protocol/2, task-literals/1 и task-workflow/1.
Новый workflow подключён к PostgreSQL, HTTP и адаптеру Cloud через **явно
заданную тестовую конфигурацию**. Он считает через то же calculateAnalyzerQuery /
calculateWidget / queryOperations, что прежний путь; отдельной финансовой
арифметики нет. Миграция 0026 добавляет private TaskBook, globals/stamps,
идемпотентные claims/cache/cancellation и server chatEpoch.

Runtime без taskProvider сохраняет прежний путь. Новый provider factory
принимает обязательный подставной fetch, использует синтетический ключ и
допускается сервером только в environment=test. Реальный default network,
loader Cloud-ключа или staging enable switch не добавлен. Платный CLI остаётся
заблокирован. Новая языковая точность GPT-OSS ещё не измерена; обучение, платные
вызовы, применение миграции на VPS и деплой не выполнялись.

OperationsFilter имеет additive amountBasis; его прежний signed смысл без поля
сохранён. Registry — analyzer/3, query_finances — версия 2. Другие инструменты
и permissions не расширены. Полная проверка provider payload теперь происходит
до кеширования и до раннего выхода по отсутствующей задаче/категории.

## 1. Две разные задачи модели

Gate возвращает только relevance. Он видит очищенный текущий вопрос,
наличие финансовых задач и статические возможности приложения. Нет followUp,
каталога, UUID, сумм результатов, операций или истории сообщений. Термины
интерфейса («операции требуют внимания», «Нужно проверить») определены как
финансовые; медицинские/программные/арифметические операции без финансового
смысла — отрицательные контрасты. Это определение, ещё не измеренная точность.

Только financial/adjacent допускаются к proposal. Ambiguous/unrelated не
читают каталог и не исполняют финансовое ядро. Никакого regex-обхода неверного
gate нет: соответствующий software test намеренно сохраняет его неправильный
отказ видимым. Unsupported/невалидный proposal не превращается в похожий Query.

Proposal раздельно задаёт binding задачи, scalar edits и изменения условий.
JSON Schema и локальный закрытый parser проверяют структуру, типы и допустимые
комбинации. Модель не вычисляет деньги, не выдаёт SQL/операции или полномочия.

## 2. Выбор задачи и история результатов

TaskBook принадлежит owner+chat+server chatEpoch+financial generation. Новый вопрос берёт
текущие globals; продолжение использует выбранный семантический результат.
Каждый успешный расчёт добавляет неизменяемый node с parent; предыдущий node
не переписывается. Сохраняются Query, globals snapshot, источники условий и
фиксированная граница операций. Старые totals, reasoning и transcript в книгу
не добавляются. До 100 nodes соответствует существующему пределу сообщений;
переполнение явно останавливает обработку, не выбрасывает ранние задачи.

| Selector | Значение | При отсутствии/конфликте |
|---|---|---|
| new | Новая самостоятельная задача | Metric должен быть задан; иначе уточнение |
| nearest | Последний совместимый результат по metric/comparison | Уточнение, без случайного fallback |
| unique | Одна совместимая логическая задача, её последняя подходящая версия | Несколько задач → уточнение; версии одной задачи не создают ложную неоднозначность |
| ordinal | N-й совместимый сохранённый результат в порядке создания | Неверный номер → уточнение |
| reference | Конкретный t1…t100 из текущего списка результатов | Неизвестный handle → уточнение |

Модели доступны лишь временные handles, parent/task handles, metric, grouping,
comparison. Каталоги, фильтры задач, их UUID/суммы не отправляются. Handle не
даёт authority: ownership и актуальность ссылок проверяются до расчёта.
Уточнение/redirect/unsupported/ошибка ничего не добавляют и не стирают последнюю
успешную задачу. При удалении чата или reset generation прежняя книга не может
быть загружена как контекст другого чата/нового financial workspace.
chatEpoch меняется при каждом создании чата: удаление и повторное создание
того же chat UUID не позволяет запоздалому ответу воскреснуть в новом чате.
В persistence/guard нельзя подменять эту проверку одним существованием chatId.

Новый путь пока поддерживает существующие три метрики и три представления.
«По магазинам»/другие ещё не реализованные Registry capabilities остаются
неподдержанными, а не переименовываются в категории. Полный task graph действий,
pending actions и сохранение period expressions сверх resolved dates/message
provenance остаются отдельной интеграционной работой F01/F05.

## 3. Жизненный цикл условия

| Операция | Поведение | Следующий ход |
|---|---|---|
| keep | Не меняет выбранное условие | Сохраняется прежнее происхождение |
| set | Заменяет только данную группу | Источник — текущая реплика |
| clear | Снимает условие, включая его парные поля | Отсутствие не превращается обратно в прежнее значение |
| use_current | Берёт текущий UI filter, включая отсутствие | Это явное решение текущей реплики |

Пустой массив — реальный пустой отбор, не синоним clear. Период, posted period,
категория/подкатегория/признаки, money bounds+basis, merchant+exact и другие
связанные условия заменяются группами. Дата/категория не сбрасывают grouping
или comparison. Новая родительская категория удаляет старую leaf даже при том
же parent ID; отдельный новый noSubcategory сохраняет выбранный parent.
Разные root+leaf в одном OR-отборе, который текущий AND filter не выражает,
требуют уточнения. Неизвестные/двусмысленные names разрешаются только локально;
первое совпадение, выдуманные parents и UUID модели не принимаются.

GlobalSnapshot содержит revision и touched stamps групп. При продолжении
изменённая/удалённая вручную группа заменяется текущим UI-значением, затем
применяются явные edits вопроса. Stamp позволяет заметить ручной возврат к
тому же значению между двумя репликами; сравнения одного JSON недостаточно.
Перестановка множества IDs сама по себе изменением не считается. Старые и
невозможные revisions отклоняются. Runtime/UI обязаны сохранять эти stamps;
UI накапливает touched группы в ServerFinance, включая A → B → A при переходах
между экранами, и фиксирует snapshot перед отправкой вопроса. После сетевой
ошибки повторяется тот же write ID/body; CAS conflict показывается без
автоматического overwrite. Очередь до ACK находится в памяти текущего workspace;
после ACK revision/stamps сохраняются на сервере. Полная browser acceptance
нового opt-in пути остаётся отдельным условием допуска.

Fixed operation IDs хранятся отдельно. Модель не имеет соответствующего edit.
Новый UI selection может сузить исходную границу; чужие/другие IDs не попадают
в неё. Снятие обычного фильтра не снимает эту границу. Это дополнительное
ограничение, а не доказательство прав: authorizeQuery обязателен при исполнении.

## 4. Даты и деньги

Set периода требует дословную цитату текущего вопроса. Сервер разбирает
закрытую grammar: календарный месяц/год, ISO day/range, диапазон дней одного
месяца, сегодня/вчера, текущий/предыдущий месяц, последние N дней, скользящие
и полные месяцы. Используется серверный currentDate, первоначально Moscow.
Текущий месяц заканчивается сегодня; leap boundaries и clamping проверены.
Непокрытое выражение («после зарплаты», несколько отдельных периодов и т. п.)
не подменяется selectedPeriod. Поддельный period quote не исполняется.

Money expression тоже цитируется полностью: comparator, сумма/диапазон,
масштаб, рубли/копейки. Модель не присылает вычисленные minor units. Общая
единица/масштаб диапазона применяется к обоим голым endpoints: «от 40 до 90
тысяч рублей» → 4 000 000…9 000 000 копеек. Строго >/< сдвигает границу на
одну копейку через BigInt, без float. «До N» без уточнения включительности
сейчас явно не принимается; проценты/overflow/противоречие comparator тоже.

| Basis | Что отбирается | Что считается |
|---|---|---|
| Отсутствует / signed_operation | Signed amount всей effective operation; прежний UI смысл | Обычные terminal portions выбранной metric |
| absolute_operation | Модуль amount всей effective operation | Те же terminal portions, с сохранением знака refund/neutral/component semantics |
| metric_part | Порог части/компонента/метрики | Сейчас явно unsupported; не подмена whole-operation threshold |

Обычная новая NL «сумма операции от положительного N» в протоколе имеет
absolute_operation; явная signed/отрицательная сумма — signed_operation.
Это правило нового протокола, оно не меняет прежние goldens/receipts/filters.
Отрицательные absolute bounds отклоняются. Parent не складывается с parts,
и порог размера всей смешанной операции не становится порогом её расходной
части. Для компонентных порогов понадобится отдельное согласованное расширение.

Цитата доказывает присутствие текста, а не правильность всего языкового
решения. Ошибочный выбор relevance/task/grouping/comparison или meaning basis
остаётся модельной ошибкой и должен быть виден в независимой приёмке.

## 5. Исполнение, конкуренция и следующие ворота

Workflow вызывает обязательный guard до модели и после await: owner/access,
chat lifetime, cancellation, data/global revision и book head. После имени
повторно authorizeQuery, затем calculate по текущему ядру. После расчёта ещё
guard; commit получает ожидаемые owner/chat/generation/revisions/head/count
и должен атомарно сохранить ответ+книгу. Ошибка catalog/auth/storage не
маскируется под языковое уточнение. Повтор messageId останавливается до модели.
Нет default network/model/retry. Adapter отдельно учитывает provider usage, в том числе parser failure.
Синтетический HTTP проверяет этот же учёт без реального платного dispatch.

## 6. Реальное хранение, HTTP и учёт провайдера

`analyzer-task-store.ts` берёт owner только из заново проверяемой серверной
сессии. Auth IDs — bounded opaque text, финансовые объекты и lifetime — UUID.
Claim до модели фиксирует question, TaskBook, global/data revisions, currentDate
Moscow и точные quota timestamps. Повтор после перезапуска использует сохранённый
claim; ID с другим input/provider binding отклоняется. Во время сети нет общей
auth/workspace блокировки и занятого финансового соединения. Короткие транзакции
снова проверяют session/access, generation/epoch, cancellation, data/global
revision, quota period и head/count. Answer + dependencies + book + customer unit
+ completed claim сохраняются одной транзакцией. Исторический answer остаётся
snapshot; новый вопрос заново считает текущую БД.

Cancellation имеет tombstone даже если обогнала создание claim. Поздний gate
не запускает plan; поздний plan не создаёт ответ. Chat deletion удаляет private
claim/cache/book; повторное создание того же chat UUID даёт новый epoch.
Изменение generation при **частичном удалении** отменяет pending claims, но не
удаляет посторонние диалоги: зависимые чаты убирают существующие reference/
dependency triggers, surviving completed books явно rebind к новой generation.
При полном reset с ротацией key_version удаляются все чаты и globals. Удалённая
UI reference помечает globals invalidated: dispatch закрыт до валидного явного
snapshot; прочие условия и монотонные stamps не стираются.

`analyzer-task-provider.ts` связывает точные HTTP body bytes, prompt/schema/input,
все protocol/resolver/transport/response versions, model/bound, цену и project
budget с immutable commercial request fingerprint. Он использует исправленный
аудированный Cloud response parser (empty tools допустимы, function calls нет).
Полный context-window reserve фиксируется до HTTP; usage сохраняется и стоимость
settle **до** разбора смысла/записи private cache. Известный расход не исчезает при
parser failure, cancellation, deletion или rollback. Receipt без cache не
повторяется платно. Received gate/cache переживает restart, отправляется только
отсутствующий plan. Unknown usage сохраняет полный hold и закрывает новые
обращения пользователя; сетевого retry/fallback нет. Customer unit списывается
только за успешно сохранённый финансовый ответ, отдельно от technical cost.

Старый runtime использовал JS Date для period_start и терял микросекунды.
Теперь новые записи используют точные DB timestamps, quota читает также старый
millisecond alias, а cost reservation переиспользует прежний budget bucket.
Unique index исключает второй bucket одного периода при overlap старого/нового
кода. Найденные до миграции duplicate aliases блокируют её для явной сверки;
исторические квитанции, цены, balances и holds автоматически не переписываются.

## 7. Проверки и оставшиеся ворота

Повторный GitHub Actions run **38709689304 /attempt 2** на commit
`8cf5e34b514c38fda809d6c196fe4fab62636dd2` завершился успешно: **161/161**
на целевой **PostgreSQL 18.4**, плюс все unit/core/web/types/build/spec этапы.
Первый attempt не запускал job из-за исчерпанной квоты; после самостоятельного
перевода репозитория владельцем в public обычный GitHub runner смог выполнить
проверку. Платные вызовы модели не запускались. Ниже сохранён отдельный локальный
результат PostgreSQL 16, он не подменяет успешно выполненный target CI.


Локально проходят **246 core +119 API unit +82 web tests**, API/Finance/Control
types, обе сборки и проверка source integrity. В реальной disposable
**PostgreSQL 16.15** применены все 26 миграций и выполнены **161** проверки:
**160 прошли**, единственная ошибка — существующий строгий assert целевой
версии PostgreSQL 18. Он не ослаблен/не пропущен. Все **16 новых HTTP/PostgreSQL**
сценариев проходят, включая restart/cache loss, cancel-before-claim,
in-flight cancel/delete/recreation, revision/access changes, RLS/role isolation,
legacy quota/budget aliases, partial deletion и invalidated UI reference.
Локальный контейнер предоставляет только mapped root; запуск PostgreSQL
использовал временный process UID shim, не менявший SQL/RLS или product code.
Это PostgreSQL-проверки реального хранилища, но **не** приёмка целевой версии 18.

Три новые UI queue проверки добавлены к прежним 79. Model responses в software
тестах синтетические. Полная прежняя выгрузка 492 записей /268 ходов повторно
даёт побайтно тот же review JSON, исходный SHA-256 сохранён. Paid calls=0,
13.372140620 RUB reported tariff cost и 7.516800640 RUB historical holds прежние.

До paid trial остаются замороженные development/holdout и независимые repeat IDs с budget /
stop rules; контролируемый реальный trial adapter и проверяемая model version.
Новая factory не может включить Cloud на сайте. Существующие goldens и результаты
не переоцениваются новым parser; 24/24 прошлой версии не объявляется качеством
этого протокола. Миграция/rollback указаны в integration evidence.

Браузерная проверка нового пути добавлена в CI отдельно для desktop/mobile:
A → B → A между экранами; потерянный ACK с тем же ID/body; CAS conflict другого
клиента; reload во время provider wait и отмена; подтверждение удаления диалога
и снятие pending UI; отсутствие горизонтального переполнения и browser errors.
Для неё используется подставной HTTP provider, не реальная модель. На commit `ddbb4a3a74884a9d9ce89339eda1181e32a2798a` в CI run
**38727206822** все четыре browser tests прошли (два новых и два прежних,
оба viewport). Общий результат этого CI — **612/612**, PostgreSQL 18.4.
Браузерный этап закрыт для synthetic-provider конфигурации. Старый browser flow
с History/Undo и подтверждёнными правками включён рядом как compatibility check.

### 7.1. Исправление состояния ожидания в UI

При удалении диалога, к которому относился восстановленный pending request,
UI теперь снимает pending/retry и отсекает старый execution counter. Такая же
проверка выполняется при загрузке списка чатов, если chat исчез или epoch уже
другой. Иначе composer мог оставаться заблокированным после правильного server
cascade. Desktop/mobile browser подтверждают исчезновение кнопок ожидания,
отсутствие воскресшего ответа и доступность нового вопроса после удаления.

Новый browser fixture явно очищает commerce.access_cycle между viewport cases,
поскольку canonical paid clock намеренно не FK-cascade от auth_user; навигация
различает экран доступа и внутренние ссылки приложения. Cancellation/deletion
сначала подтверждаются сервером, затем освобождается задержанный synthetic
provider: проверяется именно поздний ответ, а не случайная гонка самого теста.

### 7.2. Следующий шаг оператора: только бесплатная сверка

На изолированном benchmark build можно выполнить `--inspect cloud-oss task`
из проверенного commit `ddbb4a3a74884a9d9ce89339eda1181e32a2798a`.
Этот режим читает protected ledger read-only, не открывает provider keys,
не создаёт process locks, не снимает unknown holds и не вызывает модель.
Сверка VPS выполнена 15.10.2026: оператор прислал вывод этого режима.
461 запись GPT-OSS и общий cost по 492 записям совпали с прежней проверенной
выгрузкой. Два unknown GPT-OSS удерживают 4,304003840 ₽; ещё 3,212796800 ₽
относятся к прежнему отказу GigaChat из сохранённого audit. Общая известная
стоимость — 13,372140620 ₽, holds — 7,516800640 ₽, upper bound — 20,888941260 ₽.
Это сверка двух состояний нашего журнала, не подтверждение биллинга провайдера.
Новых оплаченных вызовов нет; резервы, receipts и locks не изменялись.
Подробности: `docs/evidence/analyzer-vps-inspection-20261015.json`.
Оставшиеся 24,111058740 ₽ внутри прежнего cap — учётный запас, не баланс Cloud.ru
и не разблокировка paid trial. Неизвестные расходы нельзя считать нулевыми;
offline подготовка frozen набора может идти с сохранёнными резервами.
Старые `--live*` по-прежнему отклоняются до ключей/locks/reservations.
