/** Small synthetic understanding pilot. Expected outcomes never enter model input. */
import {calculatorRublesMinor} from '../calculators.ts';
import type {Preparation,Outcome} from './tasks.ts';
export {understandingSchema as pilotSchema,understandingPrompt as pilotPrompt} from './understanding.ts';
export const pilotCases=[
 {id:'loan-new',chain:'loan',question:'Посчитай кредит: беру 300 тысяч, ставка 19% в год, вернуть за три года.'},
 {id:'loan-concept',chain:'loan',question:'А что значит аннуитетный и дифференцированный, где это у себя посмотреть?'},
 {id:'loan-choice',chain:'loan',question:'У меня дифференцированный, посчитай.'},
 {id:'loan-switch',chain:'loan',question:'А ануитентный?'},
 {id:'loan-cheaper',chain:'loan',question:'Какой из этих двух дешевле по переплате?'},
 {id:'read-new',chain:'read',question:'Покажи расходы за октябрь 2025 по категориям.'},
 {id:'read-month',chain:'read',question:'А сентябрь?'},
 {id:'read-compare',chain:'read',question:'Сопоставь эти месяцы: в какой категории прибавилось больше всего?'},
] as const;
export type PilotId=typeof pilotCases[number]['id'];
const validLoan=(inputs:{principalRubles:string;annualRatePercent:string;months:number;prepayments?:unknown[];rateChanges?:unknown[]}[])=>inputs.every(v=>calculatorRublesMinor(v.principalRubles)==='30000000'&&calculatorRublesMinor(v.annualRatePercent)==='1900'&&v.months===36&&!(v.prepayments?.length)&&!(v.rateChanges?.length));
export function pilotPreparationMatches(id:PilotId,p:Preparation):boolean{
 if(id==='loan-concept')return p.status==='explanation'&&p.subject.kind==='concept';
 if(p.status!=='ready')return false;const t=p.task;
 if(id.startsWith('loan-')){
  if(id==='loan-cheaper')return t.kind==='loan_comparison'&&t.criterion==='interest'&&t.objective==='min'&&t.inputs.length===2&&new Set(t.inputs.map(v=>v.payment)).size===2&&validLoan(t.inputs);
  if(t.kind!=='loan'||!validLoan(t.inputs))return false;
  return id==='loan-new'?t.inputs.length===2:t.inputs.length===1&&t.inputs[0]?.payment===(id==='loan-choice'?'differentiated':'annuity');
 }
 if(t.kind!=='read')return false;const q=t.node.query;
 if(Object.keys(q.filter).some(k=>!['from','through','accountIds'].includes(k))||q.options?.dateBasis==='posted'||q.options?.weekdays?.length||q.options?.clock||q.options?.purpose&&q.options.purpose!=='summary')return false;
 if(q.metric!=='expenses'||q.grouping!=='category'||q.options?.statistic&&q.options.statistic!=='sum')return false;
 const expected=id==='read-month'?'09':'10';
 if(q.filter.from!==`2025-${expected}-01`||q.filter.through!==`2025-${expected}-${expected==='09'?'30':'31'}`)return false;
 return id==='read-compare'?q.comparison==='custom'&&q.options?.comparisonPeriod?.from==='2025-09-01'&&q.options?.comparisonPeriod?.through==='2025-09-30':q.comparison==='none';
}
export function pilotOutcomeMatches(id:PilotId,outcome:Outcome):boolean{
 if(id==='loan-cheaper')return outcome.kind==='loan_comparison'&&outcome.winnerIndexes.every(i=>outcome.results[i]?.input.payment==='differentiated');
 if(id.startsWith('loan-'))return outcome.kind==='loan'&&outcome.results.every(v=>v.principalMinor==='30000000'&&v.rows.length===36);
 if(outcome.kind!=='read'||outcome.result.totals.expenses!==(id==='read-month'?'12000':'16800'))return false;
 if(id!=='read-compare')return true;
 const deltas=outcome.result.points.map(p=>({label:p.label,value:BigInt(p.values.expenses??'0')-BigInt(p.previous.expenses??'0')}));
 return outcome.result.previousTotals.expenses==='12000'&&deltas.length===2&&deltas.some(p=>p.label==='Продукты'&&p.value===5000n)&&deltas.some(p=>p.label==='Такси'&&p.value===-200n);
}
