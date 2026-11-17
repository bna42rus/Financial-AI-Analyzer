import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {facet} from '../../finance-core/src/model.ts';
import type {OperationRow} from '../../finance-core/src/operations.ts';
import {parseWidget,calculateWidget} from '../../finance-core/src/overview.ts';
import {parseTool,queryMetrics,queryGroupings} from '../src/registry.ts';
import type {Query} from '../src/registry.ts';
import {analyzeFinancialRows,decorateAnalysis,parseAnalysisOptions} from '../src/analysis.ts';
import {calculateFinancial} from '../src/calculators.ts';
import {compileAssistantChange,parseAssistantChange} from '../src/assistant-changes.ts';
import {calculatorRublesMinor} from '../src/calculators.ts';
const account=randomUUID(),cat=randomUUID();
const catalog={accounts:[{id:account,bankId:'tbank',name:'Счёт',type:'bank_account' as const,analyticsEnabled:true,defaultVisible:true,loanMode:null}],categories:[{id:cat,name:'Кафе',role:'expense' as const,parentId:null,hidden:false}],counterparties:[]};
const row=(amount:string,role:'expense'|'income'|'neutral'|'unresolved'='expense',date='2026-11-01'):OperationRow=>({id:randomUUID(),date:{precision:'day',date},accountId:account,amountMinor:amount,analyticsRole:role,decompositionActive:false,reviewReasons:[],unresolvedMinor:'0',neutralMinor:'0',excludedMinor:'0',parts:[{id:randomUUID(),componentId:null,allocationId:null,amountMinor:amount,role,categoryId:cat,subcategoryId:null,basis:[],included:true}],classification:{kind:facet('purchase'),role:facet(role),category:facet(cat),subcategory:facet(null),merchant:facet('Кафе'),counterparty:facet(null)},comment:''});
const query=(patch:Partial<Query>={}):Query=>({name:'query_finances',metric:'expenses',grouping:'none',comparison:'none',filter:{},...patch});
const result=(q:Query,rows:OperationRow[])=>calculateWidget(parseWidget({id:randomUUID(),name:'Тест',metrics:[q.metric],grouping:q.grouping,filter:q.filter,comparison:{kind:q.comparison},chart:'table'}),rows,catalog,{},new Date('2026-11-17T12:00:00Z'),'Europe/Moscow',true);
for(const metric of queryMetrics)for(const grouping of queryGroupings)test('shared exact metric '+metric+' / '+grouping,()=>{
 const rows=[row('-10000'),row('-20000'),row('5000'),row('70000','income'),row('-90000','neutral'),row('-80000','unresolved')],q=query({metric,grouping}),r=result(q,rows),analysis=analyzeFinancialRows(q,rows,catalog,r);assert.equal(analysis.sum,r.totals[metric]);assert.equal((parseTool(q) as Query).grouping,grouping);
});
test('mean, even median, signed rounding and empty datasets preserve exact cents',()=>{
 const rows=[row('-10001'),row('-20000'),row('-30000'),row('-40002')],q=query({metric:'gross_expenses',options:{statistic:'median'}});let a=analyzeFinancialRows(q,rows,catalog,result(q,rows));assert.equal(a.value,'25000');assert.equal(a.mean,'25001');assert.equal(a.minimum,'10001');assert.equal(a.maximum,'40002');
 a=analyzeFinancialRows(q,[],catalog,result(q,[]));assert.equal(a.value,null);assert.equal(a.count,0);
});
test('parts are not added to parent, excluded and neutral portions do not become expenses',()=>{
 const o=row('-30000');o.decompositionActive=true;o.parts[0]!.amountMinor='-10000';o.parts.push({...o.parts[0]!,id:randomUUID(),amountMinor:'-20000',role:'neutral'});const excluded=row('-90000');excluded.parts[0]!.included=false;const q=query();assert.equal(analyzeFinancialRows(q,[o,excluded],catalog,result(q,[o,excluded])).sum,'10000');
});
test('group medians and comparison statistics use the same scoped rows',()=>{
 const rows=[row('-10000'),row('-30000'),row('-50000','expense','2026-10-01'),row('-70000','expense','2026-10-02')],q=query({grouping:'merchant',comparison:'previous_month',filter:{from:'2026-11-01',through:'2026-11-30'},options:{statistic:'median'}}),r=result(q,rows),a=decorateAnalysis(q,rows,catalog,r);assert.equal(a.value,'20000');assert.equal(a.previousValue,'60000');assert.equal(r.points[0]!.values.expenses,'20000');assert.equal(r.points[0]!.previous.expenses,'60000');assert.equal(r.totals.expenses,'40000');
});
test('savings is explicit scenario, recurring is a candidate, single charge is not a subscription',()=>{
 const rows=[row('-10000'),row('-10000','expense','2026-10-01'),row('-10000','expense','2026-09-01')];let q=query({grouping:'category',options:{purpose:'savings',reductionPercent:20}}),a=analyzeFinancialRows(q,rows,catalog,result(q,rows));assert.equal(a.savings![0]!.savingMinor,'6000');q=query({options:{purpose:'recurring'}});a=analyzeFinancialRows(q,rows,catalog,result(q,rows));assert.equal(a.recurring![0]!.regular,true);assert.equal(a.recurring![0]!.count,3);assert.equal(analyzeFinancialRows(q,[rows[0]!],catalog,result(q,[rows[0]!])).recurring!.length,0);
});
test('analysis options are closed, dates and ranges are actual calendars',()=>{
 for(const raw of [{sql:'select 1'},{topN:10000},{comparisonPeriod:{from:'2026-02-30',through:'2026-03-01'}},{reductionPercent:101}])assert.throws(()=>parseAnalysisOptions(raw));
});
test('zero-rate inverse credit, payoff term, goal and reserve have independent numerical goldens',()=>{
 let r=calculateFinancial({kind:'loan_capacity',monthlyPaymentRubles:'100',annualRatePercent:'0',months:12});assert.ok('metrics'in r);assert.ok(BigInt(r.metrics[0]!.value)>=120000n);assert.ok(BigInt(r.metrics[0]!.value)<120006n);
 r=calculateFinancial({kind:'loan_term',principalRubles:'1200',annualRatePercent:'0',monthlyPaymentRubles:'100'});assert.ok('metrics'in r);assert.equal(r.metrics[0]!.value,'12');assert.equal(r.rows.at(-1)!.closingMinor,'0');
 r=calculateFinancial({kind:'savings_goal',targetRubles:'1200',initialRubles:'0',annualRatePercent:'0',months:12});assert.ok('metrics'in r);assert.equal(r.metrics[1]!.value,'10000');assert.equal(r.metrics[3]!.value,'120000');
 r=calculateFinancial({kind:'goal_term',targetRubles:'1200',initialRubles:'0',annualRatePercent:'0',monthlyAdditionRubles:'100'});assert.ok('metrics'in r);assert.equal(r.metrics[2]!.value,'12');
 r=calculateFinancial({kind:'reserve',monthlyExpensesRubles:'40000',reserveMonths:6,availableRubles:'50000'});assert.ok('metrics'in r);assert.equal(r.metrics[0]!.value,'24000000');assert.equal(r.metrics[2]!.value,'19000000');
});
test('impossible debt and accumulation scenarios require changed parameters',()=>{
 assert.throws(()=>calculateFinancial({kind:'loan_term',principalRubles:'100000',annualRatePercent:'12',monthlyPaymentRubles:'1000'}),/BELOW_INTEREST/);
 assert.throws(()=>calculateFinancial({kind:'goal_term',targetRubles:'1000',initialRubles:'0',annualRatePercent:'0',monthlyAdditionRubles:'0'}),/GOAL_NOT_REACHED/);
});
test('refinancing includes fees and affordability preserves reserve constraints',()=>{
 let r=calculateFinancial({kind:'refinance',principalRubles:'100000',currentRatePercent:'12',currentMonths:12,newRatePercent:'12',newMonths:12,upfrontFeesRubles:'1000'});assert.ok('metrics'in r);assert.equal(r.metrics[3]!.value,'-100000');
 r=calculateFinancial({kind:'affordability',priceRubles:'10000',availableRubles:'20000',monthlyIncomeRubles:'30000',monthlyExpensesRubles:'31000',reserveRubles:'10000',months:3});assert.ok('metrics'in r);assert.equal(r.rows.at(-1)!.closingMinor,'700000');assert.ok(r.assumptions.some(a=>a.includes('нарушается')));
});
test('new personal rule resolves only owner names, has future-only effect, rejects arbitrary IDs',()=>{
 const c={...catalog,rules:[],budgets:[]},options={newId:randomUUID(),sourceAnswerId:null,parseRubles:calculatorRublesMinor};
 const p=compileAssistantChange({kind:'create_rule',name:'Кафе',conditions:{merchantEquals:'Restopay'},assignments:{categoryName:'Кафе',role:'expense'}},c,options);assert.equal(p.intent.kind,'rule');assert.equal((p.intent.patch as any).assignments.categoryId,cat);assert.equal(p.intent.create,true);assert.equal(p.sourceAnswerId,null);
 assert.throws(()=>parseAssistantChange({kind:'create_rule',name:'x',conditions:{},assignments:{role:'expense'}}));assert.throws(()=>parseAssistantChange({kind:'create_rule',name:'x',conditions:{accountId:randomUUID()},assignments:{role:'expense'}}));
});
test('new budget uses stable category ID and authorized profile timezone',()=>{
 const p=compileAssistantChange({kind:'create_budget',name:'Кафе в месяц',amountRubles:'5000',period:'month',basis:'net',categoryName:'Кафе'},{...catalog,rules:[],budgets:[]},{newId:randomUUID(),sourceAnswerId:null,parseRubles:calculatorRublesMinor,timezone:'Asia/Vladivostok'});assert.equal(p.intent.kind,'save_budget');assert.equal(p.intent.limitMinor,'500000');assert.equal((p.intent.definition as any).timezone,'Asia/Vladivostok');assert.deepEqual((p.intent.definition as any).filter.categoryIds,[cat]);
});

 test('inverse credit never exceeds the requested payment, including the final rounding',()=>{
  for(const months of [3,12,120])for(const annualRatePercent of ['0','12']){const r=calculateFinancial({kind:'loan_capacity',monthlyPaymentRubles:'100',annualRatePercent,months});assert.ok('scenarios'in r);const loan=r.scenarios![0]!;assert.equal(loan.kind,'loan');if(loan.kind==='loan')assert.ok(loan.rows.every(row=>BigInt(row.paymentMinor)<=10000n));}
 });

