import { describe,expect,it } from 'vitest';
import { demoOperations } from './fixtures';
import { emptyFilters } from './overview';
import { defaultOperationsView,operationList,selectRange } from './operations';

describe('read-only synthetic operation list',()=>{
  it('searches Russian text without case or ё differences',()=>{
    const row={...demoOperations[0]!,merchant:'Аксёнов'};
    expect(operationList([row],emptyFilters,{...defaultOperationsView,query:'  АКСЕНОВ '}).rows.map(row=>row.id)).toEqual(['demo-1']);
    expect(operationList(demoOperations,emptyFilters,{...defaultOperationsView,query:'8900'}).rows.map(row=>row.id)).toEqual(['demo-9']);
  });
  it('preserves exact financial semantics in quick filters',()=>{
    const attention=operationList(demoOperations,emptyFilters,{...defaultOperationsView,quick:'attention'});
    expect(attention.rows).toHaveLength(2);expect(attention.totals.expenseMinor).toBe('120000');expect(attention.totals.incomeMinor).toBe('0');
    for(const quick of ['excluded','unresolved'] as const){const result=operationList(demoOperations,emptyFilters,{...defaultOperationsView,quick});expect(result.rows).toHaveLength(1);expect(result.totals.expenseMinor).toBe('0');expect(result.totals.incomeMinor).toBe('0');}
  });
  it('intersects search, basic and advanced filters',()=>{
    const result=operationList(demoOperations,{...emptyFilters,start:'2026-09-20',bank:'Т-Банк',account:'Для покупок',categories:['Продукты']},{...defaultOperationsView,query:'перекресток',kind:'Покупка',role:'expense'});
    expect(result.counts.all).toBe(1);expect(result.counts.attention).toBe(0);expect(result.rows.map(row=>row.id)).toEqual(['demo-17']);expect(result.totals.expenseMinor).toBe('174000');
  });
  it('keeps drilldown IDs inside the current global context',()=>{
    const result=operationList(demoOperations,{...emptyFilters,bank:'Сбер'},defaultOperationsView,{label:'Проверка',ids:['demo-9','demo-18','missing']});
    expect(result.rows.map(row=>row.id)).toEqual(['demo-18']);expect(result.totals.expenseMinor).toBe('19900');
  });
  it('sorts signed money exactly beyond Number precision and leaves sources unchanged',()=>{
    const original=demoOperations[0]!;
    const rows=[{...original,id:'larger',amountMinor:'900719925474099102'},{...original,id:'smaller',amountMinor:'900719925474099101'},{...original,id:'negative',amountMinor:'-900719925474099102'}];
    expect(operationList(rows,emptyFilters,{...defaultOperationsView,sort:'amount-asc'}).rows.map(row=>row.id)).toEqual(['negative','smaller','larger']);
    expect(rows.map(row=>row.id)).toEqual(['larger','smaller','negative']);
    expect(operationList(demoOperations,emptyFilters,defaultOperationsView).rows[0]?.id).toBe('demo-18');
  });
  it('selects stable ID ranges in either direction and ignores missing targets',()=>{
    expect(selectRange(['a','b','c','d'],'d','b',['a'])).toEqual(['a','b','c','d']);
    expect(selectRange(['a','b'],'missing','b',[])).toEqual(['b']);
    expect(selectRange(['a','b'],'a','missing',['a'])).toEqual(['a']);
  });
});
