# Персональный финансовый анализатор

Продуктовая база 1.3 и утверждённая техническая основа для России

Дата: 4 октября 2026 года.

Части A и B утверждены пользователем. Часть A согласована сообщением «согласовываю, зафиксируй», B-01–B-10 — сообщением «Ок, если это все дыры то согласовываю и переходим к техинияечкому стеку». Предложенная структура и основной стек части C согласованы сообщением «Россия, пользователи Россия. Ежемесячный бюджет нужен просто самый минимальный. Денег вообще на реализацию нет. Все должно быть сделано считай через чат жпт. То есть расходы минимальные. Ну я согласен со структурой». Часть D сохраняет контекст экономного выбора. Последующим сообщением «Про все что ты сказал согласен давай выбирать это базовой структурой» пользователь утвердил рекомендации, зафиксированные в части E. Готовность платить за полезное улучшение заменяет требование выбирать только самый дешёвый сервис. Новые сервисы не приобретены и платные аккаунты не созданы.

## Порядок применения

1. Согласованные решения частей A и B имеют приоритет в перечисленных вопросах над соответствующими формулировками Master Specification v1.0 и Context/Handoff. Согласованное E-04 дополнительно заменяет обязательное SMS-восстановление администратора; прочие access/security правила сохраняются.
2. Остальные требования исходного PDF продолжают действовать полностью. Word сохраняет роль контекста решений.
3. Все решения A-01–A-11 и B-01–B-10 согласованы. Структура и основной стек C согласованы; актуальный утверждённый выбор провайдеров и условия его применения перечислены в E. Согласие на базовую структуру не означает совершённую покупку, подключение аккаунта или разрешение выпустить Production.
4. Продуктовая база 1.3 состоит из полного исходного PDF v1.0, утверждённых частей A/B и согласованного изменения admin recovery E-04. Это не сокращённая замена PDF. Исходные PDF и Word сохранены без изменений; отдельно пересобранная полная редакция PDF в этой версии не создавалась.
5. Основной стек C и выбор E являются базой реализации. При расхождении технических рекомендаций C/D и последующего решения E применяется E в прямо перечисленном объёме. Конкретные тарифы, подключение, характеристики хранения и ещё открытые вопросы E-08 проверяются по разделу 54 исходного PDF.

Исходная спецификация: finance_master_spec_v1(1).pdf, Library ID libfile_27cb9ce5b0e08191a0f2841d1e989c68, SHA-256 5255d758534e74c9329cb8437e8a862f4bf989999172903a862462294b4ce9c8.

Контекст: finance_project_handoff(2).docx, Library ID libfile_1efa2c5a7dc08191a3ce7dfc9eaf26be, SHA-256 50fb15bf485d7c5a570e6195833af8c167b811a2355fa7cfdc829b5cce8a7b26.

Предыдущий реестр finance_baseline_register_v1.md остаётся историческим результатом первого аудита. Его открытые пункты F-01–F-03 и U-01–U-06 закрываются в объёме согласованных правил ниже; дополнительные вопросы повторного аудита перечисляются отдельно.

## Часть A Согласованные решения

### A-01 Продление доступа

Источник изменения: PDF 39.4–39.6, 29.4; Word 20.

Если администратор подтверждает оплату при действующем доступе, купленный календарный период прибавляется к текущей дате окончания. Если прежний доступ уже закончился, купленный период начинается с подтверждения и восстановления entitlement. Кнопка «Я оплатил» сама доступ не продлевает и grace period не создаёт.

Пример: окончание 10 октября в 12:00, подтверждение 12 октября в 15:00, покупка одного месяца — новый end 12 ноября в 15:00. До подтверждения доступ закрыт; весь купленный месяц предоставляется после восстановления.

В 39.5 заменяется правило продления от прежнего окончания после фактического перерыва. Отдельная автоматическая компенсация этой задержки не вводится.

Досрочное продление не сбрасывает AI usage. После фактического истечения новый access cycle начинается при восстановлении. Suspension сохраняется независимо от оплаты.

### A-02 HMAC и полный финансовый сброс

Источник изменения: PDF 11.3, 35.11, 36.5, 54.2; Word 19.

Для обычных импортов на всех устройствах пользователя используется один стабильный per-user HMAC key. Полный финансовый сброс обязательно создаёт новый key и контекст псевдонимизации.

Удаление отдельных операций, отмена импорта, смена password или email не меняют HMAC key. Key хранится защищённо на сервере отдельно от финансовых данных; локальный обработчик получает доступ после авторизации. В браузере key используется временно в памяти и не сохраняется постоянно в localStorage.

При full wipe categories и interface могут сохраниться по выбору пользователя. Сохранённые rules, привязанные к удалённым accounts/counterparties, отключаются с пометкой «Нужно настроить привязку». Rules по merchant могут продолжить работать.

Ротация key не заменяет удаление операций, сумм, диалогов и иных financial fragments. Старые копии keys в backups входят в будущую retention/destruction policy; не обещается неподтверждённое мгновенное уничтожение всех исторических копий.

### A-03 Возвраты и распределение по категориям

Источник изменения: PDF 8.1–8.6, 9.3, 9.6, 9.8, 24.6.

Один банковский refund остаётся одной transaction. Confirmed links/allocations определяют его распределение на исходные purchases; для этого используются transaction_components. Полная transaction при активной декомпозиции повторно не считается.

Пример: refund +10 000 ₽ на purchases «Одежда» 6 000 ₽ и «Продукты» 4 000 ₽ создаёт два аналитических components с role expense, уменьшающих соответствующие категории. Если подтверждено распределение только 6 000 ₽, остаток 4 000 ₽ имеет role unresolved и требует review.

Unlinked refund не становится income автоматически. Пользователь может самостоятельно указать category и подтвердить уменьшение расходов, если исходной purchase нет среди загруженных данных.

Refund влияет на период фактического поступления. Изменение category исходной purchase обновляет автоматически унаследованные categories refund; ручное подтверждённое назначение сохраняет приоритет.

Exclusion применяется к явно выбранным operations. Он не распространяется на связанные operations молча. Preview предупреждает, если purchase исключается, а refund остаётся учтённым; всю связанную цепочку можно исключить явным действием.

### A-04 Математика components и allocations

Источник изменения: PDF 8, 9.9, 12, 49.4.

Component amounts signed. Их алгебраическая сумма точно равна effective transaction amount в минимальных денежных единицах.

При любой активной decomposition аналитика использует components вместо полной transaction, даже если все components имеют одинаковую analytics_role. Формулировка 9.9 «для mixed transaction» уточняется этим общим правилом.

Неизвестный остаток получает unresolved; system не назначает principal/fee/другой смысл только для сведения суммы. Несогласованная decomposition требует review.

allocated_amount_minor — положительный размер распределения. Confirmed allocations проверяются на доступную сумму с обеих сторон. Refunds и expense reimbursements совместно используют доступную сумму соответствующего расхода. Credit card repayment links проверяются отдельно и не мешают refund purchase.

Candidate/rejected links сами аналитику не меняют. Если purchase уже имеет components, allocation должна указывать нужную часть purchase. Превышение доступной суммы и несовпадение валют блокируют confirmation link.

### A-05 Provenance и dedupe

Источник изменения: PDF 18–20.

Source observation хранит достаточно sanitized source fields для восстановления источника: dates, amount, currency, description, account принадлежность, pseudonymized bank ID и версии обработки. Raw identifiers не сохраняются ради этого.

После cancellation source восстанавливается по последнему оставшемуся валидному observation. Пользовательские corrections и verification сохраняются.

Две реальные одинаковые строки одного файла сохраняются как две transactions. Между файлами instances сопоставляются один к одному только при достаточных признаках. Source row ordinal используется для provenance и не считается стабильным bank ID между statements.

При неоднозначности сохраняются записи с Possible Duplicate. User decision «Это разные операции» запоминается. Fingerprints строятся по source fields; edits category/effective amount/date не уничтожают узнавание source operation.

### A-06 Подтверждения jobs и concurrency

Источник изменения: PDF 23.5, 23.8, 27, 40.13, 42.4, 49.3–49.4, 51, 54.9.

Backend проверяет права до preview. Preview фиксирует object IDs и versions. После confirmation backend повторно проверяет права, versions, scope и dependencies, затем выполняет action.

Если существенные данные изменились, показываются новые последствия; scope не расширяется самопроизвольно. Для действий без confirmation действуют те же backend permissions/validation и применимая conflict policy.

Action имеет action_id/idempotency protection. Повторный click/retry возвращает outcome прежнего действия и не выполняет его второй раз.

Deletion/cancel import блокируют новые изменения затронутых данных и согласуются с выполняющимися workers. Worker не может впоследствии восстановить удалённые transactions.

При expiry завершается только текущая разрешённая атомарная стадия. Partial completion сообщает точные succeeded/failed и сохраняет history выполненной части.

### A-07 Password reset

Источник изменения: PDF 40.2, 40.15; Word 21.

После успешного password reset недействительны старый password, ранее выданные reset tokens и все старые sessions. Пользователь входит заново. Из 40.2 убирается «предпочтительно»; автоматическое сохранение старой session не используется. Отправляется security email.

### A-08 Confidence

Источник изменения: PDF 7.4, 10, 17.

Для category: ≥90% — automatic assignment; 70–89% — preliminary assignment с recommended review; <70% — category неопределена, operation направляется в Review. Пороги остаются стартовыми калибруемыми ориентирами.

Надёжно определённый expense не исключается из общих expenses только из-за сомнения category. Он показывается в аналитической группе «Категория не определена».

