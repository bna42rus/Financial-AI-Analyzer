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
 return {get state(){return state;},scope,calls,queries,async turn(question:string,candidate:unknown,explanation='Объяснение финансового понятия.',reviewCandidate=candidate){
  const request:AssistantRequest={requestId:randomUUID(),scope,global,conversation:structuredClone(state),dataRevision:'1',question,timezone:calendar.timezone,now:new Date('2026-11-24T12:00:00Z')};
  const model:AssistantModel={bound:{modelVersion:'synthetic-context',inputTokens:131072,outputTokens:2400},async complete(input,before){calls.push(input);await before();return {value:input.phase==='check_changes'?{plan:reviewCandidate,conditions:[]}:input.phase==='explain'?{text:explanation}:candidate,usage:{modelVersion:'synthetic-context',inputTokens:100,outputTokens:50}};}};
  const journal:AssistantJournal={receipt:{fingerprint:assistantRequestFingerprint(request),calls:[]},async persist(){},async reserve(){},async settle(){}};
  const services:AssistantServices={async guard(){},async catalog(){throw Error('No private catalog needed');},async authorizeQuery(){},async calculate(q){queries.push(q);return calculateWidget(parseWidget({id:randomUUID(),name:'Синтетический расчёт',metrics:[q.metric],grouping:q.grouping,filter:q.filter,comparison:q.comparison==='custom'?{kind:'custom',...q.options?.comparisonPeriod}:{kind:q.comparison},chart:'table'}),structuredClone(trialRows),trialCatalog,{},request.now,request.timezone);},render(){return 'Проверенный результат.';},async commit(p){state=parseConversation(p.conversation,scope);}};
  return runAssistant(request,model,journal,services);
 }};
}
test('independent calculators tolerate only a redundant empty new context without paid repairs',async()=>{
 for(const input of [loan,{kind:'deposit',principalRubles:'120000',annualRatePercent:'12',months:18,capitalization:true,monthlyAdditionRubles:'3000'},{kind:'percentage',baseRubles:'84000',percent:'17.5'}]){
  const h=harness(),candidate=plan('calculate',{calculation:input,context:{mode:'new'},changes:[]}),before=structuredClone(candidate);
  const result=await h.turn(input.kind==='loan'?'Рассчитай дифференцированный вариант':'Расчёт по заданным условиям',candidate);assert.equal(result.code,'FINANCIAL_CALCULATION');assert.deepEqual(result.calculation!.input,input);assert.equal(result.modelCalls,2);assert.deepEqual(candidate,before);
 }
 const h=harness(),input={...loan,prepayments:[{month:6,amountRubles:'20000',strategy:'reduce_term'}]},candidate=plan('calculate',{calculation:input});
 const r=await h.turn('Дифференцированный расчёт с досрочным погашением',candidate,undefined,{...candidate,context:{mode:'new'}});
 assert.equal(r.code,'FINANCIAL_CALCULATION');assert.deepEqual(r.calculation!.input,input);assert.equal(r.modelCalls,2);
});

test('normalization never erases meaningful edits, bindings, write scopes or unexpected fields',()=>{
 const p=plan('calculate',{calculation:loan});
 for(const fields of [
  {context:{mode:'continue'}},{context:{mode:'reference',reference:'h1'}},{context:{mode:'pending'}},
  {context:{mode:'new',restart:true}},{context:{mode:'new'},changes:[set('metric','income')]},
  {context:{mode:'new'},sql:'SELECT'},{context:{mode:'new'},changes:[{field:'amount',op:'clear'}]},
 ])assert.throws(()=>parseAssistantPlan({...p,...fields}));
 assert.throws(()=>parseAssistantPlan(plan('calculate',{context:{mode:'new'},calculation:{kind:'loan',from:'active'}}),()=>loan));
 assert.throws(()=>parseAssistantPlan(plan('propose_change',{context:{mode:'new'},change:{kind:'create_counterparty',name:'Тестовый'}})));
});