test('dependency closure covers reverse chains, cycles and disconnected data',async()=>{
 const {connectedDependencies}=await import('../src/dependencies.ts');const links=Array.from({length:10000},(_,i)=>({source_id:String(i+1),target_id:String(i)}));links.push({source_id:'7',target_id:'5'},{source_id:'foreign',target_id:'unrelated'});assert.equal(connectedDependencies(['0'],links).length,10001);assert.deepEqual(connectedDependencies(['unknown'],links),['unknown']);
});

test('investment growth and loss preserve fees as exact explicit scenario costs',()=>{
 const r=calculateFinancial({kind:'investment_change',initialRubles:'1000',changePercent:'-50',feesRubles:'10'});assert.ok('metrics'in r);assert.equal(r.metrics[2]!.value,'50000');assert.equal(r.metrics[4]!.value,'49000');assert.equal(r.metrics[5]!.value,'-51000');assert.equal(r.metrics[1]!.unit,'percent');assert.throws(()=>calculateFinancial({kind:'investment_change',initialRubles:'1000',changePercent:'-101',feesRubles:'0'}));
});
test('provided progressive tax rules calculate only their stated taxable base',()=>{
 const r=calculateFinancial({kind:'tax_by_rules',incomeRubles:'1000',exemptionRubles:'100',rounding:'kopeck',bands:[{upToRubles:'500',ratePercent:'10'},{upToRubles:null,ratePercent:'20'}]});assert.ok('metrics'in r);assert.equal(r.metrics[2]!.value,'90000');assert.equal(r.metrics[3]!.value,'13000');assert.throws(()=>calculateFinancial({kind:'tax_by_rules',incomeRubles:'1000',exemptionRubles:'0',rounding:'ruble',bands:[{upToRubles:'500',ratePercent:'10'}]}),/BANDS_INCOMPLETE/);
});
test('insurance scenarios distinguish conditional and unconditional deductibles',()=>{
 const base={kind:'insurance_case',premiumRubles:'500',insuredLimitRubles:'20000',deductibleRubles:'1000',lossRubles:'10000'};
 const a=calculateFinancial({...base,deductibleKind:'conditional'}),b=calculateFinancial({...base,deductibleKind:'unconditional'});assert.ok('metrics'in a&&'metrics'in b);assert.equal(a.metrics[1]!.value,'1000000');assert.equal(b.metrics[1]!.value,'900000');assert.equal(a.metrics[4]!.value,'50000');assert.equal(b.metrics[4]!.value,'150000');
});
test('irregular savings never manufacture contributions in missing months',()=>{
 const r=calculateFinancial({kind:'savings_schedule',initialRubles:'0',annualRatePercent:'0',months:3,targetRubles:'1000',additions:[{month:1,amountRubles:'100'},{month:3,amountRubles:'200'}]});assert.ok('metrics'in r);assert.equal(r.metrics[2]!.value,'30000');assert.equal(r.metrics[3]!.value,'70000');assert.equal(r.rows[1]!.amountMinor,'0');assert.equal(r.rows[2]!.closingMinor,'30000');
});
test('management resolves exact owned IDs and refuses implicit category loss',()=>{
 const c={...catalog,rules:[],budgets:[]},options={newId:randomUUID(),sourceAnswerId:null,parseRubles:calculatorRublesMinor};assert.throws(()=>compileAssistantChange({kind:'manage',entity:'category',action:'delete',name:'Кафе'},c,options),/NEEDS_CHOICE/);const p=compileAssistantChange({kind:'manage',entity:'category',action:'delete',name:'Кафе',replacementName:null},c,options);assert.equal(p.intent.kind,'delete_category');assert.equal(p.intent.id,cat);assert.equal(p.intent.replacementId,null);
});
test('remembering a bank identity is server-only and cannot be supplied by model',()=>{
 const c={...catalog,rules:[],budgets:[]},options={newId:randomUUID(),sourceAnswerId:randomUUID(),parseRubles:calculatorRublesMinor};const change={kind:'remember_answer',name:'Мой перевод',assignments:{kind:'own_transfer',role:'neutral'}};assert.throws(()=>compileAssistantChange(change,c,options));const p=compileAssistantChange(change,c,{...options,rememberConditions:{bankCounterpartyId:randomUUID()}});assert.equal(p.intent.kind,'rule');assert.equal((p.intent.patch as any).assignments.role,'neutral');assert.throws(()=>parseAssistantChange({...change,conditions:{bankCounterpartyId:randomUUID()}}));
});