Role, links и dedupe имеют отдельные проверки. Самооценка AI «99%» не является достаточным основанием merge. Automatic fuzzy merge допускается после проверки качества соответствующего алгоритма и дополнительных признаков. User-verified facets защищены.

### A-09 Состояния и справочники

Источник изменения: PDF 15, 40–43, 53, 55.10.

Identity, entitlement и suspension хранятся отдельно; effective access вычисляется из них. Paid_not_activated обозначает состояние оплаченной покупки до activation.

Invitation created — событие создания; готовое invitation имеет active. Import overall status отделён от processing stage. Maintenance status отделён от planned/emergency mode; extension окна — событие. Counterparty states явно включают discovered, registered и ignored.

First Access Request и Renewal имеют отдельные state lists. Разделы 53 и 55.10 синхронизируются с согласованной моделью. Оплата не снимает suspension.

### A-10 Deletion финансовых ответов и backup restore

Источник изменения: PDF 20.12, 26.2, 26.8, 30.5, 34–36, 44.

Financial blocks ответа Analyzer имеют provenance. При physical deletion исходных operations зависимый block удаляется либо заменяется сообщением «Ответ удалён вместе с исходными данными». Mixed result не сохраняет старые totals, основание которых удалено.

Full financial wipe очищает financial content диалогов и financial documents Analyzer. Profile, paid access и AI usage counters сохраняются.

После backup restore зарегистрированные deletion effects повторно применяются до открытия доступа пользователям. Retention остаточных historical copies определяется после выбора infrastructure.

### A-11 Редакционные исправления схем

В схемах устраняются пересечения arrows и labels. Схема AI action показывает permissions check до preview и повторную validation перед execution. Схемы отражают утверждённые правила и не вводят другую финансовую логику.

## Часть B Согласованные решения повторного аудита

Статус: все B-01–B-10 согласованы 4 октября 2026 года. Основание аудита — полный исходный PDF, Word, первая проверка и согласованная часть A. Вопросы выбора frameworks/providers/стоимости и точных retention windows остаются техническим этапом, а не объявляются дефектами продуктовой спецификации.

### B-01 Частичные собственные переводы

Основание: PDF 8.3, 9.7, 11, 15.3; A-03/A-04. При подтверждении частичной own-transfer allocation не определено, становится ли neutral вся operation. Это может скрыть настоящий расход.

Пример: source transaction −15 000 ₽, а подтверждённая парная собственная operation +10 000 ₽. Нельзя автоматически сделать все −15 000 ₽ neutral или объявить остальные 5 000 ₽ комиссией.

Утверждённое правило: только подтверждённая собственная часть 10 000 ₽ становится neutral через components; остаток 5 000 ₽ unresolved, пока его смысл не подтверждён. Надёжно установленная комиссия expense. Полностью подтверждённый собственный перевод нейтрален целиком. Для известного собственного получателя отсутствие парной выписки не отменяет independently verified own-transfer смысл.

Автоматический link не перезаписывает противоречащее ему user-verified решение: такой конфликт показывается в Review. Требуют внимания считается по parent transactions, а не по числу components.

Проверка: partial own-transfer не убирает неизвестный остаток из списка review; fee не исчезает из expenses; counterpart user verification сохраняет приоритет.

### B-02 Новые source facts могут нарушить уже подтверждённую математику

Основание: PDF 6.3, 8.6, 17.5, 19.7, 20.5; A-04/A-05/A-06. Само сохранение новых observations не определяет, что происходит с ранее созданными allocations/components при изменении source amount.

Пример: purchase 1 000 ₽ и confirmed refund allocation 1 000 ₽. Новое валидное observation той же purchase содержит 900 ₽. После обновления available capacity нарушается.

Утверждённое правило: новый банковский факт сохраняется; source/effective reconciliation учитывает сохраняемые user corrections. До активации обновлённых расчётов в одном согласованном backend действии проверяются все затронутые components, links и capacities.

Конфликтующие links/derived decompositions получают признак dependency conflict и временно не являются действующей расчётной основой. Подтверждённое пользовательское решение хранится, но link status confirmed сам по себе не заменяет текущую проверку валидности. Allocations нельзя молча уменьшить с 1 000 до 900 ₽. Для автоматической интерпретации, оставшейся без валидного основания, используется unresolved/review; независимые manual role/category/corrections сохраняются.

Операции с неподтверждённым остатком или конфликтом явно входят в attention; «Как рассчитано» показывает неучтённую спорную часть. Тот же reconciliation применяется при cancellation, correction и Undo. При cancellation нельзя сохранять удалённое source observation внутри временного «старого источника»; сохраняется только действительно разрешённое user decision/configuration.

Проверка: source amount change не создаёт over-allocation, не перетирает manual edits и не выдаёт несогласованный aggregate как окончательный.

### B-03 Старое устройство может загрузить данные после full wipe

Основание: PDF 18.7–18.12, 35.11, 36.5; A-02/A-06. Rotation и остановка server workers недостаточны для browser, который уже подготовил payload со старым key.

Пример: телефон начал local parsing, компьютер выполнил full wipe, телефон через минуту отправляет старый sanitized payload.

Утверждённое правило: финансовая база пользователя имеет generation identifier. Local import preparation и server jobs связаны с generation/HMAC key version, использованными при подготовке. Full wipe увеличивает generation и закрывает старые jobs. Backend проверяет generation при server acceptance и перед commit; старый payload отвергается.

Пользователь получает «Данные были сброшены на другом устройстве. Загрузите файл заново». Новый import выполняет local sanitization/HMAC с текущим key. Нельзя принять old aliases в новую базу или автоматически повторно создать очищенные данные.

Проверка: payload/job старой generation после wipe не может записать transaction, alias, component, link или financial cache. Никакой raw fallback для восстановления совместимости.

### B-04 Удаление purchase при сохранении refund

Основание: PDF 20.4–20.12, 24.7, 36.3–36.4, 52.5; A-03/A-10. Dependency check перечислен, но точная судьба surviving refund не определена.

Утверждённое правило: refund не удаляется автоматически вместе с purchase, если пользователь не включил его в destructive scope. Связь с удалённой purchase удаляется. Preview показывает surviving refunds, меняющуюся аналитику и данные, которым потребуется Review.

Если user independently verified role/category refund или component, эта интерпретация сохраняется без копии удалённой purchase. Если смысл держался только на удаляемом link, соответствующая часть становится unresolved и предлагает пользователю подтвердить category/role без исходной purchase. Refund не становится income автоматически.

Тот же принцип действует при import cancellation: surviving bank facts сохраняются, user decisions учитываются, зависимая автоматическая интерпретация пересматривается. Для own transfers/repayments потеря link сама по себе не отменяет независимо подтверждённый собственный/нейтральный смысл.

Проверка: delete purchase не удаляет чужой по scope refund, не оставляет dangling link и не сохраняет копию удалённой source purchase.

### B-05 Reversal определён как тип но не имеет полной логики учёта

Основание: PDF 7.1, 8.5, 9, 24.6, 55.1/55.5. Refund подробно описан; reversal присутствует в справочниках, но general default по original expense/income/neutral не формализован.

Утверждённое правило: reversal получает экономическую роль и category отменяемой operation/части, а signed amount даёт противоположный вклад. Reversal expense уменьшает expense; reversal income уменьшает income; reversal neutral остаётся neutral. Учитывается в собственную дату банковского движения.

Пример: September income +50 000 ₽, October reversal −50 000 ₽ — October income contribution −50 000 ₽, а не новый expense. Для partial reversal применяются allocations/components и общие ограничения capacities.

Если original operation не найдена и смысл не подтверждён другим надёжным основанием, role unresolved и Review. Reversal не распределяется произвольно. Expense-side reversal не должен второй раз использовать уже покрытую refund/reimbursement/reversal часть исходного расхода.

Bank cancelled row без фактического движения не создаёт выдуманную парную transaction. Надёжно известный банковский lifecycle обрабатывается source reconciliation; parser не объявляет unknown row cancelled по догадке.

Проверка: expense/income/neutral reversals не создают ошибочный противоположный финансовый тип; same-period отмена компенсирует вклад, cross-period отражается в период фактической отмены.

### B-06 Календарный anchor и временные зоны

Основание: PDF 29.4, 33.7, 39.10; A-01. Последний день месяца определён, но дальнейший monthly anchor после короткого месяца не определён.

Утверждённое правило: внутри непрерывного access cycle сохраняются исходный day/time и timezone расчёта. Каждая calendar boundary считается от исходного anchor и номера месяца, а не от предыдущей уже укороченной даты. Для 31-го числа: 31 января → 28/29 февраля → 31 марта → 30 апреля.

При renewal после реального expiry новый cycle получает anchor фактического восстановления, как в A-01. Early renewal текущего cycle не меняет anchor и не сбрасывает usage. Access и monthly AI quota используют согласованную календарную сетку этого cycle.

Profile timezone change меняет отображение, но не переносит уже определённый access end и границы текущего access/quota cycle. Новый cycle может получить новый timezone snapshot. Для recurring budget сохраняется его собственный calendar anchor; прошлые периоды не переписываются при смене profile timezone.

Если bank source имеет только дату без времени/zone, эта precision сохраняется. Не создаётся выдуманный точный timestamp, влияющий на dedupe или перенос между датами. Правила DST неоднозначных/несуществующих локальных времён должны быть явно определены и протестированы на technical stage; они не оставляются на неявный default библиотеки.

Проверка: continuous renewals и quota resets не дрейфуют с 31-го на 28-е навсегда; travel/timezone change не меняет оплаченное время; date-only bank source не превращается в точный факт.

