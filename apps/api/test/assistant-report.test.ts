import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {facet} from '../../../packages/finance-core/src/model.ts';
import type {OperationRow} from '../../../packages/finance-core/src/operations.ts';
import {queryOperations} from '../../../packages/finance-core/src/operations.ts';
import {parseWidget,calculateWidget} from '../../../packages/finance-core/src/overview.ts';
import {decorateAnalysis} from '../../../packages/analyzer/src/analysis.ts';
import {parseAssistantPlan,assistantVersion,reportRequestSchema} from '../../../packages/analyzer/src/assistant-plan.ts';
import {emptyConversation,parseConversation,conversationInput} from '../../../packages/analyzer/src/assistant-conversation.ts';
import {parseReport,bindReportValues,deriveReportFact,renderNarrative} from '../../../packages/analyzer/src/report.ts';
import {compileAssistantBatch} from '../../../packages/analyzer/src/assistant-changes.ts';
import {calculatorRublesMinor} from '../../../packages/analyzer/src/calculators.ts';
import {runAssistant,assistantRequestFingerprint} from '../src/assistant-workflow.ts';
import type {AssistantModel,AssistantJournal,AssistantRequest,AssistantServices} from '../src/assistant-workflow.ts';
import type {Query} from '../../../packages/analyzer/src/registry.ts';
import type {Answer} from '../../../packages/analyzer/src/types.ts';
const account=randomUUID(),category=randomUUID(),scope={ownerId:'synthetic-report-owner',chatId:randomUUID(),chatEpoch:randomUUID(),generation:randomUUID()},global={revision:0,filter:{from:'2026-11-01',through:'2026-11-30'},touched:{}};
const catalog={accounts:[{id:account,bankId:'tbank',name:'Счёт',type:'bank_account' as const,analyticsEnabled:true,defaultVisible:true,loanMode:null}],categories:[{id:category,name:'Кафе',role:'expense' as const,parentId:null,hidden:false}],counterparties:[]};
function row(amount:string,role:'income'|'expense'):OperationRow{return {id:randomUUID(),accountId:account,date:{precision:'day',date:'2026-11-02'},amountMinor:amount,analyticsRole:role,decompositionActive:false,parts:[{id:randomUUID(),componentId:null,allocationId:null,amountMinor:amount,role,categoryId:role==='expense'?category:null,subcategoryId:null,basis:[],included:true}],reviewReasons:[],unresolvedMinor:'0',neutralMinor:'0',excludedMinor:'0',classification:{kind:facet('purchase'),role:facet(role),category:facet(role==='expense'?category:null),subcategory:facet(null),merchant:facet('Кафе'),counterparty:facet(null)},comment:''};}
const rows=[row('-10000','expense'),row('-20000','expense'),row('100000','income')];
const change=(field:string,value:unknown)=>({field,op:'set',value});
const read=(metric:string,label=metric)=>({kind:'read',label,context:{mode:'new'},changes:[change('metric',metric),change('grouping','total')]});
function harness(plan:unknown,narrative:unknown={blocks:[{kind:'conclusion',template:'Проверенный результат: {{s1.total}}.'}]}){
 let calls=0,commits=0,prepares=0,conversation=emptyConversation(scope);const sent:unknown[]=[];
 const request:AssistantRequest={requestId:randomUUID(),scope,conversation,global,dataRevision:'1',question:'Составь связанный финансовый расчёт',now:new Date('2026-11-17T12:00:00Z'),timezone:'Europe/Moscow'};
 const journal:AssistantJournal={receipt:{fingerprint:assistantRequestFingerprint(request),calls:[]},async persist(){},async reserve(){},async settle(){}};
 const model:AssistantModel={bound:{modelVersion:'synthetic',inputTokens:131072,outputTokens:1200},async complete(input,before){await before();calls++;sent.push(input.input);return {value:input.phase==='check_changes'?{plan,conditions:[]}:input.phase==='explain'?narrative:plan,usage:{modelVersion:'synthetic',inputTokens:100,outputTokens:50}};}};
 const services:AssistantServices={async guard(){},async catalog(){return catalog;},async authorizeQuery(){},async calculate(q){const widget=parseWidget({id:randomUUID(),name:'Синтетический расчёт',metrics:[q.metric],grouping:q.grouping,filter:q.filter,comparison:{kind:q.comparison},chart:'table'}),result=calculateWidget(widget,rows,catalog,{},request.now,'Europe/Moscow'),answer:Answer={registryVersion:'analyzer/5',mode:'ai',text:'Расчёт',query:q,widget,result,generation:scope.generation,revision:'1',accountCount:1,computedAt:request.now.toISOString()};answer.analysis=decorateAnalysis(q,rows,catalog,result);return {answer,dependencyIds:queryOperations(rows,catalog,{filter:{...q.filter,metric:q.metric},sort:'date',direction:'asc',group:'none'}).operations.map(o=>o.id)};},describeResult:(_q,r)=>(r as any).answer,resultDependencies:r=>(r as any).dependencyIds,render:()=>'',async prepareBatch(changes){prepares++;return {version:'cashneuro-change-proposal/1',intent:{kind:'compound',id:request.requestId,items:changes.map(s=>s.change)},title:'Проект',description:['Только после подтверждения'],sourceAnswerId:request.requestId};},async commit(p){commits++;conversation=parseConversation(p.conversation,scope);}};
 return {run:()=>runAssistant(request,model,journal,services),get calls(){return calls;},get prepares(){return prepares;},get commits(){return commits;},get state(){return conversation;},sent,journal,services,request};
}
test('report reads expenses and income, derives exact difference and narrates only verified facts',async()=>{
 const p={version:assistantVersion,topic:'personal_finance',action:'report',report:{steps:[read('expenses'),read('income'),{kind:'derive',label:'Свободный поток',operation:'difference',left:'s2.total',right:{ref:'s1.total'}}],narration:'simple'}},h=harness(p,{blocks:[{kind:'conclusion',template:'Доходы {{s2.total}}, расходы {{s1.total}}, разница {{s3.total}}.'}]});
 const reply=await h.run();assert.equal(reply.code,'FINANCIAL_REPORT');assert.equal(reply.status,'query');assert.equal(reply.report!.facts.find(f=>f.ref==='s3.total')!.value,'70000');assert.equal(reply.report!.narrative[0]!.text,'Доходы 1 000,00 ₽, расходы 300,00 ₽, разница 700,00 ₽.');assert.equal(h.calls,3);assert.equal(reply.reportDependencyIds!.length,3);assert.equal(h.state.book.nodes.length,1);assert.equal(h.state.book.nodes[0]!.query.metric,'income');for(const input of h.sent)assert.equal(JSON.stringify(input).includes(account),false);
 const before=h.calls;assert.deepEqual(await h.run(),reply);assert.equal(h.calls,before);
});
test('report binds a checked payment into a proposed budget, calculator inputs survive the next turn',async()=>{
 const p={version:assistantVersion,topic:'personal_finance',action:'report',report:{steps:[{kind:'calculate',label:'Кредит',calculation:{kind:'loan',principalRubles:'1200',annualRatePercent:'0',months:12,payment:'annuity'}},{kind:'change',label:'Бюджет',change:{kind:'create_budget',name:'Платёж',period:'month',basis:'net',amountRubles:'0'},bindings:[{field:'amountRubles',ref:'s1.payment'}]}]}},h=harness(p);const reply=await h.run();assert.equal(reply.code,'FINANCIAL_REPORT');assert.equal(h.prepares,1);assert.equal((reply.proposal!.intent.items as any[])[0].amountRubles,'100.00');assert.equal(reply.status,'answer');assert.equal(h.state.book.nodes.length,0);const next=conversationInput(h.state,scope,'А если на год дольше?',{timezone:'Europe/Moscow',currentDate:'2026-11-17'});assert.equal(next.input.activeCalculation?.kind,'loan');assert.equal((next.input.activeCalculation as any).principalRubles,'1200');
});
test('partial report marks a failed derivation, blocks dependent writes and retains valid results',async()=>{
 const p={version:assistantVersion,topic:'personal_finance',action:'report',report:{steps:[read('expenses'),{kind:'derive',label:'Неизвестная база',operation:'ratio',left:'s1.total',right:{literal:'0',unit:'money'}},{kind:'change',label:'Не сохранять',change:{kind:'create_counterparty',name:'Получатель'}}]}},h=harness(p),r=await h.run();assert.equal(r.report!.sections[0]!.answer!.result!.totals.expenses,'30000');assert.equal(r.report!.sections[1]!.error!.code,'REPORT_DIVISION_INVALID');assert.equal(h.prepares,0);assert.equal(r.proposal,undefined);
});
test('narrative cannot invent numerical values, HTML, links or facts outside its evidence',()=>{
 const facts=[{ref:'s1.total',label:'Расходы',value:'10000',display:'100,00 ₽',unit:'money' as const}];
 for(const template of ['Экономия 999 рублей.','<img src=x>','http://evil.test','{{s2.total}}'])assert.throws(()=>renderNarrative({blocks:[{kind:'conclusion',template}]},facts));assert.equal(renderNarrative({blocks:[{kind:'conclusion',template:'{{s1.total.label}}: {{s1.total}}.'}]},facts)[0]!.text,'Расходы: 100,00 ₽.');
});
test('report schemas reject future/self references, arbitrary units, duplicate bindings and hidden authority',()=>{
 const bad=[{steps:[{kind:'derive',label:'bad',operation:'sum',left:'s1.total',right:{literal:'1',unit:'count'}}]},{steps:[{kind:'calculate',label:'bad',calculation:{kind:'percentage',baseRubles:'10',percent:'10'},bindings:[{field:'sql',ref:'s1.total'}]}]}];for(const p of bad)assert.throws(()=>parseReport(p,reportRequestSchema));
 assert.throws(()=>parseAssistantPlan({version:assistantVersion,topic:'general_finance',action:'report',report:{steps:[read('expenses')]}}));
 assert.throws(()=>bindReportValues({months:0},[{field:'months',ref:'s1.total'}],[{ref:'s1.total',label:'x',value:'10000',display:'100 ₽',unit:'money'}]),/UNIT_MISMATCH/);
});
test('ordered batch can create a counterparty and assign that exact new ID without writing during compilation',()=>{
 const ids=[randomUUID(),randomUUID()],operationId=randomUUID(),batch=compileAssistantBatch([{change:{kind:'create_counterparty',name:'Арендодатель'}},{change:{kind:'answer_operations',patch:{counterpartyName:'Арендодатель'}},operationIds:[operationId]}],{...catalog,rules:[],budgets:[]},{requestId:randomUUID(),ids,sourceAnswerId:randomUUID(),parseRubles:calculatorRublesMinor,timezone:'Europe/Moscow'});const items=batch.intent.items as any[];assert.equal(items[0].id,ids[0]);assert.equal(items[1].patch.counterpartyId,ids[0]);assert.equal(items[1].id,operationId);assert.equal(catalog.counterparties.length,0);
});

