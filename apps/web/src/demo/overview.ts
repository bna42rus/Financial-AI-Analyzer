import { parsePersistedMinor, serializeMinor, sumMinor } from '../../../../packages/finance-core/src/money.ts';

/** UI-only synthetic read model. This is not an import/classification engine or a production API. */
export interface DemoOperation {
  readonly id: string;
  readonly date: string;
  readonly merchant: string;
  readonly amountMinor: string;
  readonly category: string;
  readonly bank: string;
  readonly account: string;
  readonly kind: string;
  readonly role: 'expense' | 'income' | 'neutral' | 'unresolved';
  readonly excluded: boolean;
  readonly requiresAttention: boolean;
}

export interface OverviewFilters {
  readonly start: string;
  readonly end: string;
  readonly bank: string;
  readonly account: string;
  readonly categories: readonly string[];
}

export const emptyFilters: OverviewFilters = {
  start: '2026-09-01', end: '2026-09-30', bank: '', account: '', categories: [],
};

export function filterOperations(rows: readonly DemoOperation[], filters: OverviewFilters): DemoOperation[] {
  if (filters.start > filters.end) return [];
  return rows.filter(row => row.date >= filters.start && row.date <= filters.end
    && (!filters.bank || row.bank === filters.bank)
    && (!filters.account || row.account === filters.account)
    && (!filters.categories.length || filters.categories.includes(row.category)));
}

export function createOverview(rows: readonly DemoOperation[], filters: OverviewFilters) {
  const matching = filterOperations(rows, filters);
  const included = matching.filter(row => !row.excluded);
  const expenseRows = included.filter(row => row.role === 'expense');
  const incomeRows = included.filter(row => row.role === 'income');
  const amount = (row: DemoOperation) => parsePersistedMinor(row.amountMinor);
  const expense = -sumMinor(expenseRows.map(amount));
  const income = sumMinor(incomeRows.map(amount));
  const gross = -sumMinor(expenseRows.filter(row => amount(row) < 0n).map(amount));
  const offsets = sumMinor(expenseRows.filter(row => amount(row) > 0n).map(amount));
  const categories = new Map<string, bigint>();
  for (const row of expenseRows) categories.set(row.category, (categories.get(row.category) ?? 0n) - amount(row));
  return {
    matching,
    expenseMinor: serializeMinor(expense),
    incomeMinor: serializeMinor(income),
    differenceMinor: serializeMinor(income - expense),
    grossMinor: serializeMinor(gross),
    offsetsMinor: serializeMinor(offsets),
    attention: matching.filter(row => row.requiresAttention).length,
    excludedCount: matching.filter(row => row.excluded).length,
    neutralCount: matching.filter(row => row.role === 'neutral' && !row.excluded).length,
    unresolvedCount: matching.filter(row => row.role === 'unresolved' && !row.excluded).length,
    categories: Array.from(categories, ([name, value]) => ({ name, amountMinor: serializeMinor(value) }))
      .sort((a, b) => BigInt(a.amountMinor) > BigInt(b.amountMinor) ? -1 : BigInt(a.amountMinor) < BigInt(b.amountMinor) ? 1 : a.name.localeCompare(b.name, 'ru')),
    largest: expenseRows.filter(row => amount(row) < 0n)
      .sort((a, b) => amount(a) < amount(b) ? -1 : amount(a) > amount(b) ? 1 : a.id.localeCompare(b.id)).slice(0, 3),
  };
}

export function formatMoney(minor: string): string {
  if (!/^(0|[1-9]\d*|-[1-9]\d*)$/.test(minor)) throw new TypeError('Invalid money string');
  const n = BigInt(minor), absolute = n < 0n ? -n : n;
  const integer = new Intl.NumberFormat('ru-RU').format(absolute / 100n);
  const cents = absolute % 100n;
  return `${n < 0n ? '−' : ''}${integer}${cents ? ',' + cents.toString().padStart(2, '0') : ''} ₽`;
}

/** Bounded visual width only; financial amounts never pass through Number. */
export function barPercent(minor: string, maximum: bigint, centered = false): string {
  if (maximum <= 0n) return '0%';
  const n = BigInt(minor), absolute = n < 0n ? -n : n;
  const units = absolute * (centered ? 5000n : 10000n) / maximum;
  return `${units / 100n}.${(units % 100n).toString().padStart(2, '0')}%`;
}

export function formatDate(date: string): string {
  return new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', timeZone: 'UTC' })
    .format(new Date(date + 'T00:00:00Z'));
}

export function weekBuckets(rows: readonly DemoOperation[], filters: OverviewFilters) {
  if (filters.start > filters.end) return [];
  const start = Date.parse(filters.start + 'T00:00:00Z'), end = Date.parse(filters.end + 'T00:00:00Z');
  if (!Number.isFinite(start) || !Number.isFinite(end)) return [];
  const day = 86_400_000;
  const step = Math.max(7, Math.ceil(((end - start) / day + 1) / 6));
  const buckets = [];
  for (let at = start; at <= end; at += step * day) {
    const from = new Date(at).toISOString().slice(0, 10);
    const to = new Date(Math.min(end, at + (step - 1) * day)).toISOString().slice(0, 10);
    buckets.push({ from, to, amountMinor: createOverview(rows, { ...filters, start: from, end: to }).expenseMinor });
  }
  return buckets;
}
