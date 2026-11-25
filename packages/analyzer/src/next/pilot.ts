/** Small synthetic understanding pilot. Expected outcomes never enter model input. */
import {calculatorRublesMinor} from '../calculators.ts';
import {intentSchema} from './intent.ts';
import type {Preparation,Outcome} from './tasks.ts';
const variants=(intentSchema as any).anyOf.filter((s:any)=>['read','calculate','compare','explain'].includes(s.properties.action.enum[0])).map((s:any)=>structuredClone(s));
for(const schema of variants)if(schema.properties.action.enum[0]==='calculate')schema.properties.parameters.anyOf=schema.properties.parameters.anyOf.filter((v:any)=>v.properties.calculator.enum[0]==='loan');
export const pilotSchema={anyOf:[
 {type:'object',additionalProperties:false,required:['relevance','intent'],properties:{relevance:{type:'string',enum:['financial','adjacent']},intent:{anyOf:variants}}},
 {type:'object',additionalProperties:false,required:['relevance','intent'],properties:{relevance:{type:'string',enum:['ambiguous','unrelated']},intent:{type:'null'}}},
]};
export const pilotPrompt=`Ты финансовый помощник CashNeuro. Верни только JSON по схеме: relevance и intent. Не считай деньги самостоятельно.
Оболочка intent обязательна для каждого действия: version, action, binding, parameters, presentation. Новая тема: binding mode=new. Продолжение: mode=continue, conditions=merge_ui; явно прежние условия: conditions=pin. На уточнение отвечай через mode=answer и выданный handle, option=null.
Извлекай только новые условия текущей реплики, остальные восстановит сервер. Кредит: calculator=loan; edits задают field/op/value/quote. quote — точная подстрока question. Тысячи/миллионы переводи в десятичные рубли, годы в целые месяцы, ставку — в годовые проценты. Неизвестные существенные значения не выдумывай. Не выбран тип платежа — сервер покажет оба; не задавай ненужную анкету. Смена payment сохраняет сумму/ставку/срок. Явные «оба типа» снимают выбор payment через clear.
Вопрос о значении термина — explain concept, он сохраняет расчёт. Короткий выбор типа с опечаткой — calculate продолжение. «Что выгоднее» — compare с доступными handles конкретных вариантов, criterion=interest, objective=min, а не определение термина.
Read: metric/grouping/comparison=null сохраняют прежнее значение. Для периода используй точную expression из question, без скопированных условий. Один месяц без года в продолжении сохраняет год исходного периода. «По категориям» означает grouping=category. Сравнение месяцев: compare criterion=value; scenarios=[база, новый период]. Если порядок не задан, база — более ранний месяц. Не объединяй несовместимые области. UUID и SQL не выдумывай. Ответ unrelated/ambiguous: intent=null. Неизвестный параметр или отрицание нельзя молча отбрасывать.`;
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
