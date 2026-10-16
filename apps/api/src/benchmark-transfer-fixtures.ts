import type { OperationsFilter } from '../../../packages/finance-core/src/operations.ts';
import type { Query } from '../../../packages/analyzer/src/registry.ts';
import type { ModelPlan } from '../../../packages/analyzer/src/yandex-contract.ts';
import type { SmokeScenario, SmokeTurn } from './benchmark-fixtures.ts';
import { october } from './benchmark-fixtures.ts';

// Freeze before the first provider trial. These questions are deliberately
// absent from prompts and the original smoke. No model generates the goldens.
export const transferFixtureVersion = 'cashneuro-transfer/1';
const food = '11111111-1111-4111-8111-111111111111', travel = '22222222-2222-4222-8222-222222222222';
const taxi = '33333333-3333-4333-8333-333333333333';
const august = { from: '2026-08-01', through: '2026-08-31' }, july = { from: '2026-07-01', through: '2026-07-31' };
const september = { from: '2026-09-01', through: '2026-09-30' }, may = { from: '2026-05-01', through: '2026-05-31' };
const leap = { from: '2024-02-01', through: '2024-02-29' }, march = { from: '2024-03-01', through: '2024-03-31' };
const plan = (filter: OperationsFilter = october, metric: Query['metric'] = 'expenses', grouping: Query['grouping'] = 'none', comparison: Query['comparison'] = 'none'): ModelPlan =>
  ({ status: 'query', query: { name: 'query_finances', metric, grouping, comparison, filter } });
const turn = (id: string, question: string, expectedPlan: ModelPlan, global: OperationsFilter = october, followUp = false): SmokeTurn =>
  ({ id, question, global, expectedGate: { relevance: 'financial', followUp }, expectedPlan });
const empty = (id: string, question: string, relevance: 'ambiguous' | 'unrelated'): SmokeTurn =>
  ({ id, question, global: october, expectedGate: { relevance, followUp: false } });
