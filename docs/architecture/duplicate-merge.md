# Объединение дубликатов — Development

Основание: полный PDF 6.1, 19.4–19.8, 34.3–34.6, 52.4–52.5 и approved B-07, A-05/A-06. Источники PDF/Word, baseline 1.3 неизменны. База PR №26: `1c45a3aedc0eebc8c4805d143a8dd596137e823d`; ветка `feature/duplicate-merge`. Этот блок не закрывает всю спецификацию.

## Решение и preview

В Операциях у Possible Duplicate есть «Это одна операция». Сравнение загружает обе собственные карточки и сохраняет их generation/revision; поздний ответ после навигации/потери доступа не возвращает данные. Пользователь выбирает сохраняемый внутренний transaction ID и банковский source из двух существующих операций. В intent входят только собственный pair ID, canonical ID, коды сторон для разрешённых полей и явно выбранные собственные link IDs; произвольных source facts или новых значений нет.

Единственная ручная правка переносится; разные user-verified/source=user facets, corrections, комментарии и явно заданные analytics overrides требуют выбора. Доступен явный выбор другого существующего значения, включая отсутствие исправления. Bank facts не заменяются effective corrections. Совместимость итоговой категории/role проверяется отдельно.

При двух наборах components пользователь выбирает один; суммы проверяются по effective amount. Другой набор остаётся неактивным для Undo. Можно явно отказаться от decomposition в объединённой операции. Выбранные component IDs сохраняются. Links сохраняют свои IDs, amount и allocation references, endpoints переносятся на canonical transaction. Замыкание связи на себя, потеря component endpoint, переполнение capacity и новые dependency conflicts блокируют commit. Удаление несовместимой связи и её зависимых descendants требует явного выбора; preview показывает число последствий. Старые конфликты не выдаются за успешные активные связи.

Preview и commit используют действующие ownership/access-cycle/workspace locks, epoch/revision/dependency checks, один action ID и lost-ack retry. На неразрешённом preview commit возвращает `MERGE_CONFLICT`. После commit в активной аналитике одна operation.

## Источники и ID

Ни одно поле immutable source_observation не обновляется. Original transaction ID и file ordinal каждой observation сохраняются. Mutable transaction aliases (`merged_into_id`) дают логическое canonical ownership всех surviving observations без копирования source facts. Семья всегда плоская: повторный merge переносит все старые IDs непосредственно на нового canonical. Composite tenant FK, forced RLS и deferred source-membership/chain constraints защищают границы; source_observation по-прежнему не имеет runtime UPDATE/DELETE grants.

Чтение по прежнему ID возвращает canonical карточку только тому же user. Изменение по архивному ID возвращает `OPERATION_MERGED`: нужно открыть текущую карточку. Import reports, account/counterparty source bindings и matcher используют canonical IDs. Когда pairs схлопываются, ранее сохранённое «разные операции» имеет приоритет; review reasons следуют оставшимся active pairs.

Known same-file ordinals, которые пользователь явно объединил, могут повторно сопоставиться с тем же canonical даже внутри одного файла. Это не распространяется на незнакомые строки: для bank-ID/strict matching остаётся one-to-one и консервативная неоднозначность. Новая observation после merge — новая зависимость: она увеличивает canonical revision даже при неизменных facts, поэтому Undo не перераспределяет новые источники молча.

## Undo, отмена файла и физическое удаление

Merge сохраняет delta (включая aliases, selected source, pairs, components/links/bindings) для существующего checked 30-day History/Undo. Все original IDs и observations остаются. Undo атомарно возвращает две active operations, выбранные ранее values, исходные endpoints/parent IDs и pairs, если object versions и зависимости совпадают. Поздние edits/imports, истечение истории и уничтоженные объекты не перетираются и не воскрешаются.

Cancel Import собирает источники всей canonical family, выбирает последнюю surviving observation и оставляет verified manual edits на canonical. Archived pointer не может удержать отменённый источник: выбирается surviving original source либо alias остаётся только как ID reference без старых values/components. Когда последний source удалён, canonical и вся семья физически удаляются. Действующий legacy evidence guard остаётся: shared cancellation без надёжного direct evidence блокируется.

Physical deletion canonical transaction каскадно очищает aliases, все original observations/provenance/fingerprints и старую финансовую History по существующей privacy policy. Повторный import создаёт новый ID. Пустые счета сохраняются, если не выбрано удаление карточки счёта. Reset удаляет всю семью вместе с workspace.

## Миграция и проверка

После 0014 применяется `0015_duplicate_merge.sql`: `operator migrate-duplicate-merge` в существующей operator transaction. Нет нового privileged runtime write path. Старую сборку нельзя запускать как rollback после появления aliases/nullable archived pointers: она не знает canonical semantics. Отдельный Staging acceptance и migration/backup/restore/forward-fix proof по-прежнему требуются.

Unit checks проверяют ручные конфликты, metadata verification, exact money и source-instance границы. PostgreSQL/HTTP checks покрывают immutable source preservation, canonical/alias ownership, checked Undo и поздние edits, selected components/allocations, explicit self-link removal, rejection collapse, плоскую семью, cancellation/reimport/deletion. Connected UI и real HTTP browser journeys desktop/mobile проверяют preview/decline/conflicts/lost acknowledgement/exact retry/Undo и удаление финансового DOM при suspension.

Фактические результаты полного CI окончательного SHA фиксируются в PR. Synthetic browser fixtures не заменяют PostgreSQL, реальные Safari/Android и проверку владельца на Staging.

## Границы

10 000 retained transaction IDs на текущий workspace snapshot, включая архивные aliases. Полные fuzzy/description matching, CSV/XLSX/OCR, review/rules/structural editors, бюджеты, полный Analyzer/Overview и будущие chat/cache/widget dependency providers не появляются от этого блока и не считаются проверенными. Timeweb, Production и сервисы эта ветка не изменяет.