### B-07 Merge Split и неизменность идентификаторов

Основание: PDF 6.1, 11.6, 13.3, 15.4, 19.6, 34.4, 52; A-05/A-06.

Утверждённое правило для duplicate merge: выбрать canonical transaction; её transaction_id сохраняется. Старые IDs сопоставляются с canonical ID только внутри того же user. В активной аналитике одна canonical operation; provenance всех merged sources переносится без потери instance distinctions. Конфликтующие user-verified values выбираются в preview, а не разрешаются AI.

Merge не классифицируется как обычный physical delete с уничтожением источников. History хранит достаточную delta для предусмотренного Undo в 30-дневном окне. Undo не перетирает новые edits и не воскрешает данные, физически удалённые после merge.

Account/counterparty Split требует явного распределения aliases/source observations/operations. Неоднозначные personal rules, budgets, views и widgets получают dependency conflict/«Требуется обновление», а не случайное расширение scope. Account merge/split обновляет matching indexes по sanitized source observations; effective correction не заменяет исходный bank fact.

Physical deletion canonical transaction очищает её aliases/associated fingerprints и финансовые копии согласно deletion policy. Reimport после physical deletion создаёт новый transaction_id, как в базовой спецификации.

Проверка: ID-ссылки, import cancellation и dedupe остаются корректными после merge; split не назначает rule обоим получателям без explicit scope.

### B-08 Частичный импорт и обязательная validation

Основание: PDF 18.4, 18.6, 18.10, 10.3; A-05. Фраза «490 импортировано, 10 на проверке» смешивает semantic uncertainty и отсутствие обязательного bank fact.

Утверждённое правило: строка с валидными amount/date/account/currency, но неопределёнными role/category, создаёт transaction с review reasons. Строка без достоверной обязательной суммы/даты не создаёт canonical transaction: это import issue, связанный с import.

Import issue хранит только допустимый sanitized fragment и понятную причину. Он не входит в financial totals, budgets и count transactions «Требуют внимания». Batch result отдельно показывает created/existing/updated/review transactions и rows not imported/import issues. Пользователь видит next step: retry parsing/reupload/local verification либо Support с explicit consent.

Если fragment нельзя безопасно очистить, он не отправляется на server/AI; сохраняется только технический error status без raw financial content. Cancel import удаляет допустимые fragments/issues согласно privacy cascade. Система не создаёт amount=0 или guessed date ради прохождения schema.

Проверка: missing amount/date не порождает фиктивные transactions и не подменяется сомнением category; partial success не отменяет валидные rows других файлов batch.

### B-09 Privacy свободного текста и разрешённых страниц

Основание: PDF 3.4, 30.2–30.3, 35.2–35.6, 50.2; A-02/A-10. File pipeline описан подробно, но sensitive identifiers могут оказаться в Analyzer text, user comments, account names или в изображении разрешённой страницы.

Утверждённое правило: правила sanitization распространяются на свободный текст и editable fields до передачи sensitive identifiers на сервер, включая самый первый AI вызов для Financial Relevance Gate. Backend дополнительно проверяет outbound AI/web payload. Для запроса по номеру счёта/получателя локальный HMAC и backend resolution передают дальше разрешённый internal object reference и минимальный смысл, а не raw номер.

One-time permission из 30.3 относится к конкретным выбранным страницам и не отменяет sanitization. Page preview показывает, какие страницы отправляются; sensitive fields скрываются локально, в том числе при image processing. Если безопасная очистка невозможна, страница не передаётся внешнему AI. Bank statement всегда проходит защищённый Import pipeline и не использует document-page exception.

Свободный текст не является инструкцией об отключении privacy. Продуктовая telemetry, logs и web queries не получают raw реквизиты или financial chat content. User Support attachments остаются отдельной явно объявленной передачей службе поддержки согласно 50.1; она не предоставляет admin доступ к financial DB.

Проверка: raw identifier из user comment/query/image не обходит file sanitizer; AI gate не становится первым местом утечки; one-time permission не превращается в постоянное разрешение на все документы.

### B-10 Недоплата переплата и ручной доступ

Основание: PDF 38.2, 39.7–39.9, 41.9–41.10, 29; A-01/A-09. Actual amount указан, но его связь с купленной duration при несоответствии price не определена.

Утверждённое правило: система никогда сама не рассчитывает пропорциональный период из actual/expected amount. При mismatch admin явно выбирает: принять полученную сумму за полный snapshot tariff; запросить доплату; отклонить/оформить возврат; либо выдать отдельно согласованный custom access period с причиной. Фактические платежи и выбранное access action сохраняются раздельно в audit.

Overpayment сама не покупает дополнительный месяц и не становится скрытым кошельком. После confirmation исправление payment record не выполняет повторную extension; access корректируется отдельным action с preview. Денежный refund и изменение entitlement остаются отдельными решениями согласно 39.8.

Для manual Paid/Test/Free/Other/indefinite access задаётся AI quota policy: существующий tariff/default либо explicit override. Суммы quota будут определяться с provider costs, но отсутствие paid tariff не трактуется как безлимит. Compensation access не сбрасывает текущий usage автоматически; отдельная quota compensation имеет собственный audited action.

Проверка: repeated confirmation, amount correction, overpayment и manual grant не создают двойной доступ или неявный unlimited AI.

## Покрытие повторного прохода

| Блок исходного PDF | Что проверялось на стыках | Новые пункты |
| --- | --- | --- |
| 1–10 Концепция и финансовая модель | Signed math, special kinds, links/components, bank fact/effective, attention | B-01, B-02, B-05, B-08 |
| 11–20 Счета правила импорт | User verification, aliases, source observations, cancellation, dedupe, Merge/Split | B-01, B-02, B-03, B-04, B-07, B-08 |
| 21–30 Аналитика Analyzer | Единые расчёты, quota, Action Registry, relevance gate, document privacy | B-02, B-05, B-06, B-09, B-10 |
| 31–40 Настройки privacy доступ | Timezone, Undo/deletion, HMAC lifecycle, payment duration, identity/entitlement | B-03, B-04, B-06, B-07, B-09, B-10 |
| 41–50 Admin эксплуатация релизы | Manual grants, workers/maintenance, backup/delete, isolation и release approvals | B-03, B-10; согласованные A-06/A-10 действуют |
| 51–55 Матрицы и справочники | Confirmation/dependencies/states, allowed types, intentional technical open decisions | B-02, B-04, B-05, B-07, B-08; A-09 синхронизирует states |

Это один повторный проход по согласованной базе и межфункциональным сценариям. Перечень не является гарантией отсутствия всех возможных ошибок. B-01–B-10 утверждены, продуктовый аудит закрыт в объёме двух выполненных проходов. Следующий этап — техническая архитектура и проверка реализации по полной базе 1.2.

## Отдельные требования к техническому этапу

Следующие требования не создают новых продуктовых выборов и выводятся из принятой базы:

- Тесты одинаковых filtered calculations в Overview/Budgets/Analyzer, включая отрицательные net values и components.
- Pie/donut не используют отрицательные доли; для таких результатов выбирается bar/table/text согласно 21.13.
- Candidate/rejected links, uncertain source updates и unsafe fragments не активируют финансовые effects.
- Все user-facing статусные counters различают transactions, components, import issues и system banners.
- HMAC namespace/canonicalization/key versions, equality matching и aliases проверяются при import и reimport.
- Session/ownership/entitlement проверки выполняются backend для UI и AI actions; feature flag не предоставляет admin доступ к финансовым данным других users.
- Deletion cascade охватывает semantic chat context, summaries, documents, caches и History financial copies, а не только видимое сообщение.
- Release привязан к commit; Staging остаётся synthetic и изолированным; migration/rollback/forward-fix план и security pass обязательны.
- Точные frameworks/providers, параметры криптографической реализации, costs, RPO/RTO, retention periods, legal texts и конкретные directory names выбираются на technical stage.

## Часть C Согласованная структура и основной технический стек

Статус: предложенная структура и основной стек приняты пользователем. Провайдерные рекомендации этой части были подготовлены до уточнения страны/бюджета: их актуальный статус уточняет часть E. Не изменяет утверждённую продуктовую модель. Проверено по официальной документации 4 октября 2026 года. Конкретные patch versions фиксируются в lockfile после проверки совместимости и security advisories при создании repository.

### C-01 Рекомендуемый основной стек

