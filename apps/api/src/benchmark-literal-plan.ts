import { object } from '../../../packages/finance-core/src/model.ts';
import type { OperationsFilter } from '../../../packages/finance-core/src/operations.ts';
import type { Query } from '../../../packages/analyzer/src/registry.ts';
import { YandexPlanError } from '../../../packages/analyzer/src/yandex-contract.ts';
import type { Catalog } from '../../../packages/analyzer/src/yandex-contract.ts';
import { revisedGatePrompt } from './benchmark-prompts.ts';
import { explicitPlanSchema, explicitPlanPrompt, parseExplicitPlan } from './benchmark-explicit-plan.ts';
import { parseQuotedMoney } from './benchmark-money.ts';

export const literalPromptVersion = 'cashneuro-smoke-prompt/6';
export const literalGatePrompt = revisedGatePrompt + '\nКороткая команда без объекта, понятной ссылки или предыдущей финансовой задачи — ambiguous. Отсутствие контекста не означает постороннюю тему. unrelated выбирай только для ясно постороннего запроса; финансовые данные при ambiguous/unrelated недоступны.';
const fields = [...explicitPlanSchema.required, 'amountFromText', 'amountThroughText'];
const filterProperties = Object.fromEntries(Object.entries(explicitPlanSchema.properties.filter.properties).filter(([key]) => !['amountFrom', 'amountThrough'].includes(key)));
export const literalPlanSchema = { ...explicitPlanSchema, required: fields, properties: {
  ...explicitPlanSchema.properties,
  filter: { ...explicitPlanSchema.properties.filter, properties: filterProperties },
  amountFromText: { type: 'string', minLength: 1, maxLength: 160 },
  amountThroughText: { type: 'string', minLength: 1, maxLength: 160 },
} };
const instructions = explicitPlanPrompt.slice(0, explicitPlanPrompt.indexOf('\nJSON Schema: '))
  .replace('Суммы условий — целые строки копеек.', 'Денежные границы задаются отдельно дословным текстом; перевод в копейки выполняет сервер.')
  .replaceAll('"filter":{}}', '"filter":{},"amountFromText":"inherit","amountThroughText":"inherit"}');
export const literalPlanPrompt = instructions + '\nУточнения контракта: общая сумма/суммарный итог -> grouping:none; сумма ПО КАЖДОЙ категории -> category; сумма ПО КАЖДОЙ отдельной операции/явный список -> operation. Слово «операции» внутри условия отбора само по себе не означает список.\nНе преобразуй деньги в копейки. amountFromText и amountThroughText обязательны: inherit при отсутствии новой соответствующей границы, иначе ДОСЛОВНАЯ числовая сумма из question вместе с единицей и копейками, если они указаны. Например граница «7 рублей 8 копеек» -> текст "7 рублей 8 копеек", а не 708. В диапазоне «от 40 до 90 рублей» цитаты "40" и "90 рублей": не добавляй отсутствующую рядом с первым числом единицу. Сервер проверит цитату и преобразует сумму целочисленно. filter больше не принимает amountFrom/amountThrough. Для clarification/unsupported обе денежные границы inherit. Для metric:attention не дублируй attention:true в filter: метрика уже задаёт этот признак.\nJSON Schema: ' + JSON.stringify(literalPlanSchema);
export function parseLiteralPlan(value: unknown, question: string, base: OperationsFilter, catalog: Catalog, previous?: Pick<Query, 'metric' | 'grouping' | 'comparison'> | null) {
  let root: Record<string, unknown>, filter: Record<string, unknown>;
  try {
    root = object(value, fields);
    if (Object.keys(root).length !== fields.length) throw new TypeError();
    filter = object(root.filter, Object.keys(filterProperties));
    for (const key of ['amountFromText', 'amountThroughText']) if (typeof root[key] !== 'string' || !(root[key] as string).length || (root[key] as string).length > 160) throw new TypeError();
  } catch { throw new YandexPlanError('ROOT'); }
  const { amountFromText, amountThroughText, ...core } = root;
  // Validate all mandatory fields first, without persisting arbitrary literals.
  const preliminary = parseExplicitPlan({ ...core, filter }, base, catalog, previous);
  const money = { fromMinor: null as string | null, throughMinor: null as string | null };
  if (root.status !== 'query') {
    if (amountFromText !== 'inherit' || amountThroughText !== 'inherit') throw new YandexPlanError('QUERY');
    return { ...preliminary, money, normalizations: [] as string[] };
  }
  try {
    if (amountFromText !== 'inherit') money.fromMinor = parseQuotedMoney(amountFromText, question);
    if (amountThroughText !== 'inherit') money.throughMinor = parseQuotedMoney(amountThroughText, question);
  } catch {
    return { plan: { status: 'clarification' as const, query: null }, resolution: 'money_literal_invalid' as const,
      decisions: preliminary.decisions, money: { fromMinor: null, throughMinor: null }, normalizations: [] as string[] };
  }
  const converted: Record<string, unknown> = { ...filter, ...(money.fromMinor === null ? {} : { amountFrom: money.fromMinor }), ...(money.throughMinor === null ? {} : { amountThrough: money.throughMinor }) };
  const normalizations: string[] = [];
  // Canonicalize only the model's redundant addition. Never drop a manual
  // filter or silently override attention:false from the existing scope.
  if (preliminary.plan.query?.metric === 'attention' && converted.attention === true && base.attention !== false) {
    delete converted.attention; normalizations.push('redundant_attention_filter');
  }
  const result = parseExplicitPlan({ ...core, filter: converted }, base, catalog, previous);
  return { ...result, decisions: preliminary.decisions, money, normalizations };
}