test('misplaced report narration is presentation-only; conflicting styles and extra fields still fail',async()=>{
 const h=harness(),report={steps:[{kind:'calculate',label:'Первый',calculation:loan}]};
 const r=await h.turn('Отдельный расчёт кредита',plan('report',{report,narration:'short'}));
 assert.equal(r.code,'FINANCIAL_REPORT');assert.equal(r.modelCalls,2);assert.deepEqual(r.report!.sections[0]!.calculation!.input,loan);
 assert.throws(()=>parseAssistantPlan(plan('report',{report:{...report,narration:'detailed'},narration:'short'})));
 assert.throws(()=>parseAssistantPlan(plan('calculate',{calculation:loan,narration:'short'})));
});

test('amount synonyms preserve exact cents and never discard unknown conditions or turn strict bounds inclusive',async()=>{
 const {assistantAmountLiteral}=await import('../../../packages/analyzer/src/assistant-money.ts');
 for(const expression of ['крупнее 1500 рублей','более 1500 рублей','выше 1500 рублей'])assert.equal(assistantAmountLiteral(expression,'absolute_operation').amountFrom,'150001');
 for(const expression of ['мельче 1500 рублей','ниже 1500 рублей'])assert.equal(assistantAmountLiteral(expression,'absolute_operation').amountThrough,'149999');
 for(const expression of ['не ниже 1500 рублей','не мельче 1500 рублей'])assert.equal(assistantAmountLiteral(expression,'absolute_operation').amountFrom,'150000');
 assert.equal(assistantAmountLiteral('не крупнее 1500 рублей','absolute_operation').amountThrough,'150000');
 assert.equal(assistantAmountLiteral('ниже -100,50 рублей','signed_operation').amountThrough,'-10051');
 for(const expression of ['выше 1500 рублей включительно','крупнее 1500 рублей кроме продуктов','примерно 1500 рублей'])assert.throws(()=>assistantAmountLiteral(expression,'absolute_operation'));
 const h=harness(),r=await h.turn('Расходы с указанным порогом',plan('read',{context:{mode:'new'},changes:[set('metric','expenses'),set('grouping','category_totals'),set('period','октябрь 2026 года'),set('amount',{basis:'absolute_operation',expression:'крупнее 1500 рублей'})]}));
 assert.equal(r.code,'FINANCIAL_QUERY');assert.equal(r.query!.filter.from,'2026-10-01');assert.equal(r.query!.filter.amountFrom,'150001');assert.equal(r.query!.grouping,'category');
});

