import type { OperationsFilter } from '../../../packages/finance-core/src/operations.ts';
import type { Query } from '../../../packages/analyzer/src/registry.ts';
import type { Catalog, ModelPlan } from '../../../packages/analyzer/src/yandex-contract.ts';

export const fixtureVersion = 'cashneuro-smoke/1';
const food = '11111111-1111-4111-8111-111111111111', travel = '22222222-2222-4222-8222-222222222222';
const taxi = '33333333-3333-4333-8333-333333333333';
export const syntheticCatalog: Catalog = { accounts: [], counterparties: [], categories: [
  { id: food, name: 'Продукты', parentId: null, role: 'expense' },
  { id: travel, name: 'Поездки', parentId: null, role: 'expense' },
  { id: taxi, name: 'Такси', parentId: travel, role: 'expense' },
] };
export const october = { from: '2026-10-01', through: '2026-10-31' };
const september = { from: '2026-09-01', through: '2026-09-30' };
const plan = (filter: OperationsFilter, metric: Query['metric'] = 'expenses', grouping: Query['grouping'] = 'none', comparison: Query['comparison'] = 'none'): ModelPlan =>
  ({ status: 'query', query: { name: 'query_finances', metric, grouping, comparison, filter } });
type Gate = { relevance: 'financial' | 'unrelated' | 'ambiguous'; followUp: boolean };
export type SmokeTurn = { id: string; question: string; global: OperationsFilter; expectedGate: Gate; expectedPlan?: ModelPlan };
export type SmokeScenario = { id: string; turns: SmokeTurn[] };
const turn = (id: string, question: string, expectedPlan: ModelPlan, global: OperationsFilter = october, followUp = false): SmokeTurn =>
  ({ id, question, global, expectedGate: { relevance: 'financial', followUp }, expectedPlan });
// Human-written goldens. They do not come from interpret(), parseModelPlan(),
// candidate output, or a template generating both questions and their answers.
export const smokeScenarios: SmokeScenario[] = [
  { id: 'total', turns: [turn('total', 'Сколько потрачено за выбранный период?', plan(october))] },
  { id: 'income', turns: [turn('income', 'Покажи мои доходы.', plan(october, 'income'))] },
  { id: 'groups', turns: [turn('groups', 'Разложи расходы по категориям.', plan(october, 'expenses', 'category'))] },
  { id: 'attention', turns: [turn('attention', 'Какие операции требуют внимания?', plan(october, 'attention', 'operation'))] },
  { id: 'compare', turns: [turn('compare', 'Сравни расходы с предыдущим таким же периодом.', plan(october, 'expenses', 'none', 'previous_same'))] },
  { id: 'date', turns: [turn('date', 'Сколько потратил в сентябре 2026 года?', plan(september))] },
  { id: 'category', turns: [turn('category', 'Сколько потратил на продукты?', plan({ ...october, categoryIds: [food] }))] },
  { id: 'selected', turns: [turn('selected', 'Сколько потратил?', plan({ ...october, categoryIds: [travel] }), { ...october, categoryIds: [travel] })] },
  { id: 'leaf', turns: [turn('leaf', 'Покажи расходы на такси.', plan({ ...october, categoryIds: [travel], subcategoryIds: [taxi] }))] },
  { id: 'write', turns: [turn('write', 'Удали все мои операции.', { status: 'unsupported', query: null })] },
  { id: 'unrelated', turns: [{ id: 'unrelated', question: 'Какая погода в Москве?', global: october, expectedGate: { relevance: 'unrelated', followUp: false } }] },
  { id: 'ambiguous', turns: [{ id: 'ambiguous', question: 'А это?', global: october, expectedGate: { relevance: 'ambiguous', followUp: false } }] },
  { id: 'dialog-scope', turns: [
    turn('scope-1', 'Сколько потратил на продукты в сентябре 2026 года?', plan({ ...september, categoryIds: [food] })),
    turn('scope-2', 'А по категориям?', plan({ ...september, categoryIds: [food] }, 'expenses', 'category'), october, true),
    turn('scope-3', 'А теперь на такси?', plan({ ...september, categoryIds: [travel], subcategoryIds: [taxi] }, 'expenses', 'category'), october, true),
    turn('scope-4', 'А за октябрь 2026 года?', plan({ ...october, categoryIds: [travel], subcategoryIds: [taxi] }, 'expenses', 'category'), september, true),
    turn('scope-5', 'Сколько заработал в октябре 2026 года?', plan(october, 'income'), october),
    turn('scope-6', 'А по категориям?', plan(october, 'income', 'category'), october, true),
  ] },
  { id: 'dialog-global', turns: [
    turn('global-1', 'Разложи расходы по категориям.', plan({ ...october, categoryIds: [food] }, 'expenses', 'category'), { ...october, categoryIds: [food] }),
    turn('global-2', 'А сравни с предыдущим таким же периодом.', plan({ ...september, categoryIds: [food] }, 'expenses', 'category', 'previous_same'), { ...september, categoryIds: [food] }, true),
    turn('global-3', 'А без сравнения?', plan({ ...september, categoryIds: [food] }, 'expenses', 'category'), { ...september, categoryIds: [food] }, true),
    turn('global-4', 'А теперь покажи отдельные операции.', plan({ ...september, categoryIds: [travel] }, 'expenses', 'operation'), { ...september, categoryIds: [travel] }, true),
    turn('global-5', 'А теперь итог одной суммой?', plan(september), september, true),
    turn('global-6', 'Покажи мои доходы.', plan(september, 'income'), september),
  ] },
];