| Область | Рекомендация | Причина выбора и обязательное ограничение |
| --- | --- | --- |
| Язык | TypeScript, strict mode | Общие типы и finance-core для web/API/workers. Внешние JSON всегда дополнительно валидируются во время выполнения. |
| Пользовательское приложение | React + Vite | Закрытый интерактивный web UI и локальные Web Workers. Публичные страницы можно публиковать статически; серверный рендер финансовых данных не нужен. |
| Админка | Отдельное React + Vite приложение | Собственный origin, сессия и API-контур. Совпадение UI packages не даёт доступа к пользовательским finance endpoints. |
| UI и состояние | Radix Primitives, CSS Modules + design tokens, TanStack Query/Table | Доступные элементы и общий UI; серверные данные в памяти, с очисткой при logout/wipe. Таблица и mobile cards используют один data contract. |
| Графики | Apache ECharts | Разрешённые UI-виды; ARIA включается явно, рядом доступна таблица/текст. Signed net values показываются bar/table, а не отрицательными сегментами pie. |
| Сервер | Node.js 24 LTS + NestJS с Fastify adapter | Модули для imports, finance, links, rules, Analyzer, identity/access, admin и operations. Это единая кодовая база с разделёнными полномочиями процессов. |
| API | HTTP JSON + OpenAPI, SSE для статуса jobs/ответов | Проверяемые versioned contracts. Money в JSON — decimal integer strings; схема разрешает только известные поля. Поток событий также проверяет session/status/allowed scope. |
| База | PostgreSQL 18 | Transactions, constraints, row locking, RLS и PITR. Managed-вариант предпочтителен при подходящем регионе и бюджете. |
| Доступ к базе | Drizzle ORM + явные SQL migrations | Типизированные запросы; RLS, composite FK, partial indexes и финансовые ограничения оформляются явно. ORM не заменяет инварианты. |
| Фоновые задачи | pg-boss + отдельные Node workers | Очередь в PostgreSQL, retries/concurrency и создание jobs в DB transaction. Бизнес-эффекты всё равно idempotent: очередь не гарантирует однократную оплату или внешнюю отправку. |
| Authentication | Better Auth с DB sessions и TOTP plugin | Основа email/password, verification/reset и TOTP. Invitation-only onboarding, entitlement, admin recovery и override flows реализуются согласно продукту поверх библиотеки. |
| Privacy/crypto | Web Crypto HMAC-SHA-256 в браузере; server-side envelope encryption через KMS | Стабильный per-user key, временная память браузера, отдельные key versions/generation. Provider KMS и политика backups выбираются после региона. |
| Import extraction | PDF.js, Papa Parse, SheetJS CE, Tesseract.js | Локальный PDF/text/CSV/XLSX/OCR pipeline до серверной передачи. OCR через WebAssembly в Web Worker. |
| Тестирование | Vitest + реальные PostgreSQL integration tests + Playwright | Финансовые инварианты, concurrency, ownership/security, browser privacy и desktop/mobile workflows. |
| Сборка и релизы | Private GitHub monorepo, pnpm workspace, Docker images, GitHub Actions | Один commit и неизменяемые image digests проходят Staging и затем Production после отдельного действия владельца. |

Выбор React + Vite вместо Next.js здесь обусловлен закрытой рабочей областью, локальным import pipeline и отдельным полноценным API. SSR для финансового кабинета не даёт обязательной продуктовой возможности, но добавляет места обработки и кеширования данных. Если у публичного сайта появится реальная SEO-задача, его рендеринг можно расширить, сохраняя privacy-границу кабинета.

PostgreSQL вместо document DB выбран из-за provenance, связей, allocations, capacity checks, cancellation и атомарных переходов. pg-boss позволяет не вводить Redis как ещё одно обязательное хранилище на первом этапе. Это сокращает инфраструктуру, а не продуктовую функциональность. Отдельные сервисы/Redis вводятся по измеренной нагрузке либо конкретному требованию, а не заранее.

### C-02 Границы приложений и полномочий

В одном private repository:

- apps/web: public pages и пользовательский интерфейс.
- apps/admin: administrative interface на отдельном origin.
- apps/api: общая server codebase с двумя deployment profiles — user/finance API и control/admin API.
- apps/worker: background execution с отдельными ролями для finance jobs и administrative delivery.
- packages/finance-core, contracts, database, imports, privacy, analyzer, access, ui, shared.
- tests/unit, integration, e2e; synthetic fixtures и staging seeds.
- docs/product: неизменные исходные PDF/Word, утверждённые amendments и precedence manifest.
- docs/architecture: ADRs, Action Registry, schemas, threat model, release/restore runbooks.
- infrastructure: environment configuration, containers, migrations, monitoring и deployment scripts без секретов.

User API и admin API используют общий код, но запускаются с разными DB credentials. Control/admin process не загружает finance repositories и не получает SELECT на finance tables, chats или HMAC keys. Админские capabilities не включают impersonation. Service workers получают только нужные модули и права; миграционный owner role не используется приложением.

PostgreSQL может первоначально размещаться в одном подходящем cluster с отдельными schemas/roles: identity/access/commerce/control, finance, protected keys, jobs. Runtime connections ограничены GRANT и RLS. Финансовые таблицы всегда user scoped; FK включают user_id, чтобы связь не пересекала пользователей. RLS включается явно, runtime role не owner и не BYPASSRLS; tenant context устанавливается transaction-local и не наследуется следующим запросом pool. База не публикуется в интернет.

RLS — дополнительный уровень. API проверяет ownership и permissions до выполнения каждого запроса; AI не получает SQL или DB credentials. Оператор инфраструктуры остаётся отдельной привилегированной ролью: zero-knowledge модель исходной спецификацией не обещана.

### C-03 Финансовое ядро и consistency

Finance-core — чистые функции без AI, сети и собственных запросов к DB. Его функции используют Overview, budgets, operations explanations, exports of internal results to Analyzer и workers. Пользовательский export в v1 от этого не появляется.

Money хранится signed integer minor units: PostgreSQL bigint, TypeScript bigint внутри ядра, integer strings в JSON. Для процентов/пропорций используются точные целочисленные/decimal вычисления и явно определённое округление; после распределения сохраняется точная сумма. JS number разрешён только для ограниченных визуальных координат после безопасного преобразования, не для финансовых результатов. Overflow и недопустимые значения отклоняются.

Bank facts/source observations, user corrections и effective interpretation разделены. Существующие source/confidence/verification fields остаются отдельными по facet; AI уверенность не становится user verification. Полная transaction или активные components учитываются взаимоисключающе.

Граф links/allocations хранится в relational tables. Candidate/rejected и confirmed-but-invalid links не дают эффекта. Суммы components и capacities нескольких links нельзя гарантировать одним обычным CHECK на строке: требуется общий transactional mutation service с locks и проверкой затронутого графа до commit. DB constraints блокируют dangling/cross-user links; критические graph invariants дополнительно обеспечиваются подходящими deferred checks/triggers там, где применимо.

Mutations используют row versions, snapshot IDs, idempotency key и action_id. Locks берутся в стабильном порядке; conflicts/retries обрабатываются явно. PostgreSQL SERIALIZABLE применяется к операциям, которым недостаточно определённого набора row locks, с корректным retry и без повторения внешних эффектов. Нельзя объявить весь API безопасным лишь выбором уровня isolation.

При изменении source amount, correction, cancellation, merge/split выполняется единый reconciliation. До выдачи новых aggregates конфликтующие derived decisions перестают быть расчётной основой; user decisions не обрезаются молча. Любой вычисляемый кеш получает data revision + financial_generation; stale результат не возвращается как актуальный.

Календарные вычисления предлагается реализовать через Temporal API/проверенный polyfill. Bank date-only хранится DATE с precision, реальные timestamps — отдельно. Calendar access/quota boundaries считаются от исходного anchor и timezone snapshot. Предлагаемое DST-правило для нового вычисления boundary: в overlap выбрать более ранний instant; в gap сдвинуть на размер перехода вперёд. Это техническое предложение требует принятия и тестов; не изменяет уже сохранённые boundary instants.

### C-04 Import, dedupe и локальная обработка

Raw statement и password encrypted PDF остаются на устройстве. File bytes, исходное имя с персональными данными, номер счёта, карточные реквизиты, сырой page image и OCR text не попадают в upload/telemetry/error logs. Полные имена/адреса и прочие запрещённые identifiers обрабатываются по privacy policy исходной спецификации. На сервер передаётся только разрешённый sanitized contract.

PDF.js читает text layer и локально открывает password-protected PDF. Scanned pages локально рендерятся в изображения и передаются Tesseract.js. Tesseract.js сам PDF не читает. Worker binaries, WASM, fonts и Russian language packs обслуживаются с нашего origin с фиксированными версиями, а не загружаются произвольно с внешнего CDN во время обработки.

CSV обрабатывает Papa Parse; XLSX — SheetJS CE в worker. Для SheetJS authoritative distribution отличается от старого npm package xlsx: берётся проверенный официальный release, фиксируется hash/lockfile и при необходимости vendored copy. Внешние links/macros/formulas не исполняются; отсутствие достоверного required bank fact становится import issue.

Первые supported deterministic parsers — для реальных форматов Т-Банка, Ozon Bank и Сбербанка, упомянутых в handoff. Их фактические варианты определяются только по заново открытым файлам/санитизированным fixtures; исторические выписки не считаются сейчас доступными. Unknown-format AI adapter получает только безопасный extracted representation и возвращает строго валидируемую структуру.

Sanitizer/HMAC namespace/canonicalization имеют version. HMAC key доступен только после разрешённой авторизации, временно в памяти; localStorage/IndexedDB не сохраняют его или raw financial drafts. Импортные worker contexts закрываются при logout/wipe; нельзя обещать физическую zeroization каждой копии в JavaScript GC.

Payload и jobs несут financial_generation, key_version, import/batch ID и processing versions. Server acceptance и commit повторно сверяют generation/status/allowed action. Full wipe атомарно переводит generation и key, инвалидирует старую работу; старый browser получает требование нового local import.

Dedupe работает с source facts, не user-effective fields. Identity index и strict fingerprint user scoped; fuzzy matching допускается только после проверки на corpus. One-to-one instance matching сохраняет законные одинаковые платежи. Provenance хранит полный разрешённый sanitized observation; row ordinal не считается stable bank ID.

Server обеспечивает один active batch пользователя через DB state/constraint, а не кнопку UI. Устойчивые job stages, retries и idempotent checkpoints показывают честный partial result. AI outage не блокирует создание валидных transaction rows. Cancellation удаляет уникальные операции и зависимые финансовые копии; shared operation восстанавливается по оставшимся observations.