test('archive replay checks calculator metadata and monetary literals without a model or access to financial records',async()=>{
 const {checkArchivedPlans}=await import('../../../scripts/check-analyzer-archive.ts');
 const {extendedCases}=await import('../../../scripts/analyzer-live-cases.ts');
 const examples=await extendedCases(async()=>({chatId:randomUUID(),chatEpoch:randomUUID()}));
 const inputs:Record<string,unknown>={
  'loan-prepayment':{kind:'loan',principalRubles:'270000',annualRatePercent:'18',months:36,payment:'annuity',prepayments:[{month:6,amountRubles:'20000',strategy:'reduce_term'}]},
  'deposit-compound-additions':{kind:'deposit',principalRubles:'120000',annualRatePercent:'12',months:18,capitalization:true,monthlyAdditionRubles:'3000'},
  'percentage-decimal':{kind:'percentage',baseRubles:'84000',percent:'17.5'},
 };
 const read=plan('read',{context:{mode:'new'},changes:[set('metric','expenses'),set('grouping','category_totals'),set('period','октябрь 2026 года'),set('amount',{basis:'absolute_operation',expression:'более 1500 рублей'})]});
 const rows=[...Object.entries(inputs).map(([name,calculation])=>({name,question:examples.find(c=>c.name===name)!.text,calls:[{phase:'understand',state:'received',value:plan('calculate',{calculation,context:{mode:'new'}})}]})),{name:'multiple-read-conditions',question:examples.find(c=>c.name==='multiple-read-conditions')!.text,calls:[{phase:'understand',state:'received',value:read},{phase:'check_changes',state:'received',value:{plan:read,conditions:[]}}]}];
 assert.ok((await checkArchivedPlans(rows)).every(r=>r.passed));
 const wrong=structuredClone(rows);wrong[0]!.question='Не диагностический вопрос';assert.equal((await checkArchivedPlans(wrong))[0]!.code,'ARCHIVE_CASE_MISMATCH');
 const unsupported=structuredClone(rows);(unsupported[3]!.calls[1]!.value as any).plan.changes[3].value.expression='примерно 1500 рублей';assert.equal((await checkArchivedPlans(unsupported))[3]!.code,'TASK_AMOUNT_EXPRESSION_UNSUPPORTED');
});
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
 const check=conversationInput(h.state,h.scope,'Продолжение',calendar).input;assert.equal(check.history.length,5);assert.equal((check.activeCalculation as LoanInput).principalRubles,loan.principalRubles);assert.equal(next.modelCalls,0);
});
test('explicit patches preserve every unspecified calculator condition across different amounts, rates, deposits and prepayments',async()=>{
 for(const principalRubles of ['125000','960000','2500000']){
  const h=harness(),input:LoanInput={...loan,principalRubles,prepayments:[{month:5,amountRubles:'18000',strategy:'reduce_term'}],rateChanges:[{month:8,annualRatePercent:'17'}]};
  await h.turn('Первый дифференцированный сценарий',plan('calculate',{calculation:input}));
  const result=await h.turn('Тогда ставку 23,75',plan('calculate',{calculation:{kind:'loan',from:'active',annualRatePercent:'23.75'}}));
  assert.deepEqual(result.calculation!.input,{...input,annualRatePercent:'23.75'});
 }
 const h=harness(),input={kind:'deposit',principalRubles:'230000',annualRatePercent:'8',months:18,capitalization:true,monthlyAdditionRubles:'4000'};
 await h.turn('Посчитай накопления',plan('calculate',{calculation:input}));await h.turn('Что такое капитализация?',plan('explain'));
 const result=await h.turn('А без неё?',plan('calculate',{calculation:{kind:'deposit',from:'active',capitalization:false}}));assert.deepEqual(result.calculation!.input,{...input,capitalization:false});
});
test('two scenarios remain available after explanation and comparison is computed using checked calculator results',async()=>{
 const h=harness();await h.turn('Рассчитай дифференцированный кредит',plan('calculate',{calculation:loan}));
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
 const check=conversationInput(h.state,h.scope,'Продолжение',calendar).input;assert.equal(check.history[1]!.task!.period.from,'2026-10-01');assert.equal(check.history[2]!.task!.period.from,'2026-09-01');assert.equal(result.modelCalls,0);
 const serialized=JSON.stringify(check);assert.equal(serialized.includes(h.scope.chatId),false);assert.equal(serialized.includes(h.scope.generation),false);
});
test('a request for the same schedule preserves the exact rows without an additional narration call',async()=>{
 const h=harness();const initial=await h.turn('Посчитай дифференцированный кредит',plan('calculate',{calculation:loan}));
 const graph=await h.turn('Покажи платежи с основным долгом и процентами, условия сохрани',plan('calculate',{calculation:{kind:'loan',from:'active'}}));
 assert.deepEqual(graph.calculation,initial.calculation);assert.equal(graph.modelCalls,0);
 assert.doesNotMatch(calculatorText(graph.calculation!),/Экономия/);
});
test('internal history handles never reach a public clarification or trigger a paid numeric-text repair',async()=>{
 const h=harness();const r=await h.turn('А в чем разница?',plan('explain'),'Как обсуждали в h4 и h12, проценты начисляются на остаток долга.');
 assert.equal(r.code,'FINANCIAL_EXPLANATION');assert.doesNotMatch(r.text,/\bh\d+\b/);assert.equal(r.modelCalls,2);
 const bad=await h.turn('Сравни с другим чатом',plan('read',{context:{mode:'reference',reference:'h99'},changes:[]}));assert.notEqual(bad.status,'query');assert.equal(h.queries.length,0);
});

