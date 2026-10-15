# Продолжение работы над GPT-OSS после аудита 52/92

ОБНОВЛЕНИЕ: после следующего указания владельца «делай по новому плану»
реализован отдельный single-extraction + server-compiler путь. Текущее
описание: [analyzer-intent-20261015.md](analyzer-intent-20261015.md).
Ниже сохранена предшествующая точка аудита и VPS baseline. Фразы «ещё не
реализован» ниже относятся к историческому состоянию до этого обновления.
Новый executable source: `50cd3caf392ce29bbc746dfe6b98fdc5ca7780e4`.
CI 38782020448: 714/714 software tests, включая single-intent PostgreSQL
и desktop/mobile browser. Операторская команда — run-intent-trial-20261015.sh.
Новый checkout /home/finance-admin/cashneuro-intent-trial-50cd3caf; новые
root artifacts task-intent-trial-v1.json, task-intent-trial-v1-cache,
task-intent-trial-v1.lock. Binding:
0167d21fd279fa1df5cac60df29fa86f6966a164f270dff5e636cf6cb0e1e4fa.
Языковой результат нового пути пока НЕ измерен; старый 52/92 неизменен.

Последнее указание владельца 15.10.2026 20:27 Moscow: работа идёт слишком
медленно, нужна другая схема; владелец хотел последний прогон и перенос чата.
Последний НОВЫЙ платный прогон после аудита не выполнялся, команды для него
пока нет. Не выдавать software CI за успешную языковую проверку модели.

## Репозиторий и проверенный source

- Repo: https://github.com/bna42rus/Financial-AI-Analyzer
- Branch: feature/analyzer-model-bench; stacked draft PR #44, base #43.
- Последний executable source: `5a46d450c10080ac233a8bee8301e66e391671a0`.
- CI https://github.com/bna42rus/Financial-AI-Analyzer/actions/runs/38776922177
  attempt 1: 697/697 — 204 API, 246 core, 82 web, 161 PostgreSQL 18.4,
  4 Chromium desktop/mobile. Types/builds/privacy/source checks проходят.
- Следующий commit меняет только документацию/evidence, executable прежний.
- Runtime AI не включён. Deployment, migrations, merge и обучение не делались.

## Что реально произошло

Cloud GPT-OSS: `openai/gpt-oss-120b`. Первые два proposal запроса с
json_schema дали HTTP 400 без usage. JSON-object mode на source `8105e713`
устранил transport blocker: все 170 новых вызовов получили usage.

Реальная проверка: **52/92** — 36/68 development + 16/24 independent repeats.
28 holdout не открывались. Strict scoring/goldens/неверные parent states
не менялись. Нельзя обещать 120/120 или произвольные похожие вопросы по CI.

Полный read-only audit всех 170 cache values сверил каждый исходный wire SHA
и точно воспроизвёл 52/92. Шесть repeated groups при одинаковом wire имеют
разные semantic outcomes. 40 failures: 26 без earlierFailure и 14 с ним;
последний флаг не доказывает отсутствие собственной ошибки у потомка.

Главные механизмы: ненужное уточнение server-owned выбранного периода;
new вместо continuation; потеря порогов/категорий/формата; merchant вместо
категории; неподдержанная группировка подменяется итогом. money-2 после
«А по категориям?» сбрасывает порог и меняет результат с 1000 на 21 000 ₽:
сервер правильно считает НЕВЕРНО выбранный scope, модель не считает суммы.
Проверены также успешные ответы: часть лишних scalar sets пока совпадает с
defaults, что не доказывает правильное поведение в следующем ходе.

14 отвергнутых JSON values старый runner заменил null. Они утрачены: нельзя
восстановить или выдумать их точные schema/quote errors. Новый private sink
сохраняет future rejected protocol values encrypted после fsync usage/cache;
в отчёте только fixed code. Sink failure/replay не повторяют платный запрос.
Это не захват reasoning или всей HTTP-переписки.

## Где подробности

- docs/architecture/analyzer-task-json-review-20261015.md — полный human audit.
- docs/evidence/analyzer-task-json-cache-review-20261015.json — все 92 строки,
  решения, expected/actual, repeats, scope risks, CI и независимая schema проверка.
- apps/api/test/fixtures/task-json-observed-20261015.json — 170 реальных
  сохранённых ответов модели на SYNTHETIC corpus, без клиентских данных/ключей.
- apps/api/src/task-json-cache-audit.ts и task-json-cache-audit-main.ts —
  воспроизводимый offline audit; не принимают fetch/ledger/provider key.
