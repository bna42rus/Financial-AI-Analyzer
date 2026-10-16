import { parseOperationsFilter } from '../../finance-core/src/operations.ts';
import type { OperationsFilter } from '../../finance-core/src/operations.ts';

export const contextVersion = 'analyzer-context/2';
export type FilterSource = 'global' | 'task' | 'message';
export type ResolvedScope = { filter: OperationsFilter; sources: Partial<Record<keyof OperationsFilter, FilterSource>> };
const canonical = (value: unknown): string => Array.isArray(value) ? JSON.stringify([...value].sort()) : JSON.stringify(value) ?? 'undefined';
const coupled: (keyof OperationsFilter)[][] = [['from', 'through'], ['categoryIds', 'subcategoryIds'], ['postedFrom', 'postedThrough']];

/** Current globals form a new task. A continuation keeps explicit task scope,
 * but manual global changes replace the corresponding condition, including
 * removal. Explicit message values are applied last. No authority is granted. */
export function resolveScope(current: OperationsFilter, task?: OperationsFilter, previousGlobal?: OperationsFilter, delta: OperationsFilter = {}): ResolvedScope {
  const global = parseOperationsFilter(current), explicit = parseOperationsFilter(delta);
  const base = task ? parseOperationsFilter(task) : global;
  const result: Record<string, unknown> = structuredClone(base);
  const sources: ResolvedScope['sources'] = {};
  for (const key of Object.keys(base) as (keyof OperationsFilter)[]) sources[key] = task && canonical(base[key]) !== canonical(previousGlobal?.[key]) ? 'task' : 'global';
  if (task && previousGlobal) {
    const previous = parseOperationsFilter(previousGlobal);
    const keys = new Set([...Object.keys(previous), ...Object.keys(global)] as (keyof OperationsFilter)[]);
    const changed = new Set([...keys].filter(key => canonical(previous[key]) !== canonical(global[key])));
    for (const group of coupled) if (group.some(key => changed.has(key))) for (const key of group) changed.add(key);
    for (const key of changed) {
      delete result[key]; delete sources[key];
      if (global[key] !== undefined) { result[key] = structuredClone(global[key]); sources[key] = 'global'; }
    }
  }
  // An explicit parent-category selection replaces the classification scope,
  // even when its parent IDs happen to equal those of the previous leaf.
  // Without this, asking for the whole parent silently keeps the old leaf.
  if (explicit.categoryIds && !explicit.subcategoryIds) { delete result.subcategoryIds; delete sources.subcategoryIds; }
  for (const key of Object.keys(explicit) as (keyof OperationsFilter)[]) { result[key] = structuredClone(explicit[key]); sources[key] = 'message'; }
  return { filter: parseOperationsFilter(result), sources };
}