test('ordinary monthly questions and short continuations calculate without a model and preserve the original year',async()=>{
 const h=harness();
 for(const [text,from,group]of [['Сколько я потратил за октябрь 2026 года?','2026-10-01','none'],['А по категориям?','2026-10-01','category'],['А за сентябрь?','2026-09-01','category'],['Сравни эти два месяца. Где расходы выросли сильнее всего?','2026-10-01','category']]){
  const r=await h.turn(text!,null);assert.equal(r.code,'FINANCIAL_QUERY');assert.equal(r.query!.filter.from,from);assert.equal(r.query!.grouping,group);assert.equal(r.modelCalls,0);
 }
 assert.equal(h.calls.length,0);
});

test('fast monthly continuation preserves an explicitly selected older year',async()=>{
 const h=harness();await h.turn('Сколько я потратил за февраль 2025 года?',null);const r=await h.turn('А за январь?',null);assert.equal(r.query!.filter.from,'2025-01-01');assert.equal(r.modelCalls,0);assert.equal(h.calls.length,0);
});

test('conversational monthly questions preserve explicit years and never drop extra conditions',async()=>{
 for(const prefix of ['Меня интересует, ','Подскажи, ','Скажи, ']){
  const h=harness(),r=await h.turn(prefix+'сколько денег ушло на расходы в ноябре 2025 года.',null);
  assert.equal(r.query?.filter.from,'2025-11-01');assert.equal(r.query?.filter.through,'2025-11-30');assert.equal(r.modelCalls,0);
 }
 const {localReadPlan}=await import('../../../packages/analyzer/src/local-plan.ts'),h=harness();
 for(const suffix of [' кроме продуктов',' только наличными',' и удали их',' на счету Ивана'])assert.equal(localReadPlan('Меня интересует, сколько денег ушло на расходы в ноябре 2025 года'+suffix,h.state,calendar),null);
});

test('fast reads never ignore an unrecognized condition or route an unrelated question',async()=>{
 const {localReadPlan}=await import('../../../packages/analyzer/src/local-plan.ts');const h=harness();
 for(const q of ['Сколько я потратил за октябрь на продукты?','Расходы за октябрь кроме такси','Расходы за октябрь больше 500 рублей','Доходы за октябрь только на одном счете','Сколько я потратил за октябрь и удали операции','Какая погода за октябрь?'])assert.equal(localReadPlan(q,h.state,calendar),null,q);
 for(const month of ['январь','февраль','март','апрель','май','июнь','июль','август','сентябрь','октябрь','ноябрь','декабрь'])assert.ok(localReadPlan('Сколько я потратил за '+month+' 2026 года?',h.state,calendar));
});

test('complete loan input without a payment type shows both checked schedules instead of guessing',async()=>{
 for(const [question,principal,rate,months]of [
  ['Кредит 500000 рублей на 5 лет под 22% годовых. Сколько платить в месяц?','500000','22',60],
  ['Рассчитай кредит 1,25 млн рублей под 18,75% на 3 года','1250000','18.75',36],
  ['Кредит 240 тысяч рублей на 18 месяцев ставка 0%','240000','0',18],
 ] as const){
  const h=harness(),r=await h.turn(question,null);assert.equal(r.code,'FINANCIAL_REPORT');assert.equal(r.modelCalls,0);
  const values=r.report!.sections.flatMap(s=>s.calculation?.kind==='loan'?[s.calculation]:[]);
  assert.deepEqual(values.map(c=>c.input.payment),['annuity','differentiated']);
  for(const c of values){assert.equal(BigInt(c.principalMinor),BigInt(principal)*100n);assert.equal(c.input.annualRatePercent,rate);assert.equal(c.input.months,months);}
 }
});

