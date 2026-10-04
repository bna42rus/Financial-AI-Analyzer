import { describe, expect, it } from 'vitest';
import { demoOperations } from './fixtures';
import { barPercent, createOverview, emptyFilters, filterOperations, formatMoney, weekBuckets } from './overview';
import type { DemoOperation } from './overview';

describe('synthetic overview projection', () => {
  it('does not invent transactions for an empty account', () => {
    const overview = createOverview([], emptyFilters);
    expect(overview.matching).toEqual([]);
    expect(overview.expenseMinor).toBe('0');
    expect(overview.attention).toBe(0);
  });
  it('offsets the refund and excludes own transfers, unclassified transfers and exclusions', () => {
    const result = createOverview(demoOperations, emptyFilters);
    expect(result.expenseMinor).toBe('5886900');
    expect(result.incomeMinor).toBe('12000000');
    expect(result.differenceMinor).toBe('6113100');
    expect(result.grossMinor).toBe('6176900');
    expect(result.offsetsMinor).toBe('290000');
    expect(result.attention).toBe(2);
    expect(result.excludedCount).toBe(1);
    expect(result.neutralCount).toBe(2);
    expect(result.unresolvedCount).toBe(1);
  });
  it('keeps an expense with an unknown category in totals and attention', () => {
    const result = createOverview(demoOperations, { ...emptyFilters, categories: ['Категория не определена'] });
    expect(result.expenseMinor).toBe('120000');
    expect(result.attention).toBe(1);
  });
  it('records a refund on its own date and supports negative net expense', () => {
    const result = createOverview(demoOperations, { ...emptyFilters, start: '2026-09-18', end: '2026-09-18' });
    expect(result.expenseMinor).toBe('-290000');
    expect(result.categories).toEqual([{ name: 'Одежда', amountMinor: '-290000' }]);
  });
  it('applies period, bank, account and multi-category filters together', () => {
    const rows = filterOperations(demoOperations, { ...emptyFilters, start: '2026-09-20', bank: 'Т-Банк', account: 'Для покупок', categories: ['Продукты','Транспорт'] });
    expect(rows.map(row => row.id)).toEqual(['demo-11','demo-14','demo-17']);
  });
  it('handles date-only boundaries without shifting the bank date', () => {
    const rows = filterOperations(demoOperations, { ...emptyFilters, start: '2026-09-30', end: '2026-09-30' });
    expect(rows.map(row => row.id)).toEqual(['demo-18']);
    expect(filterOperations(demoOperations, { ...emptyFilters, start: '2026-10-01' })).toEqual([]);
  });
  it('keeps summed amounts and formatted cents exact beyond Number precision', () => {
    const base = demoOperations[0]!;
    const row: DemoOperation = { ...base, amountMinor: '-900719925474099101' };
    expect(createOverview([row,{ ...row, id:'demo-large-2' }],emptyFilters).expenseMinor).toBe('1801439850948198202');
    expect(formatMoney('1801439850948198202').replace(/\s/g,'')).toBe('18014398509481982,02₽');
    expect(formatMoney('-101')).toBe('−1,01 ₽');
    expect(() => formatMoney('1.1')).toThrow();
  });
  it('reconciles time buckets with the selected totals and bounds chart widths', () => {
    const buckets = weekBuckets(demoOperations, emptyFilters);
    expect(buckets.reduce((sum,bucket)=>sum+BigInt(bucket.amountMinor),0n).toString()).toBe(createOverview(demoOperations,emptyFilters).expenseMinor);
    expect(barPercent('-290000',580000n,true)).toBe('25.00%');
    expect(barPercent('0',0n)).toBe('0%');
    expect(weekBuckets(demoOperations,{...emptyFilters,start:'2026-10-01'})).toEqual([]);
  });
});
