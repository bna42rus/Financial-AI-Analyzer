# Связи производных частей — шестой серверный блок этапа 4

Основание: PDF 8.1–8.6, 9.3/9.7–9.9, 12.4–12.5, 24.6–24.7, 34.3–34.6, 36.2–36.4, 49.4 и 52.5; утверждённые A-03/A-04/A-06 и B-01/B-02/B-04/B-05. Источники и baseline 1.3 не изменены. Ветка `feature/derived-links` основана на `feature/financial-reset` и зависит от PR №17.

## Что изменилось

Раньше allocation могла адресовать только исходную transaction либо её явный component. Теперь можно связать новую банковскую operation с конкретной автоматически выведенной частью возврата, компенсации, отмены или нейтральной пары. Поддерживаются несколько уровней: purchase → refund allocation → reversal allocation → reversal. Одна банковская строка остаётся одной transaction; выведенные части не создают новые source observations и не содержат копию исходной покупки.

Например, покупки −6 000 ₽ «Продукты» и −4 000 ₽ «Одежда» покрыты одним возвратом +10 000 ₽. Банковская отмена −2 000 ₽ относится только к продуктовой части возврата. Она получает expense и категорию «Продукты», увеличивает net expense на 2 000 ₽ в свою банковскую дату и не создаёт доход. Отмена самой отмены на +2 000 ₽ уменьшает расходы в дату нового движения.

## Контракт

Тот же closed `link` intent через `/finance/preview` и `/finance/commit`, со следующими необязательными полями:

| Поле | Значение |
| --- | --- |
| sourceComponentId / targetComponentId | Явный активный component указанной operation |
| sourceAllocationId / targetAllocationId | ID сохранённого link, создавшего выбранную аналитическую часть указанной operation |

На каждой стороне разрешён один селектор: component либо allocation. Пустой селектор сохраняет прежний root endpoint. Если активное распределение изменило root, новая связь должна назвать соответствующую часть, иначе `AMBIGUOUS_ENDPOINT`. Для неизвестного остатка не выдумывается экономическая роль.

Каждая выведенная projection part возвращает `allocationId`; остаток исходного root/component имеет null. После дальнейшего распределения показываются только конечные части и остаток, а не сумма части вместе с её предками. `componentId` сохраняет происхождение из явного component. `id` projection part — непрозрачный технический ключ; persisted references используют allocationId, а не разбирают текст id. `basis` содержит непосредственные link/operation dependencies; цепочка раскрывается по собственным сохранённым links.

Link всегда создаёт source portion. Target portion существует только у own_transfer/debt_repayment, которые действительно нейтрализуют обе стороны. Поэтому target-side portion этих пар также можно адресовать новой отменой. Уже сопоставленную own-transfer/debt portion нельзя повторно использовать как source другого matching: `SOURCE_ALREADY_PAIRED`; сначала нужно изменить исходную пару. Это не позволяет одним движением скрыть несколько независимых встречных операций. Repayment mapping на purchase не нейтрализует purchase.

## Общие расчёты и конфликты

- Итеративный dependency order и flattening; нет рекурсивного обхода JS-стека. Candidate/rejected/inactive producer не создаёт пригодный endpoint. Cycle и зависимые от него интерпретации получают conflict.
- Signed amounts, точная сумма конечных частей = effective amount. На обоих endpoints проверяются capacity; все участники превышенного пула отклоняются, без произвольного победителя или обрезания суммы.
- Refund/reimbursement/reversal совместно используют соответствующий return pool; credit-card repayment остаётся отдельным. Nested reversal не освобождает молча gross capacity предыдущего confirmed allocation: изменение самого allocation требует отдельного preview.
- Role/category/subcategory наследуются через актуальные endpoints. Независимые user-verified facets сохраняют приоритет. Категория покупки и режим кредита пересчитывают зависимую цепочку; source facts не переписываются.
- Если ancestor после нового observation/изменения component/capacity стал invalid, descendants также не участвуют. Сохранённые status/amount/reference не стираются. Возвращение согласованных данных восстанавливает расчёт.
- Фильтр даты использует дату каждой банковской операции, category — её конечные parts. Inclusion/exclusion остаётся независимым для каждой operation; linked scope не расширяется автоматически.

## База, история и удаление

Migration 0011 добавляет nullable references без переписывания прежних observations/links. Composite FK включают user_id, FORCE RLS сохраняется. Прямое обращение к отсутствующему/чужому producer или неправильной operation запрещено. Deferred invoker-rights trigger дополнительно проверяет правильный endpoint и отсутствие cycles, в том числе при direct SQL с runtime role. Public/control/mail не получают новую capability. Deferred checks позволяют атомарно восстановить согласованный набор объектов.

Новые endpoints входят в before/after journal. Null allocation fields отсутствуют в нормализованном snapshot, поэтому отсутствие этих полей в старом journal само по себе не создаёт ложный OBJECT_CHANGED. Single rollback ancestor не удаляет unselected descendants через FK cascade: virtual dependency check показывает conflict. Выбранный rollback ancestor + descendants проходит как одна транзакция; после replay повторяются FK и graph checks.

Selective deletion строит полный reference closure для links, считает все удаляемые связи и показывает все surviving related operations. Закрытый набор links удаляется перед transaction cascade. FK ON DELETE CASCADE также удаляет descendants при прямом удалении producer. Surviving banking operations остаются, смысл без независимого подтверждения становится unresolved; ручной role/category сохраняется. Старые financial journals/previews очищаются по существующей deletion policy. Full reset удаляет всю цепочку вместе с остальными поддержанными данными.

## Проверки и границы

Добавлены 17 pure graph сценариев и 20 PostgreSQL18/HTTP сценариев. Pure suite проверяет в том числе 1 500 последовательных reversals, shuffled dependency input, source и target portions, shared capacities, income/neutral/expense math, manual priority, invalid ancestors и повторное matching. HTTP/DB suite проверяет preview/commit/retry, independent confirmations, tenant isolation, deferred SQL constraints, source/loan/component changes, single/bulk Undo, transitive deletion, verified survivors и reset. Exact-head GitHub evidence фиксируется в PR после завершения.

`pnpm run check` — исходные hashes, unit/projection tests, строгие типы, обе сборки. `pnpm run test:security` — прежние и новые настоящие PostgreSQL/HTTP suites. Development operator после 0001–0010: `APP_ENV=development`, loopback MIGRATION_DATABASE_URL, `operator migrate-derived-allocations`; migration выполняется в общей транзакции. Production migration/forward-fix и acceptance остаются отдельным этапом.

Это серверное расширение финансовой модели. UI editing/Review, actual Import/parser/OCR/dedupe/cancellation/queue, automatic matching, Analyzer actions, budgets/calculators и будущие module cascades не объявляются завершёнными. Длинная pure цепочка не подтверждает нагрузочную готовность всей БД/API. Существующий Development snapshot limit 10 000 transactions сохраняется; пагинация, большие scope/chunks и Staging acceptance впереди. Пункты registry остаются partial.