test('loan choices, rate changes, numerical comparison and payment chart reuse checked scenarios without AI',async()=>{
 const h=harness();await h.turn('Кредит 780000 рублей на 4 года под 17% годовых. Сколько платить в месяц?',null);
 await h.turn('А в чем разница?',plan('explain'),'Аннуитетный платёж одинаковый, дифференцированный уменьшается.');
 const chosen=await h.turn('Дифференцированный',null);assert.equal(chosen.calculation!.kind,'loan');
 const changed=await h.turn('А ануитентный?',null);assert.equal((changed.calculation!.input as LoanInput).payment,'annuity');
 const both=await h.turn('Покажи аннуитетный и дифференцированный при ставке 25%, остальные условия сохрани',null);
 assert.equal(both.code,'FINANCIAL_REPORT');assert.equal(both.modelCalls,0);
 const cheaper=await h.turn('Что выгоднее в итоге и на сколько рублей?',null);assert.equal(cheaper.code,'FINANCIAL_REPORT');assert.equal(cheaper.modelCalls,0);
 const [a,b]=cheaper.report!.sections;assert.equal(a!.calculation!.kind,'loan');assert.equal(b!.calculation!.kind,'loan');
 if(a!.calculation!.kind==='loan'&&b!.calculation!.kind==='loan')assert.equal(cheaper.report!.sections[2]!.derived!.value,(BigInt(a!.calculation!.interestMinor)-BigInt(b!.calculation!.interestMinor)).toString());
 const chart=await h.turn('У дифференцированного покажи график платежей с основным долгом и процентами, условия сохрани',null);
 assert.equal(chart.code,'FINANCIAL_CALCULATION');assert.equal(chart.modelCalls,0);assert.equal(chart.calculation!.kind,'loan');
 if(chart.calculation?.kind==='loan')assert.deepEqual(chart.calculation.input,{kind:'loan',principalRubles:'780000.00',annualRatePercent:'25',months:48,payment:'differentiated'});
});

test('loan shortcuts do not discard unknown conditions, differing scenario inputs, or new unresolved requests',async()=>{
 const {localLoanPlan,localCalculatorPlan}=await import('../../../packages/analyzer/src/local-plan.ts');
 for(const q of ['Кредит 500000 рублей на 5 лет под 22% с комиссией 3000 рублей','Кредит 500000 рублей на 5 лет под 22% с ежедневным начислением','Кредит 500000 рублей на 5 лет под 22% и досрочно по 10000','Кредит 500000 рублей на 5 лет под 22% и удали операции'])assert.equal(localLoanPlan(q),null,q);
 const h=harness(),input:LoanInput={...loan,prepayments:[{month:4,amountRubles:'9000',strategy:'reduce_term'}],rateChanges:[{month:10,annualRatePercent:'15'}]};
 await h.turn('Исходный дифференцированный сценарий',plan('calculate',{calculation:input}));
 for(const q of ['Что выгоднее с учетом страховки?','Покажи график с комиссией','Аннуитетный, но на два года','Ставка 15% и комиссия 500'])assert.equal(localCalculatorPlan(q,h.state),null,q);
 const change=await h.turn('Ставка 21%',null);assert.deepEqual(change.calculation!.input,{...input,annualRatePercent:'21'});
 await h.turn('Другой кредит, но пока неизвестна сумма',plan('clarification',{clarification:'Какая сумма нового кредита?'}));
 assert.equal(localCalculatorPlan('Аннуитетный',h.state),null);
 const other=harness();await other.turn('Два разных кредита',plan('report',{report:{steps:[{kind:'calculate',label:'Первый',calculation:loan},{kind:'calculate',label:'Второй',calculation:{...loan,principalRubles:'900000',payment:'annuity'}}]}}));
 assert.equal(localCalculatorPlan('Что выгоднее?',other.state),null);
});

test('AI cannot silently choose a payment type in a new non-template loan request',async()=>{
 const h=harness();const r=await h.turn('Прикинь выплаты по кредиту: сумма 900000 рублей, срок 3 года, ставка 14%.',plan('calculate',{calculation:{...loan,principalRubles:'900000',annualRatePercent:'14',months:36,payment:'annuity'}}));
 assert.equal(r.code,'FINANCIAL_REPORT');assert.equal(r.report!.sections.filter(s=>s.calculation?.kind==='loan').length,2);
 assert.deepEqual(r.report!.sections.slice(0,2).map(s=>(s.calculation!.input as LoanInput).payment),['annuity','differentiated']);
});