test('bank clock filters preserve overnight windows, weekdays and unknown clocks without invented timezones',()=>{
 const a=row('-10000','expense','2026-11-16'),b=row('-20000','expense','2026-11-17'),c=row('-30000','expense','2026-11-18'),unknown=row('-40000','expense','2026-11-16');a.date={precision:'day',date:'2026-11-16',time:'23:30:00'};b.date={precision:'day',date:'2026-11-17',time:'02:00:00'};c.date={precision:'day',date:'2026-11-18',time:'14:00:00'};
 const q=query({filter:{timeFrom:'22:00',timeThrough:'06:00'}}),r=result(q,[a,b,c,unknown]),v=analyzeFinancialRows(q,[a,b,c,unknown],catalog,r);assert.equal(v.sum,'30000');assert.equal(v.missingTemporalCount,1);
 const monday=query({filter:{weekdays:[1],timeFrom:'22:00'}});assert.equal(result(monday,[a,b,c,unknown]).totals.expenses,'10000');
 const posted=query({filter:{calendarBasis:'posted',weekdays:[2]}});a.postedDate={precision:'day',date:'2026-11-17'};assert.equal(result(posted,[a,b]).totals.expenses,'10000');
 assert.throws(()=>parseTool({...q,filter:{timeFrom:'25:00'}}));assert.throws(()=>parseTool({...q,filter:{weekdays:[7]}}));
});