- docs/evidence/analyzer-task-json-trial-result-20261015.json — операторский run.
- apps/api/src/task-prepared-contract.ts — отдельный подготовленный candidate:
  paidDispatchEnabled=false, к paid runner/runtime НЕ подключён, языковая
  точность НЕ измерена. Более ясные инструкции и lossless schema factoring
  не являются доказательством устранения ошибок модели.
- docs/architecture/analyzer-task-contract.md и analyzer-task-trial.md —
  принятые semantic/privacy правила, история frozen experiments.

## Следующая работа: другая схема, а не ещё одна точечная правка

Владелец просит сменить подход. Разработать более компактную границу:
модель извлекает намерение/явные изменения, программа контролирует task
binding, сохранение/снятие условий и расчёт. Это направление изменения,
НЕ уже реализованный новый pipeline. Текущий task pipeline всё ещё отдаёт
модели new/nearest/unique/ordinal/reference. Нельзя написать, что проблема
уже устранена, пока новый путь не реализован и не измерен.

Сохранять PDF 26.1–26.8, глобальные defaults/ручные touches, приоритет явных
условий, независимые condition groups, fixed-operation boundary, доступ и
ownership. Нельзя незаметно заменять неверный model gate regex-ответом,
подставлять golden parents или смягчать оценку ради 100%. Каталоги/rows/UUID/
старые totals не отправляются модели. Дообучение не установлено как причина
или необходимый следующий шаг: сначала исправить и измерить контракт.

После реализации заморозить один целостный candidate и проверять полный
development/repeat/holdout набор без промежуточных prompt edits. Software
checks и реальная языковая точность — разные результаты. Бюджет и admission
должны быть решены явно; текущий кандидат не разрешает новый платный run.
Финальная продуктовая приёмка 420 turns и 96 исторических regressions под
новым протоколом ещё не выполнены.

## Деньги и сохранённое состояние VPS

Ledger: 665 calls, reported 660, failed 32; spent 22627111860 atoms
(22,627111860 ₽), held 11820804480 (11,820804480 ₽), upper 34447916340.
Original incremental baseline upper 20888941260, cap 20000000000;
used incremental upper 13558975080; осталось **6,441024920 ₽**.
Global smoke cap **45 ₽**, project cap 1000 ₽. Лимиты не увеличены и holds
не сняты. Предыдущий development/repeat run стоил **9,237879040 ₽** —
нельзя обещать, что полный повтор уложится в текущий остаток. Bytes меньше
не доказывают экономию tokens/рублей. Владельцу скорость важнее пары рублей,
но не следует скрыто сбрасывать бюджет/журнал или освобождать unknown holds.

Последний ledger head:
`5d5271f31c34cf41ac47712fff2718f666c85744b9df11618010968c7d4d05fb`.
JSON-v1 frozen SHA:
`e3a80d6cc2696b376e043fee6ccf318481796be0c2ee0246168453165e945379`.
Binding:
`852762c202aa874604736a9406ccf134e8de90fe7485aadc15972eb5e77a362b`.
Cache export SHA:
`17ba8bd3edb17fd11b558573ba121c1b5e56630c3d4b97c1de197a0a173e398b`.

VPS user finance-admin, host prompt 9303585-oe067663. Assistant SSH-доступа
не имеет; владелец вставляет ОДИН нормальный Bash block в существующую SSH
консоль (не tmux). Не повторять инструкцию ставить Node на Windows.

- Source repo: /home/finance-admin/cashneuro-staging-src
- Архивный bench: /home/finance-admin/cashneuro-model-bench-d7bc07dc
- JSON run checkout: /home/finance-admin/cashneuro-json-trial-8105e713
- Root state: /var/lib/cashneuro/analyzer-benchmark (0700)
- Ledger: smoke-ledger.jsonl (0600)
- JSON-v1: task-json-trial-v1.json, task-json-trial-v1-cache, task-json-trial-v1.lock
- Root provider key file: /etc/cashneuro/ai/benchmark/provider-keys.json (0600).
  Секрет не печатать/не запрашивать в чат/не копировать в Git.

Архивные checkouts/artifacts/locks/receipts не перезаписывать и не удалять.
JSON-v1 repeats на source 8105e713 — бесплатный report, НЕ новое испытание.
Новая программа требует отдельного checkout/artifact и корректной новой
identity; текущие v1 baseline guards намеренно не допускают fresh POST при
665 calls. Тарифный fresh-dispatch guard привязан к 15.10.2026 Moscow;
после этой даты заново сверить тариф/metadata перед новым платным run.