test('monthly insurance uses exact money times months, never money times money',()=>{
 const facts=[{ref:'s1.months',label:'Срок',value:'12',display:'12',unit:'count' as const}],r=deriveReportFact({kind:'derive',label:'Страховка за срок',operation:'multiply',left:'s1.months',right:{literal:'1000',unit:'money'}},2,facts);assert.equal(r.value,'1200000');assert.equal(r.unit,'money');assert.throws(()=>deriveReportFact({kind:'derive',label:'bad',operation:'multiply',left:'s1.months',right:{literal:'10',unit:'percent'}},2,facts),/UNIT_MISMATCH/);
});

test('operations cashflow cannot be laundered into a confirmed starting balance or wrong monthly basis',()=>{
 const fact={ref:'s1.total',label:'Поток за квартал',value:'90000',display:'900 ₽',unit:'money' as const,flow:true,periodMonths:3};assert.throws(()=>bindReportValues({availableRubles:'0'},[{field:'availableRubles',ref:fact.ref}],[fact]),/BALANCE_UNCONFIRMED/);assert.throws(()=>bindReportValues({monthlyIncomeRubles:'0'},[{field:'monthlyIncomeRubles',ref:fact.ref}],[fact]),/PERIOD_MISMATCH/);
 const monthly=deriveReportFact({kind:'derive',label:'В среднем за месяц',operation:'divide',left:'s1.total',right:{literal:'3',unit:'count'}},2,[fact]);assert.equal(monthly.periodMonths,1);assert.equal(bindReportValues({monthlyIncomeRubles:'0'},[{field:'monthlyIncomeRubles',ref:monthly.ref}],[monthly]).monthlyIncomeRubles,'300.00');assert.throws(()=>bindReportValues({availableRubles:'0'},[{field:'availableRubles',ref:monthly.ref}],[monthly]),/BALANCE_UNCONFIRMED/);
});
