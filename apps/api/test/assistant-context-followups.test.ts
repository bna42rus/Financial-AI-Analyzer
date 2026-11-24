import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {runAssistant,assistantRequestFingerprint} from '../src/assistant-workflow.ts';
import type {AssistantRequest,AssistantServices,AssistantModel,AssistantJournal,CompletionInput} from '../src/assistant-workflow.ts';
import {assistantVersion,parseAssistantPlan} from '../../../packages/analyzer/src/assistant-plan.ts';
import {emptyConversation,conversationInput,conversationCalculation,parseConversation} from '../../../packages/analyzer/src/assistant-conversation.ts';
import {calculateFinancial,calculatorText} from '../../../packages/analyzer/src/calculators.ts';
import type {LoanInput} from '../../../packages/analyzer/src/calculators.ts';
import {trialCatalog,trialRows} from '../src/task-trial.ts';
import {parseWidget,calculateWidget} from '../../../packages/finance-core/src/overview.ts';
import type {Query} from '../../../packages/analyzer/src/registry.ts';
const calendar={timezone:'Europe/Moscow',currentDate:'2026-11-24'};
const loan:LoanInput={kind:'loan',principalRubles:'420000',annualRatePercent:'19.5',months:48,payment:'differentiated'};
const plan=(action:string,fields:Record<string,unknown>={})=>({version:assistantVersion,topic:action==='read'?'personal_finance':'general_finance',action,...fields});
const set=(field:string,value:unknown)=>({field,op:'set',value});
function harness(){
 const scope={ownerId:'synthetic-context-owner',chatId:randomUUID(),chatEpoch:randomUUID(),generation:randomUUID()},global={revision:0,filter:{},touched:{}};
 let state=emptyConversation(scope);const calls:CompletionInput[]=[],queries:Query[]=[];
 return {get state(){return state;},scope,calls,queries,async turn(question:string,candidate:unknown,explanation='Объяснение финансового понятия.'){
  const request:AssistantRequest={requestId:randomUUID(),scope,global,conversation:structuredClone(state),dataRevision:'1',question,timezone:calendar.timezone,now:new Date('2026-11-24T12:00:00Z')};
  const model:AssistantModel={bound:{modelVersion:'synthetic-context',inputTokens:131072,outputTokens:2400},async complete(input,before){calls.push(input);await before();return {value:input.phase==='check_changes'?{plan:candidate,conditions:[]}:input.phase==='explain'?{text:explanation}:candidate,usage:{modelVersion:'synthetic-context',inputTokens:100,outputTokens:50}};}};
  const journal:AssistantJournal={receipt:{fingerprint:assistantRequestFingerprint(request),calls:[]},async persist(){},async reserve(){},async settle(){}};
  const services:AssistantServices={async guard(){},async catalog(){throw Error('No private catalog needed');},async authorizeQuery(){},async calculate(q){queries.push(q);return calculateWidget(parseWidget({id:randomUUID(),name:'Синтетический расчёт',metrics:[q.metric],grouping:q.grouping,filter:q.filter,comparison:q.comparison==='custom'?{kind:'custom',...q.options?.comparisonPeriod}:{kind:q.comparison},chart:'table'}),structuredClone(trialRows),trialCatalog,{},request.now,request.timezone);},render(){return 'Проверенный результат.';},async commit(p){state=parseConversation(p.conversation,scope);}};
  return runAssistant(request,model,journal,services);
 }};
}
test('pending calculator survives a concept question, then success clears pending and later explanations preserve conditions',async()=>{
 const h=harness();
 await h.turn('Кредит 420 тысяч, 19,5%, на 4 года',plan('clarification',{clarification:'Какой тип платежа: аннуитетный или дифференцированный?'}));
 const pending=h.state.pendingMessageId;
 await h.turn('А в чем разница и где это узнать?',plan('explain'),'Аннуитетный платёж одинаковый, дифференцированный уменьшается. Тип указан в договоре и графике банка.');
 const input=conversationInput(h.state,h.scope,'Дифференцированный',calendar).input;
 assert.equal(h.state.pendingMessageId,pending);assert.match(input.pendingRequest!.question,/420/);assert.match(input.pendingRequest!.response!,/тип платежа/);
 const first=await h.turn('Дифференцированный',plan('calculate',{calculation:loan}));assert.equal(first.code,'FINANCIAL_CALCULATION');assert.equal(h.state.pendingMessageId,null);
 await h.turn('Объясни основной долг',plan('explain'));
 const next=await h.turn('А ануитентный?',plan('calculate',{calculation:{kind:'loan',from:'active',payment:'annuity'}}));
 assert.equal(next.calculation!.kind,'loan');assert.deepEqual(next.calculation!.input,{...loan,payment:'annuity'});
 const check=h.calls.findLast(c=>c.phase==='check_changes')!.input as any;assert.equal(check.history.length,4);assert.equal(check.activeCalculation.principalRubles,loan.principalRubles);
});
test('explicit patches preserve every unspecified calculator condition across different amounts, rates, deposits and prepayments',async()=>{
 for(const principalRubles of ['125000','960000','2500000']){
  const h=harness(),input:LoanInput={...loan,principalRubles,prepayments:[{month:5,amountRubles:'18000',strategy:'reduce_term'}],rateChanges:[{month:8,annualRatePercent:'17'}]};
  await h.turn('Первый сценарий',plan('calculate',{calculation:input}));
  const result=await h.turn('Тогда ставку 23,75',plan('calculate',{calculation:{kind:'loan',from:'active',annualRatePercent:'23.75'}}));
  assert.deepEqual(result.calculation!.input,{...input,annualRatePercent:'23.75'});
 }
 const h=harness(),input={kind:'deposit',principalRubles:'230000',annualRatePercent:'8',months:18,capitalization:true,monthlyAdditionRubles:'4000'};
 await h.turn('Посчитай накопления',plan('calculate',{calculation:input}));await h.turn('Что такое капитализация?',plan('explain'));
 const result=await h.turn('А без неё?',plan('calculate',{calculation:{kind:'deposit',from:'active',capitalization:false}}));assert.deepEqual(result.calculation!.input,{...input,capitalization:false});
});
test('two scenarios remain available after explanation and comparison is computed using checked calculator results',async()=>{
 const h=harness();await h.turn('Рассчитай кредит',plan('calculate',{calculation:loan}));
 const scenarios=plan('report',{report:{steps:[{kind:'calculate',label:'Аннуитет',calculation:{kind:'loan',from:'active',payment:'annuity'}},{kind:'calculate',label:'Дифференцированный',calculation:{kind:'loan',from:'active',payment:'differentiated'}}]}});
 const first=await h.turn('Покажи оба вида',scenarios);assert.equal(first.report!.sections.length,2);
 await h.turn('Что означает переплата?',plan('explain'));
 const compare=await h.turn('Какой выгоднее и на сколько?',plan('report',{report:{steps:[{kind:'calculate',label:'Аннуитет',calculation:{kind:'loan',from:'active',variant:1}},{kind:'calculate',label:'Дифференцированный',calculation:{kind:'loan',from:'active',variant:2}},{kind:'derive',label:'Разница процентов',operation:'difference',left:'s1.interest',right:{ref:'s2.interest'}}]}}));
 const a=calculateFinancial({...loan,payment:'annuity'}),b=calculateFinancial(loan);assert.equal(a.kind,'loan');assert.equal(b.kind,'loan');if(a.kind==='loan'&&b.kind==='loan')assert.equal(compare.report!.sections[2]!.derived!.value,(BigInt(a.interestMinor)-BigInt(b.interestMinor)).toString());
 assert.equal(conversationCalculation(h.state,'active'),undefined,'Do not silently select one of multiple scenarios');
 assert.throws(()=>parseAssistantPlan(plan('calculate',{calculation:{kind:'loan',from:'h99',payment:'annuity'}}),(s,v)=>conversationCalculation(h.state,s,v)),/CONTEXT_INVALID/);
 assert.throws(()=>parseAssistantPlan(plan('calculate',{calculation:{kind:'deposit',from:'active',variant:1}}),(s,v)=>conversationCalculation(h.state,s,v)),/CONTEXT_INVALID/);
});
test('two historical periods can be compared exactly after grouping, a date change and an unrelated concept explanation',async()=>{
 const h=harness();
 await h.turn('Расходы за октябрь',plan('read',{context:{mode:'new'},changes:[set('metric','expenses'),set('period','октябрь 2026')]}));
 await h.turn('А по категориям?',plan('read',{context:{mode:'continue'},changes:[set('grouping','category_totals')]}));
 await h.turn('А за сентябрь?',plan('read',{context:{mode:'continue'},changes:[set('period','сентябрь 2026')]}));
 await h.turn('Что такое категория расходов?',plan('explain'));
 const result=await h.turn('Сравни эти два месяца, где выросли расходы?',plan('read',{context:{mode:'reference',reference:'h2',comparisonReference:'h3'},changes:[]}));
 assert.equal(result.code,'FINANCIAL_QUERY');assert.equal(result.query!.grouping,'category');assert.equal(result.query!.filter.from,'2026-10-01');assert.equal(result.query!.comparison,'custom');assert.deepEqual(result.query!.options!.comparisonPeriod,{from:'2026-09-01',through:'2026-09-30'});
 const check=h.calls.findLast(c=>c.phase==='check_changes')!.input as any;assert.equal(check.history[1].task.period.from,'2026-10-01');assert.equal(check.history[2].task.period.from,'2026-09-01');
 const serialized=JSON.stringify(check);assert.equal(serialized.includes(h.scope.chatId),false);assert.equal(serialized.includes(h.scope.generation),false);
});
test('a request for the same schedule preserves the exact rows without an additional narration call',async()=>{
 const h=harness();const initial=await h.turn('Посчитай кредит',plan('calculate',{calculation:loan}));
 const graph=await h.turn('Покажи платежи с основным долгом и процентами, условия сохрани',plan('calculate',{calculation:{kind:'loan',from:'active'}}));
 assert.deepEqual(graph.calculation,initial.calculation);assert.equal(graph.modelCalls,2);
 assert.doesNotMatch(calculatorText(graph.calculation!),/Экономия/);
});
test('internal history handles never reach a public clarification or trigger a paid numeric-text repair',async()=>{
 const h=harness();const r=await h.turn('А в чем разница?',plan('explain'),'Как обсуждали в h4 и h12, проценты начисляются на остаток долга.');
 assert.equal(r.code,'FINANCIAL_EXPLANATION');assert.doesNotMatch(r.text,/\bh\d+\b/);assert.equal(r.modelCalls,2);
 const bad=await h.turn('Сравни с другим чатом',plan('read',{context:{mode:'reference',reference:'h99'},changes:[]}));assert.notEqual(bad.status,'query');assert.equal(h.queries.length,0);
});