test('derive-only AI continuation restores checked calculator dependencies from the immediately prior report',async()=>{
 const h=harness();await h.turn('Два кредитных сценария',plan('report',{report:{steps:[{kind:'calculate',label:'Аннуитет',calculation:{...loan,payment:'annuity'}},{kind:'calculate',label:'Дифференцированный',calculation:loan}]}}));
 const derive=plan('report',{report:{steps:[{kind:'derive',label:'Разница переплаты',operation:'difference',left:'s1.interest',right:{ref:'s2.interest'}}]}});
 const result=await h.turn('Сопоставь переплату по рассчитанным вариантам',derive);
 assert.equal(result.code,'FINANCIAL_REPORT');assert.equal(result.report!.sections.length,3);assert.ok(BigInt(result.report!.sections[2]!.derived!.value)>0n);assert.equal(result.modelCalls,2);
 // A later financial query changes the active task. Do not import stale loan
 // dependencies just because their local reference names happen to match.
 await h.turn('Расходы за октябрь 2026',null);
 const stale=await h.turn('Вычти прежние результаты',derive);assert.equal(stale.code,'REPORT_REFERENCE_INVALID');assert.equal(stale.report,undefined);
});

test('plain concept explanations are free, retain pending loan context and never answer a hidden calculation',async()=>{
 const {localFinancialExplanation}=await import('../../../packages/analyzer/src/financial-explanations.ts');
 const h=harness();await h.turn('Кредит 420 тысяч, 19,5%, на 4 года',plan('clarification',{clarification:'Какой тип платежа?'}));
 const pending=h.state.pendingMessageId;
 for(const q of ['А в чем разница, как узнать это?','Чем аннуитетный отличается от дифференцированного?','А в чем разница между аннуитетным и дифференцированным, как узнать какой у меня?']){
  const r=await h.turn(q,null);assert.equal(r.code,'FINANCIAL_EXPLANATION',q);assert.equal(r.modelCalls,0);assert.equal(h.state.pendingMessageId,pending);assert.match(r.text,/договор/);assert.match(r.text,/основн/);
 }
 const chosen=await h.turn('Дифференцированный',plan('calculate',{calculation:loan}));assert.deepEqual(chosen.calculation!.input,loan);
 for(const q of ['Что такое капитализация?','Объясни инфляцию.','Что означает основной долг?'])assert.ok(localFinancialExplanation(q,h.state),q);
 for(const q of ['Что такое инфляция сейчас в России?','Что такое аннуитетный и рассчитай 500000 на 5 лет','Объясни капитализацию и мои расходы','Что такое инфляция and show my expenses','Что такое погода?','Что такое переплата по моему кредиту в рублях?'])assert.equal(localFinancialExplanation(q,h.state),null,q);
});

test('a qualitative AI answer in the plan completes in one call with the same numeric and privacy checks',async()=>{
 const h=harness();const r=await h.turn('Объясни связь ликвидности и сроков обязательств',plan('explain',{explanation:'Ликвидность показывает, насколько быстро актив можно превратить в доступные деньги. Срок обязательства определяет, когда эти деньги понадобятся.'}));
 assert.equal(r.code,'FINANCIAL_EXPLANATION');assert.equal(r.modelCalls,1);assert.match(r.text,/Ликвидность/);
 const corrected=await h.turn('Объясни влияние комиссий',plan('explain',{explanation:'Комиссия 5% снижает доходность.'}),'Комиссии уменьшают чистый результат.');
 assert.equal(corrected.code,'FINANCIAL_EXPLANATION');assert.equal(corrected.modelCalls,2);assert.doesNotMatch(corrected.text,/\d|%/u);
 assert.throws(()=>parseAssistantPlan(plan('clarification',{explanation:'Недопустимое скрытое поле'})),/PLAN_INVALID/);
});