До признания browser import пригодным нужны измерения на iOS Safari и Android Chrome: text PDF, длинный PDF, scanned PDF, protected PDF, CSV/XLSX, память, скорость, cancel и network capture. Playwright emulation не заменяет реальное устройство. Лимиты file/pages/worker concurrency определяются замерами и показываются заранее; если OCR слишком тяжёлый, нужно ускорить локальную обработку или честно обозначить лимит. Автоматического server/cloud raw fallback нет.

### C-05 Analyzer Action Registry и AI-провайдер

Provider-independent AI gateway располагается на сервере. Рекомендуемый первый кандидат — OpenAI Responses API с явными strict function schemas; окончательное принятие зависит от доступности сервиса, договора, региона и retention. Конкретная модель не выбирается по названию «самая новая»: import classification и Analyzer оцениваются отдельно на product fixtures, стоимости, latency и schema adherence. Model/config/parser versions сохраняются в provenance.

Financial Relevance Gate выполняется до financial tools и web search, но после local sanitization. Backend дополнительно валидирует outbound payload. User references локально псевдонимизируются и разрешаются через internal IDs; AI получает минимальную необходимую projection, а не DB dump.

Registry каждого action содержит schema/version, allowed principal/status/access conditions, read/write scopes, preview/confirmation rule и execution handler. Названия и параметры берутся из полной продуктовой спецификации; произвольный generated action, arbitrary SQL, password/email/admin/access/HMAC tools не регистрируются. UI и AI вызывают одни и те же application services.

Read results и финансовые расчёты выполняет серверное ядро. Write action повторно проверяет ownership/status/entitlement/snapshot/generation перед commit, даже если preview был разрешён. Confirmed scope связан с конкретными IDs/versions; текст AI не заменяет confirmation. Registry schema strictness не заменяет authorization или математическую validation.

Assistant sessions/history, result blocks, summaries, documents и semantic contexts находятся в нашем разрешённом хранилище с dependencies для deletion cascade. Не создаётся обязательный hosted provider thread/vector store, из которого продукт не может удалить зависимые копии. Provider calls по возможности stateless, с явным store=false; модельные caches и abuse monitoring всё равно учитываются в отдельной политике.

Согласно текущей OpenAI документации, store=false сам по себе не отменяет стандартный abuse-monitoring retention до 30 дней. Дополнительные ZDR/MAM controls требуют одобрения и имеют ограничения по endpoints/features; регион хранения не гарантирует тот же регион обработки каждой функции. Поэтому обещание «AI ничего не хранит» и заранее выбранный EU region недопустимы без проверки реального account/contract/model/endpoint.

Web search — отдельный backend adapter с независимым toggle, allowed sanitized query и актуальными источниками на каждый соответствующий ответ. Search/fetch имеет сетевые ограничения против SSRF; содержимое страниц трактуется как данные. Конкретный search provider пока открыт. AI fallback никогда автоматически не меняет утверждённые регионы/retention и не отключает privacy checks.

Quota/cost ledger атомарно резервирует разрешённый бюджет вызова и затем сверяется с фактическим usage. User monthly quota, Review reserve, import automation и краткие unrelated responses учитываются по спецификации раздельно. Защита от злоупотребления также охватывает действия, которые не расходуют обычную quota. Technical billing/usage entries не хранят chat contents.

### C-06 Access и security implementation

Better Auth используется с DB-backed opaque sessions, secure HttpOnly host-only cookies, server-side status validation и без cookieCache. Настраивается revokeSessionsOnPasswordReset=true; дополнительно инвалидируются все outstanding reset tokens и связанные recovery contexts. После reset требуется новый login. Invitation/purchase/entitlement — собственные сущности с independent states; встроенный публичный signup закрыт, allowed registration возможна только по product invitation flow.

Предлагаемый password hash — Argon2id через поддерживаемую библиотеку с параметрами не ниже актуального OWASP baseline и замерами на выбранном сервере. Rate limits учитывают память hash verification. Password policy, breached-password check и password-manager compatibility должны совпадать с исходным security acceptance.

Invite/reset/verification tokens — случайные, single-use, scoped и expiring; в custom storage сохраняется hash, не plaintext token. Native библиотечные endpoints проверяются отдельно: если стандартная семантика противоречит продукту, endpoint закрывается/оборачивается, а не считается совместимым автоматически.

Admin TOTP обязателен и повторно требуется для предусмотренных опасных actions. Нельзя включить trusted-device или альтернативный login, которые дают обход обязательного TOTP. QR строится локально без third-party QR service. Аварийное восстановление осуществляется через одноразовый recovery code, сохранённый отдельно от телефона, согласно E-04. Обязательный SMS recovery отменён согласованным решением. Recovery инвалидирует прежние admin sessions/TOTP и требует нового verified enrollment прежде, чем выдавать administrative capabilities.

User и admin sessions имеют отдельную область действия. SameSite, CSRF, CSP и allowed origins задаются явно; cross-origin request не доверяется только из-за CORS. Финансовые ответы Cache-Control no-store, отсутствуют payloads в URL и shared browser/proxy caches. Streaming endpoints также закрываются/переавторизуются при утрате permissions.

Per-user HMAC secrets защищены envelope encryption через KMS; master wrapping keys и runtime credentials не находятся в finance tables/repository. TOTP secrets защищены отдельно и не доступны admin read endpoints. KMS должен поддерживать аудит и выбранный recovery/retention режим; encrypted disks/backups не заменяют эти границы.

Frontend sanitization не объявляется безошибочной. Privacy acceptance включает набор forbidden identifiers и сетевые captures по import/text/images. Backend outbound checks, запрет unsafe payload, allowlist logging, CSP и supply-chain pinning дополняют клиентскую границу.

### C-07 Удаление, History и восстановление

Deletion service получает preview/scope и выполняет dependency traversal для observations, operations/components/links, fingerprints/aliases, chat results/context, documents, caches и financial History deltas. Нельзя полагаться лишь на SQL ON DELETE CASCADE: blobs, queues и AI-derived text требуют явного удаления/инвалидации.

При крупном deletion scope сначала закрывается доступ к выбранным данным и инвалидируются jobs, затем выполняются контролируемые chunks. Пользователь видит фактический progress/partial failure; «Удалено» не показывается до завершения предусмотренной очистки. Physical delete/cancellation не получают Undo. Undo иных actions хранит разрешённую delta до 30 дней и не воскрешает последующий physical delete.

Recovery deletion journal хранится независимо от восстанавливаемого backup: opaque IDs, scope/generation и необходимые timestamps, без сумм, chat text или source facts. Его retention обязан перекрывать реально допустимое окно restore; число дней ещё открыто. Restore сначала применяет все более поздние deletion/wipe records, не возвращает старые keys/jobs и только затем допускает пользовательский доступ. Если актуальный journal недоступен, восстановленная система остаётся закрытой.

Регулярная restore проверка выполняется в изолированном recovery-контуре с ограниченным доступом и отключённой внешней отправкой. Он не является обычным Staging и не разрешает использование production financial DB для разработки. Проверяются backup decryptability, полнота, migrations, deletion replay и фактическое время восстановления.

### C-08 Development, Staging и Production

| Среда | Данные и сервисы | Доставка |
| --- | --- | --- |
| Development | Local containers, synthetic data, test AI/email/SMS adapters; отдельные secrets | Feature branches, локальная проверка |
| Staging | Отдельные DB/users/keys/storage/workers/provider credentials; synthetic corpus 10 000+ transactions | Автоматически после обязательного CI на принятом commit |
| Production | Отдельный runtime/network/DB/keys/storage и реальные credentials; backup/PITR | Только после owner acceptance конкретного Staging artifact и отдельного действия release |

CI: build, TypeScript, lint, finance unit/property scenarios, PostgreSQL integration/concurrency, Playwright e2e/privacy, dependency/secret checks, migration validation. Объём checks определяется изменением, но обязательные release/security gates не пропускаются. Synthetic corpus включает все special kinds, components, refunds/reversals, duplicates, cancellation, wipe races, expiry/renewals и calendar edge cases.

Release manifest связывает commit, image digests, migrations, model/parser configuration и feature flags. Production получает те же протестированные artifacts без повторной сборки «похожего» commit. Migrations выполняет отдельный короткоживущий role. Compatibility определяет rollback или forward fix; backup restore не используется как универсальная кнопка отката релиза, поскольку может потерять новые записи.

Private GitHub branch protection требует подходящего плана: для личного repository базовый кандидат GitHub Pro, для организации Team. Проверенная документация ограничивает native required-reviewer deployment gates в private repositories; нельзя обещать эту возможность на Free/Pro/Team.

Рекомендуемый начальный Production gate: ordinary CI может собрать artifact и обновить Staging, но не имеет production deploy credentials. Владелец после acceptance отдельно запускает release из доверенного окружения через infrastructure identity с MFA; команда принимает только commit/digest с пройденными CI/Staging checks и записывает release approval/result. Админка финансового продукта этим запуском не управляет. Если потребуется полностью hosted approval pipeline, выбирается план/платформа с enforceable gate, без ослабления требования владельца.

Контейнеры и стандартный PostgreSQL сохраняют возможность сменить hosting provider. Kubernetes не требуется до появления причины по нагрузке/доступности. Выбор deployment topology, числа nodes и auto-restart/rolling strategy зависит от согласованных RPO/RTO и измерений. Docker Compose допустим для Development; Production execution конкретизируется вместе с provider, не объявляется автоматически высокодоступным.

### C-09 Эксплуатация, стоимость и ещё открытые решения

Логи имеют allowlist: event code, internal opaque IDs, duration, outcome, sanitized error code. Request/response bodies, SQL parameters, chat prompts, parsed rows, raw filenames и session/HMAC/TOTP secrets не логируются. Error-tracking/replay SDK не подключается с default content capture; конкретный сервис выбирается после региона и проверки outgoing events.

