import { describe,expect,it } from 'vitest';
import { exampleQuestions,historyGroup,makeDemoReply,newChatBook } from './analyzer';
import { demoOperations } from './fixtures';
import { emptyFilters } from './overview';

describe('finite local Analyzer demonstration',()=>{
  it('agrees with overview totals including refunds, exclusions and neutral rows',()=>{
    const result=makeDemoReply(exampleQuestions[0].text,demoOperations,emptyFilters).result!;
    expect(result).toMatchObject({expenseMinor:'5886900',grossMinor:'6176900',offsetsMinor:'290000',operationCount:18,excludedCount:1,neutralCount:2,unresolvedCount:1});
    expect(result.operationIds).not.toContain('demo-13');expect(result.preview).toHaveLength(3);
  });
  it('uses explicit dates over global dates but retains bank, account and category conditions',()=>{
    const result=makeDemoReply(exampleQuestions[3].text,demoOperations,{...emptyFilters,start:'2026-10-01',end:'2026-10-31',bank:'Сбер'}).result!;
    expect(result.filters).toEqual({...emptyFilters,bank:'Сбер'});expect(result.expenseMinor).toBe('3219900');expect(result.preview).toHaveLength(2);
  });
  it('keeps a historical snapshot while a follow-up recalculates current rows in the prior scope',()=>{
    const old=makeDemoReply(exampleQuestions[3].text,demoOperations,emptyFilters).result!;
    const changed=demoOperations.map(row=>row.id==='demo-1'?{...row,excluded:true}:row);
    const next=makeDemoReply('А по категориям?',changed,{...emptyFilters,start:'2026-10-01',end:'2026-10-31'},old).result!;
    expect(next.expenseMinor).toBe('2686900');expect(next.filters.start).toBe('2026-09-01');expect(old.expenseMinor).toBe('5886900');
    expect(makeDemoReply('А по категориям?',demoOperations,emptyFilters).result).toBeUndefined();
  });
  it('does not inspect financial rows for unsupported requests or imply a financial mutation',()=>{
    const unreadable=new Proxy([] as typeof demoOperations,{get(){throw new Error('rows accessed');}});
    for(const question of ['удали все операции','сегодняшний курс доллара','расскажи анекдот']){const reply=makeDemoReply(question,unreadable,emptyFilters);expect(reply.result).toBeUndefined();expect(reply.text).toContain('AI ещё не подключён');}
  });
  it('distinguishes absent data, invalid filters, a valid zero result and attention preview',()=>{
    expect(makeDemoReply(exampleQuestions[0].text,[],emptyFilters).result).toBeUndefined();
    expect(makeDemoReply(exampleQuestions[0].text,demoOperations,{...emptyFilters,start:'2026-10-01'}).result).toBeUndefined();
    expect(makeDemoReply(exampleQuestions[0].text,demoOperations,{...emptyFilters,bank:'Нет банка'}).result?.operationCount).toBe(0);
    expect(makeDemoReply(exampleQuestions[2].text,demoOperations,emptyFilters).result?.operationIds).toEqual(['demo-12','demo-15']);
  });
  it('creates independent empty conversations and uses calendar days for history groups',()=>{
    const a=newChatBook(),b=newChatBook();expect(a.activeId).not.toBe(b.activeId);expect(a.conversations[0]?.messages).toEqual([]);
    const now=new Date(2026,9,4,12);expect(historyGroup(new Date(2026,9,4,0).toISOString(),now)).toBe('Сегодня');expect(historyGroup(new Date(2026,9,3,23).toISOString(),now)).toBe('Вчера');expect(historyGroup(new Date(2026,8,30).toISOString(),now)).toBe('Последние 7 дней');expect(historyGroup(new Date(2026,8,27).toISOString(),now)).toBe('Ранее');
  });
});
