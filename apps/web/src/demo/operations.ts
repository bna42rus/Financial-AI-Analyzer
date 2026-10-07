import { createOverview, filterOperations, formatMoney } from './overview';
import type { DemoOperation, OverviewFilters } from './overview';

export type QuickFilter = 'all' | 'attention' | 'unresolved' | 'excluded';
export type OperationSort = 'date-desc' | 'date-asc' | 'amount-desc' | 'amount-asc' | 'merchant';
export interface OperationsView {
  readonly query: string;
  readonly quick: QuickFilter;
  readonly sort: OperationSort;
  readonly kind: string;
  readonly role: string;
}
export interface OperationScope { readonly label: string; readonly source?: 'Обзора'|'Анализатора'|'Настроек'; readonly ids: readonly string[] }
export const defaultOperationsView: OperationsView = { query: '', quick: 'all', sort: 'date-desc', kind: '', role: '' };
export const roleLabels: Record<DemoOperation['role'], string> = {
  expense: 'Расход', income: 'Доход', neutral: 'Нейтральная', unresolved: 'Не определён',
};
export function statusLabel(row: DemoOperation): string {
  if (row.excluded) return 'Исключено из аналитики';
  if (row.role === 'unresolved') return 'Смысл не определён';
  if (row.requiresAttention) return 'Нужно проверить';
  return 'Без замечаний';
}
const normalize = (value: string) => value.normalize('NFKC').toLocaleLowerCase('ru-RU').replaceAll('ё','е').replace(/\s+/g,' ').trim();

/** Synthetic, read-only list projection. Shares the overview's exact financial calculation. */
export function operationList(rows: readonly DemoOperation[], filters: OverviewFilters, view: OperationsView, scope: OperationScope | null = null) {
  const scopedIds = scope ? new Set(scope.ids) : null;
  const query = normalize(view.query);
  const scoped = filterOperations(rows, filters).filter(row => !scopedIds || scopedIds.has(row.id));
  const candidates = scoped.filter(row => (!view.kind || row.kind === view.kind) && (!view.role || row.role === view.role)
    && (!query || normalize([row.merchant,row.category,row.bank,row.account,row.kind,roleLabels[row.role],formatMoney(row.amountMinor),formatMoney(row.amountMinor).replace(/\s/g,'')].join(' ')).includes(query)));
  const counts = {
    all: candidates.length,
    attention: candidates.filter(row => row.requiresAttention).length,
    unresolved: candidates.filter(row => row.role === 'unresolved').length,
    excluded: candidates.filter(row => row.excluded).length,
  };
  const matching = candidates.filter(row => view.quick === 'all' || view.quick === 'attention' && row.requiresAttention
    || view.quick === 'unresolved' && row.role === 'unresolved' || view.quick === 'excluded' && row.excluded);
  const sorted = [...matching].sort((a,b) => {
    let order: number;
    if (view.sort.startsWith('amount')) {
      const aa = BigInt(a.amountMinor), bb = BigInt(b.amountMinor);
      order = aa < bb ? -1 : aa > bb ? 1 : 0;
      if (view.sort === 'amount-desc') order = -order;
    } else if (view.sort === 'merchant') order = a.merchant.localeCompare(b.merchant,'ru');
    else { order = a.date.localeCompare(b.date); if (view.sort === 'date-desc') order = -order; }
    return order || a.id.localeCompare(b.id);
  });
  return { rows: sorted, counts, totals: createOverview(matching,filters) };
}

export function selectRange(ids: readonly string[], anchor: string | null, target: string, selected: readonly string[]): string[] {
  const end = ids.indexOf(target), start = anchor ? ids.indexOf(anchor) : end;
  if (end < 0) return [...selected];
  const range = ids.slice(Math.min(start < 0 ? end : start,end),Math.max(start < 0 ? end : start,end)+1);
  return [...new Set([...selected,...range])];
}