const clarification: ModelPlan = { status: 'clarification', query: null }, unsupported: ModelPlan = { status: 'unsupported', query: null };
const singles: SmokeTurn[] = [
  turn('transfer-01', 'Назови общую сумму моих трат в текущих фильтрах.', plan()),
  turn('transfer-02', 'Какова суммарная величина доходов за выбранные даты?', plan(october, 'income')),
  turn('transfer-03', 'Нужна разбивка трат по финансовым категориям.', plan(october, 'expenses', 'category')),
  turn('transfer-04', 'Выведи список отдельных расходных операций.', plan(october, 'expenses', 'operation')),
  turn('transfer-05', 'Выведи операции, которые надо проверить.', plan(october, 'attention', 'operation')),
  turn('transfer-06', 'Сопоставь сумму трат с предыдущим периодом такой же длины.', plan(october, 'expenses', 'none', 'previous_same')),
  turn('transfer-07', 'Общая сумма расходов за август 2026.', plan(august)),
  turn('transfer-08', 'Суммарный доход за июль 2026 года.', plan(july, 'income')),
  turn('transfer-09', 'Итог расходов за февраль 2024 года.', plan(leap)),
  turn('transfer-10', 'Расходы одной суммой за февраль 2025 года.', plan({ from: '2025-02-01', through: '2025-02-28' })),
  turn('transfer-11', 'Сумма расходов за вчера.', plan({ from: '2026-10-13', through: '2026-10-13' })),
  turn('transfer-12', 'Общая сумма трат за прошлый месяц.', plan(september)),
  turn('transfer-13', 'Итог расходов с 5 по 12 августа 2026 года включительно.', plan({ from: '2026-08-05', through: '2026-08-12' })),
  turn('transfer-14', 'Сумма расходов по категории «Продукты».', plan({ ...october, categoryIds: [food] })),
  turn('transfer-15', 'Какова сумма трат на ТАКСИ?', plan({ ...october, categoryIds: [travel], subcategoryIds: [taxi] })),
  turn('transfer-16', 'Итог трат по категории «Поездки».', plan({ ...october, categoryIds: [travel] })),
  turn('transfer-17', 'Сумма расходов по «Поездки / Такси» за август 2026.', plan({ ...august, categoryIds: [travel], subcategoryIds: [taxi] })),
  turn('transfer-18', 'Расходы на продукты за июль 2026 по категориям.', plan({ ...july, categoryIds: [food] }, 'expenses', 'category')),
  turn('transfer-19', 'Список расходов на такси в феврале 2024.', plan({ ...leap, categoryIds: [travel], subcategoryIds: [taxi] }, 'expenses', 'operation')),
  turn('transfer-20', 'Сумма расходов по категории «Звездолёты».', clarification),
  turn('transfer-21', 'Общий доход по счёту «Неизвестный счёт».', clarification),
  turn('transfer-22', 'Сумма доходов от контрагента «Неизвестный контрагент».', clarification),
  turn('transfer-23', 'Общий доход по операциям с суммой от 1000 рублей включительно.', plan({ ...october, amountFrom: '100000' }, 'income')),
  turn('transfer-24', 'Общий доход по операциям с суммой от 1000 до 2500 рублей включительно.', plan({ ...october, amountFrom: '100000', amountThrough: '250000' }, 'income')),
  turn('transfer-25', 'Сумма доходов по операциям не выше 99 рублей 50 копеек.', plan({ ...october, amountThrough: '9950' }, 'income')),
  turn('transfer-26', 'Сумма расходов только по операциям без категории.', plan({ ...october, uncategorized: true })),
  turn('transfer-27', 'Список расходных операций без подкатегории.', plan({ ...october, noSubcategory: true }, 'expenses', 'operation')),
  turn('transfer-28', 'Список расходных операций без контрагента.', plan({ ...october, noCounterparty: true }, 'expenses', 'operation')),
  turn('transfer-29', 'Список расходных операций с признаком возможного дубля.', plan({ ...october, possibleDuplicate: true }, 'expenses', 'operation')),
  turn('transfer-30', 'Общая сумма расходов только по включённым операциям.', plan({ ...october, inclusion: 'included' })),
  turn('transfer-31', 'Общая сумма расходов в текущем выделении.', plan({ ...october, categoryIds: [travel], subcategoryIds: [taxi] }), { ...october, categoryIds: [travel], subcategoryIds: [taxi] }),
  turn('transfer-32', 'Общая сумма доходов за даты, выбранные в интерфейсе.', plan(august, 'income'), august),
  turn('transfer-33', 'Перенеси все расходы в другую категорию.', unsupported),
  turn('transfer-34', 'Предскажи мои расходы на следующий год.', unsupported),
  empty('transfer-35', 'Продолжи.', 'ambiguous'),
  empty('transfer-36', 'Расскажи, как устроен телескоп.', 'unrelated'),
];
export const transferScenarios: SmokeScenario[] = [
  ...singles.map(t => ({ id: t.id, turns: [t] })),
  { id: 'transfer-income', turns: [
    turn('ti-1', 'Итог доходов за август 2026 года.', plan(august, 'income')),
    turn('ti-2', 'Теперь разбивку по категориям.', plan(august, 'income', 'category'), october, true),
    turn('ti-3', 'За июль 2026 вместо августа.', plan(july, 'income', 'category'), october, true),
    turn('ti-4', 'Добавь сравнение с предыдущим таким же периодом.', plan(july, 'income', 'category', 'previous_same'), october, true),
    turn('ti-5', 'Убери сравнение.', plan(july, 'income', 'category'), october, true),
    turn('ti-6', 'Сведи это в одну сумму.', plan(july, 'income'), october, true),
  ] },
  { id: 'transfer-leaf', turns: [
    turn('tl-1', 'Итог расходов на такси за февраль 2024 года.', plan({ ...leap, categoryIds: [travel], subcategoryIds: [taxi] })),
    turn('tl-2', 'Разбей по категориям.', plan({ ...leap, categoryIds: [travel], subcategoryIds: [taxi] }, 'expenses', 'category'), october, true),
    turn('tl-3', 'Теперь за март 2024.', plan({ ...march, categoryIds: [travel], subcategoryIds: [taxi] }, 'expenses', 'category'), october, true),
    turn('tl-4', 'Замени такси на продукты.', plan({ ...march, categoryIds: [food] }, 'expenses', 'category'), october, true),
    turn('tl-5', 'Выведи каждую операцию отдельно.', plan({ ...march, categoryIds: [food] }, 'expenses', 'operation'), october, true),
    turn('tl-6', 'Снова одной суммой.', plan({ ...march, categoryIds: [food] }), october, true),
  ] },
  { id: 'transfer-globals', turns: [
    turn('tg-1', 'Общая сумма расходов за май 2026.', plan({ ...may, categoryIds: [food] }), { ...october, categoryIds: [food] }),
    turn('tg-2', 'Нужна разбивка по категориям.', plan({ ...may, categoryIds: [food] }, 'expenses', 'category'), { ...october, categoryIds: [food] }, true),
    turn('tg-3', 'Повтори в текущем выбранном периоде.', plan({ ...august, categoryIds: [food] }, 'expenses', 'category'), { ...august, categoryIds: [food] }, true),
    turn('tg-4', 'Повтори с текущим фильтром категорий.', plan({ ...august, categoryIds: [travel] }, 'expenses', 'category'), { ...august, categoryIds: [travel] }, true),
    turn('tg-5', 'Повтори с обновлёнными фильтрами.', plan(august, 'expenses', 'category'), august, true),
    turn('tg-6', 'Теперь на продукты в сентябре 2026.', plan({ ...september, categoryIds: [food] }, 'expenses', 'category'), august, true),
  ] },
  { id: 'transfer-interruption', turns: [
    turn('tx-1', 'Общая сумма расходов на продукты за август 2026.', plan({ ...august, categoryIds: [food] })),
    turn('tx-2', 'Теперь по неизвестной категории «Орбитальные станции».', clarification, october, true),
    turn('tx-3', 'Тогда разбей прежний результат по категориям.', plan({ ...august, categoryIds: [food] }, 'expenses', 'category'), october, true),
    empty('tx-4', 'Объясни принцип работы микроскопа.', 'unrelated'),
    turn('tx-5', 'Вернёмся к расходам: покажи отдельные операции по прежнему результату.', plan({ ...august, categoryIds: [food] }, 'expenses', 'operation'), october, true),
    turn('tx-6', 'Какова общая сумма моих доходов за июль 2026?', plan(july, 'income')),
  ] },
  { id: 'transfer-comparison', turns: [
    turn('tc-1', 'Расходы на поездки за август 2026 с разбивкой по категориям.', plan({ ...august, categoryIds: [travel] }, 'expenses', 'category')),
    turn('tc-2', 'Сравни с предыдущим периодом той же длины.', plan({ ...august, categoryIds: [travel] }, 'expenses', 'category', 'previous_same'), october, true),
    turn('tc-3', 'Вместо поездок только такси.', plan({ ...august, categoryIds: [travel], subcategoryIds: [taxi] }, 'expenses', 'category', 'previous_same'), october, true),
    turn('tc-4', 'Сделай итог одной суммой.', plan({ ...august, categoryIds: [travel], subcategoryIds: [taxi] }, 'expenses', 'none', 'previous_same'), october, true),
    turn('tc-5', 'Оставь только выбранный период, без сравнения.', plan({ ...august, categoryIds: [travel], subcategoryIds: [taxi] }), october, true),
    turn('tc-6', 'Теперь за июль 2026.', plan({ ...july, categoryIds: [travel], subcategoryIds: [taxi] }), october, true),
  ] },
  { id: 'transfer-scope-removal', turns: [
    turn('tr-1', 'Общий итог расходов за июль 2026.', plan({ ...july, categoryIds: [travel], subcategoryIds: [taxi] }), { ...october, categoryIds: [travel], subcategoryIds: [taxi] }),
    turn('tr-2', 'Разложи этот результат по категориям.', plan({ ...july, categoryIds: [travel], subcategoryIds: [taxi] }, 'expenses', 'category'), { ...october, categoryIds: [travel], subcategoryIds: [taxi] }, true),
    turn('tr-3', 'Повтори с новым выбором в интерфейсе.', plan({ ...july, categoryIds: [food] }, 'expenses', 'category'), { ...october, categoryIds: [food] }, true),
    turn('tr-4', 'Ещё раз с текущими фильтрами.', plan(july, 'expenses', 'category'), october, true),
    turn('tr-5', 'Теперь отдельными операциями.', plan(july, 'expenses', 'operation'), october, true),
    turn('tr-6', 'Итог одной суммой за август 2026.', plan(august), october, true),
  ] },
];