Health checks для public/API/DB/worker heartbeat — примерно 60 секунд; incidents после последовательных failures. External monitor и emergency maintenance control не зависят от production app/node. AI/web/email/SMS checks имеют отдельные частоты и budgets. Planned maintenance предупреждает по спецификации, jobs останавливаются на safe checkpoints, Support остаётся доступен.

Backup/PITR поддерживается PostgreSQL, но должен быть включён и проверен в выбранной конфигурации. Частота, retention, RPO/RTO, key retention и deleted-data residuals не назначаются молча. Change History = 30 дней остаётся уже утверждённым правилом.

Точный ежемесячный бюджет нельзя вывести из списка библиотек. Он состоит из Git/CI, Staging/Production runtime, DB/backups/PITR, storage/KMS, external monitoring, email/SMS и переменного AI/web usage. OCR не создаёт cloud cost за страницу, но требует измеренной производительности устройства и затрат на разработку.

Перед выбором конкретных production providers нужны три исходных факта: страна/форма продавца, страны пользователей и комфортный ежемесячный бюджет. Язык/RUB и российские банки сами по себе не определяют юридическую юрисдикцию. Разделы PDF 54.3–54.6 прямо оставляют providers/regions/retention/legal на этот этап. Без этих фактов архитектура остаётся переносимой, а provider/region не записываются как принятые.

| Решение | Текущее состояние | Как закрыть |
| --- | --- | --- |
| Seller, target market, budget | Россия; бюджетный ориентир и правило цена/качество приняты в E | Юридическая форма и окончательная смета остаются открытыми |
| Hosting/managed PostgreSQL/storage/KMS | Timeweb в РФ, предпочтение managed PostgreSQL согласно E; storage/KMS ещё требуют точной конфигурации | Проверить цену, роли, PITR/restore, независимые копии и действующее управление |
| AI model/provider, web search | Yandex AI Studio выбран для сравнительных испытаний; OpenAI исключён из основного российского плана | Проверить модель, privacy/retention, качество на corpus, costs и fallback |
| Email/recovery | Yandex Postbox для отправки; TOTP + recovery codes согласно E | Проверить delivery, domain setup, retention и безопасное восстановление |
| Browser OCR suitability | Технологический кандидат | Реальные device/file benchmarks и privacy network capture |
| Auth flows | Better Auth + custom product layer | Invitation/reset/revocation/TOTP/recovery proof-of-concept и security acceptance |
| Retention/RPO/RTO/legal | Намеренно открыты | После провайдеров отдельные технические и юридические политики, versions/acceptance |
| Patch versions/limits | Открыты до bootstrap | Compatibility checks, security review и lockfile |

### C-10 Порядок начала реализации после принятия архитектуры

1. Создать private repository на аккаунте владельца; положить полные исходники и approved amendments, зафиксировать hashes и precedence. Настроить branch protection/CI и secret boundaries.
2. Поднять isolated Development/Staging; оформить production infrastructure plan и release gate до первого production deployment.
3. Реализовать и проверить finance-core, базовую relational schema, ownership/roles и generation/key lifecycle. Одновременно выполнить browser import и auth prototypes, чтобы устранить именно технологические риски.
4. Сделать первый вертикальный сценарий: invitation/access → registration → local import/sanitization → dedupe/provenance → Operations/Review → Overview. Его критерии берутся из полной спецификации, а не из урезанной модели.
5. Последовательно подключить весь links/components/rules/counterparties workflow, budgets, Analyzer Registry, quota, History/deletion, administrative access/payment/support и operational flows.
6. Провести synthetic regression/security/restore acceptance, получить owner acceptance Staging и разрешение конкретного Production release.

Прототип — проверка пригодности выбранной технологии, а не новая упрощённая спецификация. Согласование структуры не является разрешением купить услуги или выполнить конкретный Production deployment.

### C-11 Проверенные официальные источники

- Node.js LTS: https://nodejs.org/en/about/previous-releases
- TypeScript strict: https://www.typescriptlang.org/tsconfig/strict.html
- React и Vite: https://react.dev/learn ; https://vite.dev/guide/
- Radix: https://www.radix-ui.com/primitives/docs/overview/introduction
- TanStack Query/Table: https://tanstack.com/query/latest/docs/framework/react/overview ; https://tanstack.com/table/latest
- Apache ECharts ARIA: https://echarts.apache.org/handbook/en/best-practices/aria/
- NestJS/Fastify: https://docs.nestjs.com/techniques/performance
- PostgreSQL RLS/PITR: https://www.postgresql.org/docs/current/ddl-rowsecurity.html ; https://www.postgresql.org/docs/current/continuous-archiving.html
- Drizzle transactions: https://orm.drizzle.team/docs/transactions
- pg-boss: https://github.com/timgit/pg-boss
- Better Auth sessions/reset/TOTP: https://better-auth.com/docs/concepts/session-management ; https://better-auth.com/docs/authentication/email-password ; https://better-auth.com/docs/plugins/2fa
- OWASP password hashing: https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html
- Web Crypto: https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto/sign
- Temporal: https://tc39.es/proposal-temporal/docs/
- PDF.js/Tesseract.js: https://mozilla.github.io/pdf.js/ ; https://github.com/naptha/tesseract.js
- CSV/XLSX: https://www.papaparse.com/docs ; https://docs.sheetjs.com/docs/getting-started/installation/nodejs/
- OpenAI strict tools/data controls: https://developers.openai.com/api/docs/guides/function-calling ; https://developers.openai.com/api/docs/guides/your-data
- GitHub private branch protection/environments: https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches ; https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments
- Vitest/Playwright: https://vitest.dev/guide/ ; https://playwright.dev/docs/intro

## Часть D Россия и минимальный бюджет

Дата первоначального бюджетного уточнения: 4 октября 2026 года. Последующий принятый выбор записан в E; действующие рекомендации ниже приведены в соответствие с ним. Уточнение admin recovery E-04 повышает продуктовую версию до 1.3.

### D-01 Утверждённые ограничения

- Продавец находится в России; пользователи — Россия. Юридическая форма продавца пока не указана.
- Дополнительного бюджета на разработку сейчас нет. Разработка выполняется с помощью ChatGPT/Codex в пределах доступного инструментария и лимитов уже имеющегося доступа.
- Пользователь согласовал предложенную структуру и основной стек. Privacy, imports/dedupe/provenance, links/components, Registry, access/security и release workflow сохраняются полностью.
- Платные сервисы, тарифы, домен и инфраструктура автоматически не приобретаются. Разработка может продолжаться с бесплатными локальными/synthetic adapters.
- Нулевые расходы на разработку не означают постоянно бесплатный Production. Этот чат не является круглосуточным сервером и не предоставляет AI-ответы клиентам сайта как часть нашего диалога.

### D-02 Бесплатный старт разработки

Основной стек сохраняется: TypeScript, React/Vite, Node 24 LTS/NestJS/Fastify, PostgreSQL, Drizzle, pg-boss, Better Auth, local import libraries и собственный finance-core. Платные UI/low-code/code assistants дополнительно не нужны.

Development и предварительный Staging могут работать на имеющемся компьютере в разных контейнерах с отдельными networks/DB/users/keys/secrets/volumes. Предварительный Staging содержит только synthetic data, а email/SMS/AI используют отдельные test adapters. Когда будет выбран hosting, перед Production обязательна проверка в соответствующем реальному размещению отдельном Staging. При использовании временного cloud Staging он оплачивается по фактическому времени и удаляется после проверки; остановленная VM, диск и IP не объявляются автоматически бесплатными.

Не отключаются согласованные возможности ради отсутствия provider accounts. Их interfaces и fixtures реализуются сразу, реальные adapters подключаются и проходят acceptance до Production. Mock AI и email sandbox не обозначаются как работающие production AI/email.

### D-03 Private Git и CI

Принятый основной провайдер — GitHub: private personal repository с GitHub Pro после проверки подключения/оплаты. GitVerse Free сохраняется как исторически рассмотренная бесплатная альтернатива, но больше не является текущей рекомендацией. GitLab.com не выбирается как гарантированный беспроблемный запасной путь: есть ограничения verification для российского телефона.

В официальных страницах GitVerse обнаружено расхождение: pricing указывает Free 2 000 CI minutes/1 GB shared artifact storage, а CI docs — 500 minutes для private repositories и 500 MB artifacts. До создания account и проверки фактических limits используются консервативные 500 minutes/500 MB; окончательные quotas не считаются установленными. При исчерпании не включаются платные пакеты автоматически и не пропускаются checks. Возможен отдельный self-hosted runner для synthetic Development/Staging с ограниченными credentials.

Main защищается от direct/force pushes, merge требует конкретных успешных checks. Production credentials отсутствуют в обычном CI и Staging runner. Release запускает владелец отдельно из доверенного окружения после Staging acceptance конкретного commit/image digest. Финансовая админка не управляет deployment.

Начальный пакет репозитория подготовлен локально: полные исходные PDF/Word, baseline/precedence, план архитектуры, структура monorepo и первые monetary invariants/tests. Это ещё не созданный remote GitHub repository: для remote нужны аккаунт владельца и авторизованный доступ. Секреты нельзя вставлять в документы, исходники или обычные chat messages.

### D-04 AI для российского сервиса

OpenAI API исключается из основного production-плана для объявленного российского продавца/рынка: Россия отсутствует в официальном supported-countries list; нельзя считать зарубежный VPS решением provider eligibility.

