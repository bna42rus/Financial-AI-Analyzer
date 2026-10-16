import { object, choice } from '../../../packages/finance-core/src/model.ts';
import { safeText } from '../../../packages/privacy/src/text.ts';
import { parseModelPlan, YandexPlanError, modelFilterProperties } from '../../../packages/analyzer/src/yandex-contract.ts';
import type { Catalog, ModelPlan } from '../../../packages/analyzer/src/yandex-contract.ts';
import type { OperationsFilter } from '../../../packages/finance-core/src/operations.ts';

export type PlanResolution = 'model_clarification' | 'reference_missing' | 'reference_ambiguous' | 'mixed_classification_scope' | 'server_reference_clarification' | 'money_literal_invalid' | null;
export type ReferencePlan = { plan: ModelPlan; resolution: PlanResolution };
const folded = (s: string) => s.normalize('NFKC').toLocaleLowerCase('ru-RU').replace(/ё/g, 'е').replace(/\s+/gu, ' ').trim();
function checked<T>(phase: YandexPlanError['phase'], action: () => T): T {
  try { return action(); } catch { throw new YandexPlanError(phase); }
}
function labels(value: unknown): string[] {
  return checked('REFERENCE', () => {
    if (!Array.isArray(value) || !value.length || value.length > 100) throw new TypeError();
    const result = value.map(v => safeText(v, 160));
    if (result.some(s => !s) || new Set(result.map(folded)).size !== result.length) throw new TypeError();
    return result;
  });
}
const clarification = (resolution: PlanResolution): ReferencePlan => ({ plan: { status: 'clarification', query: null }, resolution });
/** Experimental prompt/3: classification names are depth-neutral. Resolve only
 * unique owned exact names locally; no catalog or identifiers go to the LLM. */
export function parseReferencePlan(value: unknown, base: OperationsFilter, catalog: Catalog): ReferencePlan {
  const root = checked('ROOT', () => object(value, ['status', 'query']));
  if (root.status !== 'query') {
    const plan = parseModelPlan(value, base, catalog);
    return { plan, resolution: plan.status === 'clarification' ? 'model_clarification' : null };
  }
  const query = checked('QUERY', () => {
    const query = object(root.query, ['name', 'metric', 'grouping', 'comparison', 'filter']);
    if (Object.keys(query).length !== 5) throw new TypeError();
    choice(query.name, ['query_finances']); choice(query.metric, ['expenses', 'income', 'attention']);
    choice(query.grouping, ['none', 'category', 'operation']); choice(query.comparison, ['none', 'previous_same']);
    return query;
  });
  // The final shared parser validates the closed schema, dates and other fields.
  const filter = checked('FILTER', () => object(query.filter, Object.keys(modelFilterProperties)));
  const normalized = { ...filter };
  if ('categoryNames' in normalized) {
    const roots: Catalog['categories'] = [], leaves: Catalog['categories'] = [];
    for (const label of labels(normalized.categoryNames)) {
      const name = folded(label);
      const matches = catalog.categories.filter(row => folded(row.name) === name || row.parentId !== null &&
        catalog.categories.some(parent => parent.id === row.parentId && folded(parent.name + ' / ' + row.name) === name));
      if (matches.length !== 1) return clarification(matches.length ? 'reference_ambiguous' : 'reference_missing');
      (matches[0]!.parentId === null ? roots : leaves).push(matches[0]!);
    }
    if (roots.length && leaves.length) {
      const parents = new Set(leaves.map(row => row.parentId));
      if (parents.size !== roots.length || roots.some(row => !parents.has(row.id))) return clarification('mixed_classification_scope');
    }
    delete normalized.categoryNames;
    if (roots.length) normalized.categoryNames = roots.map(row => row.name);
    if (leaves.length) {
      const existing = 'subcategoryNames' in normalized ? labels(normalized.subcategoryNames) : [];
      const paths: string[] = [];
      for (const leaf of leaves) {
        const parent = catalog.categories.find(row => row.id === leaf.parentId);
        if (!parent) return clarification('reference_missing');
        const sameNames = catalog.categories.filter(row => row.parentId !== null && folded(row.name) === folded(leaf.name));
        paths.push(sameNames.length === 1 ? leaf.name : parent.name + ' / ' + leaf.name);
      }
      normalized.subcategoryNames = [...new Map([...existing, ...paths].map(name => [folded(name), name])).values()];
    }
  }
  const plan = parseModelPlan({ ...root, query: { ...query, filter: normalized } }, base, catalog);
  return { plan, resolution: plan.status === 'clarification' ? 'server_reference_clarification' : null };
}
