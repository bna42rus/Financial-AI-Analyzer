/** Additional synthetic acceptance cases. Expectations never enter ProviderInput.
 * This is a development corpus, not a held-out benchmark or a runtime router. */
import {calculatorRublesMinor} from '../calculators.ts';
import type {LoanInput} from '../calculators.ts';
import type {OperationsFilter} from '../../../finance-core/src/operations.ts';
import type {Catalog} from '../yandex-contract.ts';
import type {Preparation,Outcome} from './tasks.ts';
import type {Understanding,TurnResult} from './workflow.ts';
type Filter=Omit<OperationsFilter,'accountIds'|'categoryIds'>&{categories?:string[]};
type Read={kind:'read';filter:Filter;grouping:'none'|'category';total:string;baseline?:{from:string;through:string;total:string};points?:Record<string,[string,string]>;objective?:'min'|'max'};
type Loan={kind:'loan'|'loan_comparison';principal:string;rate:string;months:number;payments:LoanInput['payment'][];chart?:true};
type Expected=Read|Loan|{kind:'explanation';concept:string}|{kind:'unrelated'|'ambiguous'};
export type AdditionalCase={id:string;chain:string;question:string;expected:Expected;ui?:{filter:Filter;revision:number}};
const sep={from:'2025-09-01',through:'2025-09-30'},oct={from:'2025-10-01',through:'2025-10-31'};
const rd=(filter:Filter,total:string,grouping:Read['grouping']='none'):Read=>({kind:'read',filter,grouping,total});
const ln=(principal:string,rate:string,months:number,payments:Loan['payments']=['annuity','differentiated']):Loan=>({kind:'loan',principal,rate,months,payments});
export const additionalCases:readonly AdditionalCase[]=[
 {id:'months-start',chain:'months',question:'Разложи траты за октябрь 2025 по категориям.',expected:rd(oct,'16800','category')},
 {id:'months-short',chain:'months',question:'Сентябрь.',expected:rd(sep,'12000','category')},
 {id:'months-growth',chain:'months',question:'Какая категория выросла сильнее между этими месяцами?',expected:{...rd(oct,'16800','category'),baseline:{...sep,total:'12000'},points:{'Продукты':['15000','10000'],'Такси':['1800','2000']},objective:'max'}},
 {id:'months-explicit-base',chain:'months',question:'Сравни сентябрь относительно октября 2025: покажи изменение по категориям.',expected:{...rd(sep,'12000','category'),baseline:{...oct,total:'16800'},points:{'Продукты':['10000','15000'],'Такси':['2000','1800']}}},
 {id:'months-current-ui',chain:'months',question:'Новый запрос: покажи расходы по категориям с текущими фильтрами.',ui:{filter:{...sep,categories:['Такси']},revision:1},expected:rd({...sep,categories:['Такси']},'2000','category')},
 {id:'filters-start',chain:'filters',question:'Покажи одной суммой траты за октябрь 2025 только в категории Продукты.',expected:rd({...oct,categories:['Продукты']},'15000')},
 {id:'filters-month',chain:'filters',question:'А сентябрь?',expected:rd({...sep,categories:['Продукты']},'10000')},
 {id:'filters-strict-money',chain:'filters',question:'больше 120 рублей',expected:rd({...sep,categories:['Продукты'],amountBasis:'absolute_operation',amountFrom:'12001'},'0')},
 {id:'filters-clear-money',chain:'filters',question:'Убери ограничение по сумме, остальное сохрани.',expected:rd({...sep,categories:['Продукты']},'10000')},
 {id:'filters-new-scope',chain:'filters',question:'Новая задача: все расходы за октябрь 2025 по категориям.',expected:rd(oct,'16800','category')},
 {id:'loan-two-variants',chain:'loan',question:'Нужны два варианта кредита: 240 тысяч под 12% годовых, срок 24 месяца.',ui:{filter:{...oct,categories:['Такси'],amountBasis:'absolute_operation',amountFrom:'99999999'},revision:0},expected:ln('240000','12',24)},
 {id:'loan-change-term',chain:'loan',question:'Срок сократи до 12 месяцев, остальное как было.',expected:ln('240000','12',12)},
 {id:'loan-zero-rate',chain:'loan',question:'Ставку теперь 0%, срок оставь.',expected:ln('240000','0',12)},
 {id:'loan-choice-short',chain:'loan',question:'Выбери аннуитетный.',expected:ln('240000','0',12,['annuity'])},
 {id:'loan-switch-typo',chain:'loan',question:'А дифиренцированный?',expected:ln('240000','0',12,['differentiated'])},
 {id:'loan-both-charts',chain:'loan',question:'Покажи оба графика платежей, не меняя условий.',expected:{...ln('240000','0',12),chart:true}},
 {id:'loan-tied-comparison',chain:'loan',question:'Какой из этих вариантов дешевле по переплате?',expected:{...ln('240000','0',12),kind:'loan_comparison'}},
 {id:'mixed-read',chain:'mixed',question:'Сколько расходов по категориям было в октябре 2025?',expected:rd(oct,'16800','category')},
 {id:'mixed-new-loan',chain:'mixed',question:'Теперь кредит: 100000 рублей, 10% годовых на 10 месяцев, аннуитетный.',expected:ln('100000','10',10,['annuity'])},
 {id:'mixed-back-to-read',chain:'mixed',question:'Вернись к отчёту о расходах; месяц замени на сентябрь.',expected:rd(sep,'12000','category')},
 {id:'mixed-back-to-loan',chain:'mixed',question:'Вернись к расчёту кредита и покажи график ежемесячных платежей.',expected:{...ln('100000','10',10,['annuity']),chart:true}},
 {id:'mixed-concept',chain:'mixed',question:'Что означает аннуитетный?',expected:{kind:'explanation',concept:'аннуитет'}},
 {id:'mixed-rate-after-concept',chain:'mixed',question:'Теперь ставку 0%, остальное прежнее.',expected:ln('100000','0',10,['annuity'])},
 {id:'boundary-unrelated',chain:'unrelated',question:'Напиши стихотворение про снег.',expected:{kind:'unrelated'}},
 {id:'boundary-ambiguous',chain:'ambiguous',question:'Сколько?',expected:{kind:'ambiguous'}},
];
function canonical(v:unknown):string{return JSON.stringify(v,(_key,value)=>value&&typeof value==='object'&&!Array.isArray(value)?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b))):value);}
export function additionalFilter(filter:Filter,catalog:Catalog):OperationsFilter{
 const {categories,...rest}=filter;
 if(catalog.accounts.length!==1)throw Error('PILOT_SYNTHETIC_CATALOG_REQUIRED');
 const categoryIds=categories?.map(name=>{const found=catalog.categories.filter(v=>v.name===name&&!v.parentId);if(found.length!==1)throw Error('PILOT_SYNTHETIC_CATALOG_REQUIRED');return found[0]!.id;});
 return {accountIds:[catalog.accounts[0]!.id],...rest,...(categoryIds?{categoryIds}:{})};
}
function loanInputsMatch(e:Loan,inputs:LoanInput[]):boolean{
 return inputs.length===e.payments.length&&canonical(inputs.map(v=>v.payment).sort())===canonical([...e.payments].sort())&&inputs.every(v=>
  calculatorRublesMinor(v.principalRubles)===calculatorRublesMinor(e.principal)&&calculatorRublesMinor(v.annualRatePercent)===calculatorRublesMinor(e.rate)&&v.months===e.months&&!v.prepayments?.length&&!v.rateChanges?.length);
}
export function additionalPreparationMatches(c:AdditionalCase,p:Preparation|null,reply:Understanding,catalog:Catalog):boolean{
 const e=c.expected;
 if(e.kind==='unrelated'||e.kind==='ambiguous')return reply.relevance===e.kind&&reply.intent===null&&p===null;
 if(!reply.intent||!p)return false;
 if(e.kind==='explanation')return p.status==='explanation'&&p.subject.kind==='concept'&&p.subject.question.toLocaleLowerCase('ru-RU').includes(e.concept);
 if(p.status!=='ready')return false;
 const t=p.task;
 if(e.kind==='read'){
  if(t.kind!=='read')return false;const q=t.node.query,options={...q.options};delete options.comparisonPeriod;
  if(e.objective&&(reply.intent.action!=='compare'||reply.intent.parameters.criterion!=='value'||reply.intent.parameters.objective!==e.objective))return false;
  if(options.statistic==='sum')delete options.statistic;if(options.purpose==='summary')delete options.purpose;if(options.dateBasis==='operation')delete options.dateBasis;
  return q.metric==='expenses'&&q.grouping===e.grouping&&q.comparison===(e.baseline?'custom':'none')&&canonical(q.filter)===canonical(additionalFilter(e.filter,catalog))&&!Object.keys(options).length&&
   canonical(q.options?.comparisonPeriod??null)===canonical(e.baseline?{from:e.baseline.from,through:e.baseline.through}:null);
 }
 if(t.kind!==e.kind||!loanInputsMatch(e,t.inputs))return false;
 if(t.kind==='loan_comparison'&&(t.criterion!=='interest'||t.objective!=='min'))return false;
 return !e.chart||t.presentation.format==='chart';
}
export function additionalOutcomeMatches(c:AdditionalCase,result:TurnResult):boolean{
 const e=c.expected;
 if(e.kind==='unrelated'||e.kind==='ambiguous'||e.kind==='explanation')return result.status===e.kind;
 if(result.status!=='completed')return false;const o:Outcome=result.outcome;
 if(e.kind==='read')return o.kind==='read'&&o.result.totals.expenses===e.total&&(!e.baseline||o.result.previousTotals.expenses===e.baseline.total)&&(!e.points||canonical(Object.fromEntries(o.result.points.map(p=>[p.label,[p.values.expenses??'0',p.previous.expenses??'0'] ])))===canonical(e.points));
 if(o.kind!==e.kind||!loanInputsMatch(e,o.results.map(v=>v.input)))return false;
 if(!o.results.every(v=>v.rows.length===e.months&&v.principalMinor===calculatorRublesMinor(e.principal)&&BigInt(v.totalPaidMinor)===BigInt(v.principalMinor)+BigInt(v.interestMinor)&&
  v.rows.reduce((sum,row)=>sum+BigInt(row.principalMinor),0n)===BigInt(v.principalMinor)&&v.rows.reduce((sum,row)=>sum+BigInt(row.interestMinor),0n)===BigInt(v.interestMinor)&&
  (e.rate!=='0'||v.interestMinor==='0'&&v.rows.every(row=>row.interestMinor==='0'))))return false;
 return o.kind!=='loan_comparison'||canonical([...o.winnerIndexes].sort())===canonical(e.payments.map((_v,i)=>i))&&o.deltasFromFirstMinor.every(v=>v==='0');
}