Первый production candidate — Yandex AI Studio с серверным provider adapter. Модель для classification и модель для Analyzer выбираются по quality/schema/action tests и цене; дешёвая модель не считается автоматически подходящей для всего Registry. Поставщик модели не пересчитывает финансовые суммы вместо finance-core.

Обязательные настройки кандидата: x-data-logging-enabled: false в каждом запросе, Responses store=false при использовании этого endpoint, выключенный provider tracing. Содержимое для AI предварительно sanitized, chats/semantic context/dependencies хранятся под нашим контролем; hosted Conversations и файлы с выписками не создаются. API/model/region/account configuration проверяется до передачи реальных данных.

Отключение improvement logging не равно отключению всех групп хранения; service/audit logs и API state имеют отдельную семантику. Нельзя заявить «Yandex ничего никогда не хранит». Provider retention отражается в политике продукта. Async result retention требует отдельного учёта, если выбран этот API.

Пример цены только для иллюстрации: в текущем синхронном тарифе YandexGPT Lite входящие и исходящие токены стоят по 0,2 ₽ за 1 000. Запрос 10 000 input + 2 000 output = 2,40 ₽, без платного web tool, retries и других услуг. Это не обещание качества Analyzer на Lite и не фиксированная цена всех запросов. Пример должен пересчитываться при изменении цены/режима/model.

Веб-поиск остаётся отдельным адаптером с sanitized queries и самостоятельным расходом/лимитом. Provider-compatible SDK не является разрешением пользоваться OpenAI endpoint из России.

### D-05 Минимальная платная инфраструктура после разработки

Выбранная основа Production — VPS Timeweb Cloud в российском регионе с контейнерами приложений и предпочтением отдельно обслуживаемого провайдером PostgreSQL 18 при разумной доплате и прохождении проверки возможностей. Начальный resource hypothesis — 2 vCPU/4 GB RAM для приложения; достаточность проверяется нагрузкой и memory limits. Самостоятельный PostgreSQL рассмотрен как резервный экономный вариант, а не текущая безусловная рекомендация. В таком варианте обновления, WAL/PITR и обслуживание базы целиком входят в нашу автоматизацию. Конкретная конфигурация ещё не приобретена.

Staging и Production не используют одну базу/keys/credentials. Постоянный второй облачный сервер на старте не покупается: предварительный Staging локальный, cloud Staging поднимается отдельно перед проверками при необходимости. Самостоятельная база сохраняет transactions/constraints/RLS/provenance semantics.

Backups/WAL, deletion recovery journal и emergency control не существуют только на том же диске/процессе Production. Предлагается отдельное object storage в России и независимый health monitor. KMS candidate — Yandex KMS в России: master wrapping keys вне finance DB, per-user keys защищены envelope encryption. Не требуется отдельный платный KMS key на каждого пользователя; разделение wrapping contexts/key versions должно сохранять разрешённые security boundaries.

Первоначальная оценка 1 500–3 000 ₽/месяц относилась к более экономному варианту с самостоятельно обслуживаемой базой. Актуальный плановый резерв для принятого набора — 3 000–5 000 ₽/месяц на базовую инфраструктуру и GitHub; отдельно AI/web, домен и возможные provider minimums. Это engineering estimate, а не подтверждённая полная смета или обещание верхнего предела. До приобретения сверяются VPS+IPv4, российский регион, storage/WAL traffic, KMS, monitoring, Stage hours и необходимый запас ресурсов. При неизвестных RPO/RTO окончательная стоимость запуска ещё не определена.

На странице Timeweb отображается VPS 4 GB за 1 080 ₽/месяц при выбранной оплате 12 месяцев со скидкой 10%. Деление 1 080/0,9 даёт ориентир 1 200 ₽/месяц без скидки; это расчёт, а не подтверждённый checkout quote. Годовая предоплата не предлагается при нулевом бюджете. IPv4 и дополнительные услуги проверяются отдельно.

### D-06 Email, SMS и ограничения нижней оценки

Выбран основной кандидат для отправки email — Yandex Postbox. SMTP.BZ с заявленными free 15 000 messages/month и daily limit 500 остаётся альтернативой. Перед Production проверяются quotas, transactional delivery, SPF/DKIM/DMARC, data location, processor terms/retention и delivery tests. Бесплатный объём не гарантирует доставку или правовую пригодность. Development/Staging real-user email не отправляют. Postbox — outbound delivery; отдельный почтовый ящик для входящей поддержки им не обеспечивается.

Последующим согласием пользователя обязательный SMS recovery заменён одноразовыми recovery codes, хранимыми владельцем отдельно от телефона; точное принятое поведение приведено в E-04. Телефон больше не является обязательным фактором именно этой recovery ветки. Email/Telegram не становятся обходом TOTP. SMS не приобретается и может вернуться только по отдельному решению.

У SMS.RU официальная pricing page показывает ежемесячные fees для собственного sender name (например МТС 3 000 ₽, Мегафон 2 550 ₽, Билайн 2 080 ₽) плюс сообщения и, в ряде случаев, template fees. Нельзя обещать «SMS стоит несколько рублей в месяц» лишь потому, что recovery вызывается редко. Это не доказательство одинаковой цены всех OTP решений: подходит ли общий/service sender без таких fees, проверяется отдельно. После принятия E-04 эти SMS fees не входят в текущую базовую смету; общая смета всё равно остаётся предварительной до проверки остальных ресурсов.

Юридическая форма продавца, data retention, RPO/RTO, privacy/legal documents и платёжно-налоговые обязанности остаются открытыми до запуска. Размещение в РФ само по себе не закрывает все юридические требования. Они не мешают бесплатной разработке с synthetic data, но не пропускаются ради низкой цены.

### D-07 Выполнено сейчас и следующий внешний шаг

Подготовлен сохраняемый начальный Git-пакет без paid services: исходные product docs, текущая baseline, monorepo boundaries, money serialization/range/component invariants и tests. На Node 24 прошли 10 тестов, включая 2 000 детерминированных signed-decomposition сценариев, и проверка неизменности исходных PDF/Word по SHA-256. Используется native type stripping, а не полный compiler typecheck; Docker здесь отсутствует, поэтому containers ещё не запускались. Финансовые UI/API/import/security workflows ещё должны быть реализованы по полной спецификации.

Следующий внешний шаг — подключение GitHub владельца и проверка работы с private remote. Доступ можно испытать на Free до покупки Pro; затем включаются доступные на выбранном плане protection и CI. Пока доступа нет, подготовленный пакет сохраняет текущую работу; он не считается работающим сайтом или настроенным облачным Staging.

### D-08 Официальные источники бюджетного уточнения