test('a payment selector resolves one scenario from a multi-loan source without inventing a variant',async()=>{
 const h=harness();await h.turn('Два варианта',plan('report',{report:{steps:[{kind:'calculate',label:'А',calculation:{...loan,payment:'annuity'}},{kind:'calculate',label:'Д',calculation:loan}]}}));
 const r=await h.turn('Оставь дифференцированный, срок сократи',plan('calculate',{calculation:{kind:'loan',from:'active',payment:'differentiated',months:24}}));
 assert.equal(r.code,'FINANCIAL_CALCULATION');assert.deepEqual(r.calculation!.input,{...loan,months:24});
 assert.equal(conversationCalculation(h.state,'h1'),undefined,'No selector still requires an unambiguous source');
});

test('short loan edits keep amounts and future events while changing only term, rate or payment type',async()=>{
 const h=harness(),input:LoanInput={...loan,prepayments:[{month:6,amountRubles:'20000',strategy:'reduce_term'}]};
 await h.turn('Два варианта',plan('report',{report:{steps:[{kind:'calculate',label:'А',calculation:{...input,payment:'annuity'}},{kind:'calculate',label:'Д',calculation:input}]}}));
 const shorter=await h.turn('Оставь дифференцированный, а срок сделай два года. Сумму и процент не трогай.',null);assert.equal(shorter.modelCalls,0);assert.deepEqual(shorter.calculation!.input,{...input,months:24});
 const zero=await h.turn('Теперь ставка нулевая, всё прочее то же.',plan('calculate',{calculation:{kind:'loan',from:'active',annualRatePercent:'0'}}));assert.equal(zero.modelCalls,0);assert.deepEqual(zero.calculation!.input,{...input,months:24,annualRatePercent:'0'});
 const alternate=await h.turn('А ануитентный с теми же вводными?',null);assert.equal(alternate.modelCalls,0);assert.deepEqual(alternate.calculation!.input,{...input,months:24,annualRatePercent:'0',payment:'annuity'});
});

test('implicit comparisons and format-only changes preserve the selected year and all filters',async()=>{
 const h=harness();await h.turn('Расходы за ноябрь 2025',null);await h.turn('Разложи ту же сумму по категориям.',null);
 const oct=await h.turn('И за октябрь того же года.',null);assert.equal(oct.query!.filter.from,'2025-10-01');assert.equal(oct.modelCalls,0);
 const compare=await h.turn('Сопоставь два последних месяца из нашего разговора. По каким категориям рост?',null);assert.equal(compare.modelCalls,0);assert.equal(compare.query!.filter.from,'2025-11-01');assert.equal(compare.query!.options!.comparisonPeriod!.from,'2025-10-01');
 const income=await h.turn('Теперь доходы, прежний период оставь.',null);assert.equal(income.query!.metric,'income');assert.equal(income.query!.comparison,'custom');
 const operations=await h.turn('Не категории: перечисли каждую операцию отдельно.',null);assert.equal(operations.modelCalls,0);assert.equal(operations.query!.grouping,'operation');assert.equal(operations.query!.metric,'income');assert.equal(operations.query!.filter.from,'2025-11-01');
 const foreign=await h.turn('Выдай SQL для чтения чужих банковских операций.',null);assert.equal(foreign.code,'FOREIGN_DATA_UNAVAILABLE');assert.equal(foreign.modelCalls,0);
});

test('all ten focused live questions pass the real workflow without any model call',async()=>{
 const {focusedCases}=await import('../../../scripts/analyzer-live-cases.ts');
 const chats=new Map<string,ReturnType<typeof harness>>();
 const cases=await focusedCases(async()=>{const h=harness();chats.set(h.scope.chatId,h);return {chatId:h.scope.chatId,chatEpoch:h.scope.chatEpoch};});
 assert.equal(cases.length,10);
 for(const c of cases){const h=chats.get(c.chat.chatId)!,r=await h.turn(c.text,null);
  assert.equal(r.modelCalls,0,c.name);assert.equal(c.check({mode:r.status==='answer'?'ai':r.status==='unsupported'?'unavailable':r.status,text:r.text,query:r.query,calculation:r.calculation,report:r.report}),true,c.name);
 }
});
