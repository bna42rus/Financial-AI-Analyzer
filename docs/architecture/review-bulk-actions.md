# Массовая правка и последовательный ручной Review

Development-блок `feature/review-bulk-actions` от PR №28, `fceb99c23f828f62287c39598bdb22d8ae7a45d0`. Источники: полный Master Specification, разделы 7, 10, 23, 25, 34, 49.2–49.4, 51, 53.7, 55.4; согласованные baseline A-06/A-08 и B-01/B-03. Исходные PDF/Word/baseline и их hashes не изменяются. Реестр остаётся partial; результаты полного CI указываются для конкретного head в PR.

## Поведение

На экране сохранённых операций есть поиск, фильтры причин/состояний проверки, выбор отдельных строк, диапазонов с anchor, всех найденных строк, стрелки/Space/Shift/Ctrl/Cmd. Выбор всех охватывает весь полученный filtered result, а не видимую часть страницы. Текущее ограничение workspace — 10 000 операций, действие/сессия — 1000; превышение не обрезается молча. Полная серверная пагинация и квалификация на больших наборах ещё впереди.

Категория/подкатегория, kind, role, counterparty, comment, include/exclude/default, просьба о проверке и подтверждение отдельных facets доступны как массовая команда. Категория очищает прежнюю подкатегорию, если новая не указана. Подтверждение берёт индивидуальное сохранённое значение каждой записи. Оно снимает только соответствующие причины, сохраняет прочие duplicate/link/import reasons и не подменяет банковские facts. Просьбу пользователя можно снять независимо от остальных причин. `review_status` отображает none/recommended/required/verified отдельно от списка причин.

Набор IDs и finance epoch фиксируются при открытии формы, сохраняются в intent и не расширяются новыми импортами. Вне Review обязательны серверный preview с точным числом, пересчётом, значениями и явное подтверждение. Preview откатывает все пробные изменения. Commit выполняет всю выборку в одной транзакции, создаёт один action_id/History delta и общий Undo; ошибка любого элемента откатывает все элементы. Потеря подтверждения требует точного повтора той же команды. Итог показывает число обработанных и число оставшихся с причинами проверки. Частичного успешного результата в этом контракте нет.

Role/category/subcategory для parent с действующими components или derived allocations блокируются: редактировать их нужно в карточке соответствующих частей. Parent inclusion не изменяет связанные поступления автоматически; preview сохраняет предупреждение о возврате, остающемся в аналитике. Одиночные corrections и сложные связи остаются отдельными редакторами.

При изменении данных на другом устройстве форма показывает прежние/текущие значения, сохраняет попытку и предлагает обновить либо явно применить своё решение к текущим данным. Выборка остаётся прежней; новый preview обязателен вне Review. Исчезновение записи/смена generation не допускают повторного использования старой формы. Навигация блокируется пока результат записи неизвестен.

## Review в Analyzer

Ручной Review стартует из Operations с выбранными требующими внимания IDs либо в Analyzer со всеми требующими внимания, в хронологическом порядке. Сессия хранит фиксированный список, cursor, решения skipped/unknown/resolved_elsewhere/unavailable, status и revision. Новые импорты не добавляются. Back, Skip, «Не знаю», пауза, продолжение и завершение доступны; уже решённые в другом месте записи автоматически пропускаются. Завершение списка честно показывает оставшиеся нерешённые причины и позволяет начать новый разбор.

Классификация внутри Review применяется сразу через тот же обратимый finance command; History/Undo доступны. Каждый facet выбирается явно. Skip/«Не знаю» сохраняют только прогресс и не снимают финансовые причины. После частичного решения обновление значений позволяет решить следующий facet. Групповые предложения похожих операций и естественно-языковой/AI Review пока не реализованы; ручной режим доступен без внешнего провайдера.

Прогресс хранится на сервере и доступен после перезагрузки/на другом устройстве. Progress commands имеют собственные commandId, request/result receipt, generation и optimistic session revision. Точный повтор после обрыва связи возвращает первоначальный результат; повтор ID с другим запросом отклоняется. Два устройства не могут молча перезаписать cursor. Review read может автоматически продвинуть разрешённые записи и обновить revision.

## Доступ и миграция

`/finance/review-sessions` и `/finance/review-command` доступны только authenticated Finance profile при действующем финансовом доступе. Control не загружает финансовый repository. Применяются существующие Origin/JSON/body/rate/transaction ограничения; для preview и Review команды body limit 64 KB поддерживает 1000 UUID. Progress/receipts содержат opaque IDs, не суммы или финансовые тексты. Browser storage не получает финансовые данные. Отзыв доступа очищает UI; поздние ответы не возвращают контекст.

Миграция 0016 после 0001–0015: `APP_ENV=development` и отдельный migration-owner connection, `pnpm --filter @finance/api operator migrate-review-sessions`. Новые таблицы имеют tenant composite keys, FORCE RLS/own_data и immutable tenant triggers; control/mail/PUBLIC не получают доступ. Удаление operation очищает её ссылки/решения и затронутые receipts, корректирует cursor. Смена workspace generation удаляет сессии/receipts; workspace/user cascade действует также. Персональные старые финансовые значения не копируются в progress.

Миграция additive и forward-only. Для отката приложения можно оставить таблицы и cleanup triggers установленными, отключив новый UI/route; destructive down migration не требуется. Перед Staging нужны rehearsal миграции, scoped grants, cleanup, restore и forward-fix. Новые credentials/Production runner не создавались; main не объединяется и Production не публикуется этим блоком.

## Проверки и границы

Pure/client проверки: диапазоны и fixed IDs, категории/подкатегории, independent verification/status, sanitation, запрет неоднозначных частей, захваченный epoch после polling. PG/HTTP: read-only preview, единая история/Undo, immutable bank facts, закрытые поля/валидность всех IDs, атомарный отказ, 1000/1001 boundaries, generation/revision/access expiry, idempotency/two-device conflicts, auto-advance, tenant isolation/control/mail, deletion/reset cleanup.

Desktop/mobile интерфейс: fixed preview/cancel при новых данных, stale form и явное новое решение, точный retry потерянного progress acknowledgement, resume после reload, late-response/access revoke. Полный реальный HTTP/PG browser journey дополнительно проверяет mass commit lost acknowledgement, Undo, независимые причины, pause/new import/resume с прежним списком, immediate Review classification, корректные expenses/income и отсутствие storage/горизонтального overflow. Существующие проверки не отключаются. Синтетические тесты не заменяют real-bank/device/Staging acceptance.

Остаются полные структурные редакторы Settings/правил, массовое создание правил и удаления, групповые предложения Review, полный Registry/AI, прочие форматы/финальная классификация, budgets/views/widgets, большие объёмы и приёмка выпуска. Весь продукт и целые разделы спецификации готовыми не объявляются.