- [OpenAI supported countries](https://developers.openai.com/api/docs/supported-countries).
- [GitVerse pricing](https://gitverse.ru/home/pricing/), [branch protection](https://gitverse.ru/docs/collaborative/repositories/guides/pull-requests/branch-protection/), [CI limits](https://gitverse.ru/docs/cicd/docs/limits/).
- [GitLab phone verification](https://docs.gitlab.com/security/identity_verification/).
- [Yandex AI pricing](https://aistudio.yandex.ru/ru/docs/ai-studio/pricing), [data storage policy](https://aistudio.yandex.ru/ru/docs/ai-studio/concepts/security/data-storage), [disable improvement logging](https://aistudio.yandex.ru/ru/docs/ai-studio/operations/disable-logging).
- [Timeweb VPS](https://timeweb.cloud/services/cloud-servers), [object storage](https://timeweb.cloud/services/s3-storage).
- [Yandex KMS pricing](https://yandex.cloud/ru/docs/kms/pricing).
- [SMTP.BZ free offer](https://smtp.bz/), [SMS.RU pricing](https://sms.ru/price).


## Часть E Утверждённая базовая структура и домен

Дата: 4 октября 2026 года, Europe/Moscow. Основание: сообщение пользователя «Про все что ты сказал согласен давай выбирать это базовой структурой» после сравнения вариантов и проверки интеграций. Согласие распространяется на рекомендованную основу и явно сохранённые условия её выбора, а не на обещание непроверенных возможностей.

### E-01 Цена, качество и полнота

Разработка выполняется ChatGPT/Codex без привлечения оплачиваемого разработчика и без дополнительных подписок на инструменты разработки, в пределах доступных возможностей и лимитов среды. Владелец готов оплачивать разумные улучшения качества, удобства и обслуживания; правило «только самый дешёвый вариант» отменено. Регистрация, авторизация аккаунтов, оплата и одобрение Production требуют предусмотренных действий владельца.

Основой остаются полный исходный PDF, контекст Word и все утверждённые A/B. Функциональность не сокращается из-за цены или доступности интеграции. Единственное согласованное изменение прежнего продуктового access flow в этой части — E-04. Продуктовая база становится 1.3. Для реализации ведётся соответствие: требование → реализация → проверка, включая privacy/HMAC, imports/dedupe/provenance, links/components, Analyzer Action Registry, access/security, удаления и release workflow.

### E-02 Программная основа и private Git

TypeScript strict, React + Vite для web/admin, Node.js 24 LTS + NestJS/Fastify, PostgreSQL 18, Drizzle, pg-boss, Better Auth и перечисленные в C local import/UI/test libraries сохраняются. Private monorepo и разделённые runtime полномочия сохраняются.

GitHub выбран основным Git host. Рекомендуемый принятый план — GitHub Pro для personal repository; если владельцем repository станет организация, её тариф выбирается отдельно, personal Pro на организацию не распространяется. Официальный ориентир Pro — $4/месяц; итог в рублях зависит от оплаты и курса. Интеграцию и доступ к private repository сначала можно проверить на Free. GitVerse — резервный ранее рассмотренный вариант, готовой интеграции в доступном каталоге не найдено.

Pro не гарантирует native required-reviewer Production gate для private repository. Согласованный owner-controlled release, одинаковые проверенные artifacts и отсутствие production credentials в обычных checks обеспечиваются отдельным механизмом. Hosted CI ещё не запускался. Draft bootstrap workflow перенесён из GitVerse в GitHub; он проверяет только исходные документы и имеющиеся денежные primitives и не является полной release acceptance.

### E-03 Размещение и среды

Выбрана основа: Timeweb Cloud, российский регион, контейнеры приложения на VPS и отдельно обслуживаемый провайдером PostgreSQL 18 при разумной доплате и подтверждении требований. Размер 2 vCPU/4 GB RAM — проверяемая стартовая гипотеза, не пользовательский лимит и не гарантия нагрузки. Самостоятельная база остаётся резервным вариантом, если конкретная цена/возможности managed DB дают обоснованную причину пересмотреть размещение.

Development — разработка и отдельные проверки; Staging — целые сценарии на synthetic данных; Production — работа пользователей. Данные, DB/users/keys/secrets/storage/workers и provider adapters изолированы. Cloud Staging может быть временным, но перед каждым Production release должен пройти соответствующие проверки на принятом размещении. Диски/IP и хранилища после остановки VM не объявляются бесплатными.

Backups/PITR, deletion recovery journal, защищённые ключи, независимый мониторинг примерно раз в 60 секунд и emergency control сохраняются. Managed DB не отменяет проверки реального восстановления и повторного применения журнала удаления до открытия восстановленного сервиса. Storage/KMS, retention, RPO/RTO и цена выбранных возможностей ещё не закрыты.

Timeweb App Platform рассмотрен, но не выбран по умолчанию: Git-based deploy заново собирает приложение; штатный путь готового образа через Docker Hub допускает только публичные images; Compose имеет дополнительные ограничения. Нельзя открыть код/образ или отказаться от переноса одной проверенной сборки ради удобства панели. Применимость другого пути должна быть подтверждена отдельным proof-of-concept.

### E-04 Admin TOTP и аварийное восстановление

Принято: обязательный TOTP для обычного административного входа; аварийное восстановление через одноразовые recovery codes, сохранённые владельцем отдельно от телефона. Обязательная SMS recovery ветка заменена этим решением. Платный SMS provider не входит в базовый набор. Email/Telegram не предоставляют обход TOTP. Подтверждённый телефон больше не требуется именно как SMS-фактор этой recovery ветки; другие явно предусмотренные цели phone data не изменяются автоматически.

Для входа в recovery flow требуется свежая проверка основного фактора — пароля; recovery code заменяет потерянный второй фактор. Password reset сам по себе не заменяет recovery code и не выдаёт admin capabilities. Восстановление прекращает все прежние admin sessions, делает прежний TOTP недействительным и требует нового verified TOTP enrollment до выдачи admin capabilities. Recovery code не даёт обычного административного доступа без этого шага. Сохраняются reauthentication, audit и ограничения опасных actions. Хранение code verifier, атомарное однократное использование, rate limits и recovery-only session проверяются отдельным security proof-of-concept; секретные коды не хранятся открыто в Git, logs или admin read endpoints.

### E-05 AI и email

Yandex AI Studio выбран первым провайдером для испытаний. Конкретная production model не утверждена: собственные модели Яндекса, Qwen и DeepSeek сравниваются на общих corpus/schema/action/privacy tests. GigaChat — второй кандидат при подходящих коммерческих условиях; его freemium не объявляется коммерческим runtime. OpenAI API не становится основой объявленного российского продукта.

Finance-core, dedupe/provenance, links/components и авторизация реализуются детерминированным backend. AI формулирует запросы/предложения только через versioned closed Registry. Sanitization, x-data-logging-enabled:false, Responses store:false и выключенные tracing/state storage проверяются раздельно. Реальные model/tool calls, quality и полный переменный cost ещё не измерены.

Yandex Postbox выбран основным кандидатом для outbound transactional email. Первые 2 000 исходящих писем/месяц сейчас бесплатны; после них в первом диапазоне примерно 80,32 ₽ за 1 000. SMTP.BZ сохраняется альтернативой. До Production нужны domain verification, SPF/DKIM/DMARC, delivery и privacy/retention checks. Входящий support mailbox/маршрут обращений — отдельная незакрытая настройка; Postbox не является готовым входящим почтовым ящиком.

### E-06 Домен и HTTPS

Собственный домен — отдельно оплачиваемое ежегодное право на имя. Регистратор оформляет адрес на владельца; DNS связывает адрес с нашим размещением и почтовой отправкой. Смена hosting не требует смены принадлежащего владельцу домена. Домен не включает сам сервер, базу данных или почтовый ящик.

Рекомендация для российского сервиса — обычное свободное имя в .ru, без покупки премиального занятого адреса. Это рекомендация, а не согласованное конкретное имя/покупка. У Timeweb на 4 октября 2026 года указаны 200 ₽ за регистрацию первого года и 399 ₽ за ежегодное продление .ru. 399/12 = 33,25 ₽/месяц в усреднённом бюджете, но платёж годовой. Акция и будущая цена проверяются перед оформлением и продлением.

Один основной домен позволяет использовать поддомены для приложения, admin, API и Staging; это не четыре отдельные регистрации. Staging защищается доступом, а не секретностью его адреса. DNS hosting может быть бесплатным; конкретные records/API access проверяются после выбора регистратора. HTTPS выполняется бесплатными сертификатами Let's Encrypt с автоматическим продлением и мониторингом; бесплатный сертификат не заменяет прочие security controls. Рабочее публичное размещение и реальная email verification потребуют подтверждённого домена; Development может продолжаться без покупки.

### E-07 Доступ агента и бюджет

Подтверждено discovery: GitHub integration доступна к подключению, но аккаунт владельца ещё не подключён и private write/CI operations не испытаны. У Timeweb есть официальный API и remote MCP для инфраструктуры; прямого подключённого Timeweb инструмента в этой сессии нет. Наличие инструкции для Codex/других клиентов не доказывает подключение в текущем ChatGPT Work. MCP не поддерживает удаления и требует подтверждения изменяющих операций.

До окончательной покупки размещения требуется реальный цикл: изменение кода → hosted checks → обновление Staging → browser/API checks → безопасное восстановление предыдущей версии с проверкой совместимости migrations. Production остаётся отдельным owner-controlled действием. API keys вводятся через предназначенные secrets/account controls, не обычным сообщением в чат. Отдельные real AI/email/monitoring/backup tests обязательны до пользователей. Агент работает во время сессии; круглосуточная работа обеспечивается приложением и настроенной автоматизацией.

Принят плановый ориентир 3 000–5 000 ₽/месяц на базовую небольшую инфраструктуру и GitHub. Это engineering estimate, не оплаченный тариф, не окончательная смета и не гарантированный верхний предел. AI, web search и годовой домен учитываются отдельно. Подробная смета должна содержать VPS/IPv4, managed DB, Staging, backups/storage/PITR, KMS, monitoring, CI storage/usage, email overages, domain registration/renewal и возможную входящую support почту. Расходы не включаются автоматически при исчерпании квот.

### E-08 Что ещё не принято или не проверено

- Конкретное имя домена, регистратор, подтверждение владения и доступ для DNS.
- Реальное подключение GitHub/Timeweb и полный пробный цикл публикации/проверки/восстановления.
- Точная цена, регион/профиль ресурсов и security/backup возможности managed PostgreSQL; окончательная смета.
- Production model(s), web search provider, quality/cost corpus и реальные retention/region settings.
- Входящая поддержка, почтовые квоты/доставка, KMS/storage/independent monitoring configuration.
- Retention windows кроме согласованной History 30 дней, RPO/RTO, юридическая форма продавца и правовые тексты/обязанности.
- Patch versions/lockfile, конкретная криптографическая реализация и оставшиеся явно обозначенные технические предложения C, включая точное DST disambiguation rule.

Эти вопросы не объявляются согласованными одним выбором базовой структуры и не препятствуют реализации на synthetic данных. Новые платные аккаунты, remote repository, облачные среды и Production этой фиксацией не созданы.

Источники, проверенные 4 октября 2026 года:

- GitHub plans/Pro: https://docs.github.com/en/get-started/learning-about-github/githubs-plans ; https://docs.github.com/en/get-started/learning-about-github/faq-about-changes-to-githubs-plans
- GitHub environment limitations: https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments
- Timeweb VPS/PostgreSQL: https://timeweb.cloud/services/cloud-servers ; https://timeweb.cloud/docs/dbaas/postgresql
- Timeweb MCP: https://timeweb.cloud/docs/ai-agents/timeweb-cloud-mcp
- App Platform: https://timeweb.cloud/docs/apps/how-it-works ; https://timeweb.cloud/docs/apps/deploying-with-docker-hub ; https://timeweb.cloud/docs/apps/deploying-with-docker-compose
- Yandex Postbox: https://yandex.cloud/ru/docs/postbox/pricing
- AI pricing/data settings: https://aistudio.yandex.ru/ru/docs/ai-studio/pricing ; https://aistudio.yandex.ru/ru/docs/ai-studio/concepts/security/data-storage
- GigaChat commercial conditions: https://developers.sber.ru/docs/ru/gigachat/tariffs/commercial ; https://developers.sber.ru/docs/ru/gigachat/tariffs/individual-tariffs
- .ru registration/renewal: https://timeweb.com/ru/services/domains/ru/
- Free TLS/HTTPS: https://letsencrypt.org/ru/
