# Отмена источников импорта и строгая дедупликация — Development

Основание: полный PDF 18–20, 35–36; A-02/A-05/A-06, B-02/B-03/B-07/B-08. База — проверенный PR №25, remote head `75a7a4fd72ebc48f289e13344c0bc87caee7738f`; новая ветка `feature/import-cancellation-dedupe`. PDF/Word и baseline 1.3 неизменны. Это следующий блок после аудита, а не заявление о выполнении всей спецификации.

## Отмена файла и batch

Настройки → Загрузки открывают отмену отдельного файла или всей загрузки через тот же `/finance/preview` → `/finance/commit`. Intent `{kind: 'cancel_import', batchId, fileId?}`. Сервер фиксирует собственный scope, generation/revision/action ID; права и зависимости повторно проверяются перед commit. Worker и cancellation используют общий порядок access-cycle → workspace locks. Потерянное подтверждение повторяется с тем же action ID.

Preview показывает удаляемые уникальные операции, сохраняемые shared operations, прямые банковские source values до/после восстановления, наличие ручных правок, links/recalculation, остановленные pending rows и очищаемую финансовую историю. Никакие effective corrections не выдаются за bank source. Общие фильтры не расширяют scope.

Уникальные операции и зависимые components/links удаляются. У shared operations выбирается последняя оставшаяся observation по `(observed_at, id)`; банковские kind/merchant и текущие personal rules пересчитываются, user-verified facets/corrections/comment сохраняются. Конфликтующие decomposition/allocations проходят общий финансовый reconciliation и не дают ложных окончательных итогов. Пустые accounts сохраняются. Убирается только затронутый orphan discovered counterparty без user revision, регистрации, оставшихся observations/operations/rules или merged children.

Cancelled file сохраняет технические metadata, timestamp, bank и rows-found, но теряет file fingerprint, rows/payloads и финансовые source observations. Циклические tenant FK удаляют source observation при удалении provenance row; прямой UPDATE/DELETE immutable bank facts для runtime по-прежнему запрещён. Полная отмена batch останавливает dispatch и даёт `cancelled`; отдельный файл не останавливает remaining accepted files. Generation меняется, HMAC key/version — нет; surviving accepted jobs получают новый generation, старые browser contexts/previews не могут вернуть удалённые данные.

Как и в существующем physical-delete flow, прежние action previews/history с whole-workspace totals очищаются целиком. Preview сообщает этот count. После commit остаётся только count-only receipt без before/after, источников или Undo payload. Обычного Undo нет: восстановление — reimport с новым внутренним transaction ID для физически удалённой операции. Это консервативная текущая cleanup policy, не выборочное сохранение всей unrelated History.

История имеет серверные фильтры Все/Завершённые/Ошибки/Отменённые и pagination. Cancelled filter включает batch с любым cancelled file. Report возвращает собственные surviving canonical operation IDs и epoch; переход к операциям batch/file использует их совместно с текущими серверными global-filter IDs.

## Прямые source evidence вместо копий старого текста

Новая observation хранит только собственные разрешённые признаки. Finite `{event, merchant}` записывается в provenance с `evidence_recorded`; чтение объединяет отсутствующее evidence только из реально surviving observations до выбранного источника. Inherited merchant/description не копируется в новую immutable observation. Поэтому отмена единственного файла с merchant evidence не оставляет его внутри поздней text-free observation или bank classification.

Legacy observations без recorded evidence нельзя безопасно трактовать как независимые источники текста: старый профиль материализовал inherited fields. Shared cancellation в таком случае возвращает `IMPORT_SOURCE_UPGRADE_REQUIRED` без изменений. Нужна отдельная проверка/перестроение происхождения; автоматического выдумывания evidence нет. Уникальные legacy operations можно удалить вместе со всеми их sources. Это существенная граница обновления старой базы, даже при отсутствии Production пользователей.

## Строгий fingerprint и решение «разные операции»

Порядок matching: same-file instance → reliable stable bank ID → strict finite-profile fingerprint → Possible Duplicate. Fingerprint version `strict-bank-source/1` включает keyed per-user source alias, точный bank instant, posting-date precision/value, signed amount, currency, direction и explicit event/known merchant. Descriptor хешируется; он уже содержит user-keyed alias, не становится глобально сравнимым fingerprint. Его нет в read responses или logs.

Дата без времени, неизвестный merchant/description, unknown direction или конфликтующий stable ID не разрешают strict match. Две реальные одинаковые строки одного файла остаются разными instances. Один canonical ID используется максимум один раз на file, включая checkpoints. Несколько подходящих canonical instances не выбираются произвольно; ambiguous rows остаются отдельными Possible Duplicate. Effective date/amount/category/merchant edits не участвуют в source matching. Deletion удаляет связанный fingerprint; shared cancellation сохраняет remaining fingerprints.

В Операциях показаны собственные active candidate pairs. «Это разные операции» проходит preview/commit, переводит конкретную пару в persistent `different` и снимает duplicate review только если нет других active pairs. Повторный import тех же instances не создаёт прежний вопрос. Решение входит в checked 30-day History/Undo с object/dependency checks; physical deletion/reset удаляют связанные пары. Новая неоднозначная строка с новым source instance может дать новый вопрос — это новое основание, а не игнорирование rejection.

## Миграция и проверки

После 0013 применяется 0014: `operator migrate-import-cancellation-dedupe` с отдельными operator credentials, в транзакции. Runtime/worker не получают owner privileges. PostgreSQL fixture устанавливает весь ряд миграций; CI base allowlist включает `feature/spec-screen-audit`. Старую сборку, не знающую direct evidence, нельзя считать безопасным rollback после начала новых imports; full Staging migration/rollback/restore proof требуется отдельно.

Unit cases проверяют strict descriptor/precision/tenant alias и неоднозначность. PostgreSQL/HTTP cases проверяют irreversible unique deletion/reimport, shared latest restoration/manual verification, удаление inherited-only merchant evidence, surviving file checkpoint, unchanged HMAC key, receipt retry, private history cleanup, strict dedupe после effective edits, persistent rejection/checked Undo, ownership/access/revision и fail-closed legacy evidence. Connected synthetic browser cases desktop/mobile отдельно проверяют preview/decline/lost acknowledgement/exact retry/no Undo и сохранение обеих different operations. Они не заменяют реальные PostgreSQL и устройства.

Фактический результат полного CI окончательного коммита указывается в PR. Предыдущий green run PR №25 не является проверкой этого блока.

## Что ещё требуется

Это strict matching для конечного `bank-source/1` profile, а не полный fingerprint произвольного sanitized description. Расширенное safe description extraction, date-only dedupe corpus, fuzzy algorithms/quality proof, duplicate merge с explicit конфликтами/ID mapping/Undo из B-07, полный rule/component/link/review UX, CSV/XLSX/OCR, AI/global classification/final matching pass и реальные devices остаются впереди. Budgets/Analyzer/documents/caches ещё не реализованы: их будущие privacy cascades нельзя считать проверенными наличием этого блока. Timeweb/Production/services не подключаются этой веткой.
