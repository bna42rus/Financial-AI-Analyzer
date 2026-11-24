/** Bounded read grammar. Unknown words/conditions always fall through to AI.
 * Uses the same compiler, ownership guards and exact calculation as AI plans. */
import {assistantVersion,parseAssistantPlan} from './assistant-plan.ts';
import type {AssistantPlan,Calendar} from './assistant-plan.ts';
import type {Conversation} from './assistant-conversation.ts';
import {calculatorRublesMinor} from './calculators.ts';
import type {LoanInput} from './calculators.ts';
const month='(?:январ[ьяе]|феврал[ьяе]|март[ае]?|апрел[ьяе]|ма[йяе]|июн[ьяе]|июл[ьяе]|август[ае]?|сентябр[ьяе]|октябр[ьяе]|ноябр[ьяе]|декабр[ьяе])';
const period='(?:'+month+'(?: (?:20\\d{2})(?: года)?)?|сегодня|вчера|(?:прошлый|предыдущий|текущий|этот) месяц|(?:прошлую|предыдущую|текущую|эту) неделю|(?:прошлый|предыдущий|текущий|этот) год|последние \\d{1,3} (?:дня|дней|месяца|месяцев)|выбранный период|этот период)';
const dateOnly=new RegExp('^(?:а |и )?(?:за|в) ('+period+')$','u');
const grouped=/^(?:а |и )?(?:(?:разбей|покажи|раздели) )?по (категориям|подкатегориям|счетам|банкам|магазинам|месяцам)$/u;
const comparison=/^(?:(?:а |и )?сравни (?:эти |последние )?(?:два |оба )?(?:месяца|периода|их|их между собой))(?:[.,;]? (?:где|в каких категориях) (?:(?:расходы|траты) (?:выросли|увеличились)|(?:выросли|увеличились) (?:расходы|траты))(?: (?:сильнее|больше) всего)?)?$/u;
const standalone=new RegExp('^(?:(сколько я (?:потратил[а]?|заработал[а]?)|(?:покажи |посчитай )?(?:мои )?(?:расходы|траты|доходы))(?: (?:за|в) ('+period+'))?(?: по (категориям|подкатегориям|счетам|банкам|магазинам|месяцам))?)$','u');
const groups:Record<string,string>={категориям:'category_totals',подкатегориям:'subcategory',счетам:'account',банкам:'bank',магазинам:'merchant',месяцам:'time'};
export function localReadPlan(question:string,state:Conversation,_calendar:Calendar):AssistantPlan|null{
 const text=question.normalize('NFKC').toLocaleLowerCase('ru').replaceAll('ё','е').replace(/\s+/gu,' ').replace(/[?.!]+$/u,'').trim();
 const full=standalone.exec(text);
 const make=(context:unknown,changes:unknown[])=>parseAssistantPlan({version:assistantVersion,topic:'personal_finance',action:'read',context,changes});
 const set=(field:string,value:unknown)=>({field,op:'set',value});
 if(full){const metric=/доход|заработ/iu.test(full[1]!)?'income':'expenses',p=full[2];return make({mode:'new'},[set('metric',metric),set('grouping',full[3]?groups[full[3]]:'total'),set('comparison','none'),...(p&&!['выбранный период','этот период'].includes(p)?[set('period',p)]:[{field:'period',op:'use_current'}])]);}
 const latest=state.turns.findLast(t=>t.status==='query'||t.calculation||t.report?.request.steps.some(s=>s.kind==='calculate'));
 if(latest?.status!=='query'||latest.calculation||latest.report?.request.steps.some(s=>s.kind==='calculate'))return null;
 const pending=state.turns.find(t=>t.messageId===state.pendingMessageId);
 if(pending){const p=pending.question.toLocaleLowerCase('ru').replace(/[?.!]+$/u,'').trim();if(!dateOnly.test(p)&&!grouped.test(p)&&!comparison.test(p)&&!standalone.test(p))return null;}
 const date=dateOnly.exec(text);if(date){const p=date[1]!;if(['выбранный период','этот период'].includes(p))return make({mode:'continue'},[{field:'period',op:'use_current'}]);const year=state.book.nodes.at(-1)?.query.filter.from?.slice(0,4),literal=new RegExp('^'+month+'$','u').test(p)&&year?p+' '+year:p;return make({mode:'continue'},[set('period',literal)]);}
 const group=grouped.exec(text);if(group)return make({mode:'continue'},[set('grouping',groups[group[1]!])]);
 if(comparison.test(text)){
  const head=state.book.nodes.at(-1)!;
  const signature=(n:typeof head)=>JSON.stringify([n.query.metric,Object.entries(n.query.filter).filter(([k])=>!['from','through'].includes(k)).sort(([a],[b])=>a.localeCompare(b))]);
  const candidates=state.book.nodes.slice(-8).filter(n=>n.query.filter.from&&n.query.filter.through&&signature(n)===signature(head)).reverse();
  const first=candidates[0],second=first&&candidates.find(n=>n.query.filter.from!==first.query.filter.from||n.query.filter.through!==first.query.filter.through);if(!first||!second)return null;
  const [current,previous]=first.query.filter.from!>second.query.filter.from!?[first,second]:[second,first];
  const ref=(id:string)=>'h'+(state.turns.findIndex(t=>t.messageId===id)+1);
  return make({mode:'reference',reference:ref(current.messageId),comparisonReference:ref(previous.messageId)},[]);
 }
 return null;
}

const folded=(s:string)=>s.normalize('NFKC').toLocaleLowerCase('ru').replaceAll('ё','е').replace(/\s+/gu,' ').replace(/[?.!]+$/u,'').trim();
const distance=(a:string,b:string)=>{let p=Array.from({length:b.length+1},(_,i)=>i);for(let i=1;i<=a.length;i++){const n=[i];for(let j=1;j<=b.length;j++)n[j]=Math.min(n[j-1]!+1,p[j]!+1,p[j-1]!+Number(a[i-1]!==b[j-1]));p=n;}return p[b.length]!;};
function paymentWord(s:string):LoanInput['payment']|null{
 if(!/^[а-я]{7,24}$/u.test(s))return null;
 return distance(s,'аннуитетный')<=3?'annuity':distance(s,'дифференцированный')<=3?'differentiated':null;
}
function loanPlan(loans:LoanInput[]):AssistantPlan{
 const label=(c:LoanInput)=>c.payment==='annuity'?'Аннуитетный платёж':'Дифференцированный платёж';
 return parseAssistantPlan(loans.length===1?{version:assistantVersion,topic:'general_finance',action:'calculate',calculation:loans[0]}:{version:assistantVersion,topic:'general_finance',action:'report',report:{steps:[...loans.map(calculation=>({kind:'calculate',label:label(calculation),calculation})),{kind:'derive',label:'Разница процентов: аннуитетный минус дифференцированный',operation:'difference',left:'s1.interest',right:{ref:'s2.interest'}}]}});
}
/** A model must not silently choose a payment type for a new loan. Existing
 * checked inputs or an explicit type in the current request establish it. */
export function completeLoanPayment(plan:AssistantPlan,question:string,state:Conversation):AssistantPlan{
 if(plan.action!=='calculate'||plan.calculation?.kind!=='loan')return plan;
 if(/аннуит|дифференц|равн(?:ые|ыми) платеж|фиксированн|постоянн(?:ый|ым) платеж/iu.test(question)||folded(question).split(/[^а-я]+/u).some(w=>paymentWord(w)))return plan;
 const loan=plan.calculation;
 const latest=state.turns.findLast(t=>t.status==='query'||t.calculation||t.report?.request.steps.some(s=>s.kind==='calculate'));
 const known=latest?.calculation?[latest.calculation]:latest?.report?.request.steps.flatMap(s=>s.kind==='calculate'?[s.calculation]:[])??[];
 if(known.length===1&&known[0]?.kind==='loan'&&known[0].payment===loan.payment&&!/новый кредит|другой кредит/iu.test(question))return plan;
 return loanPlan([{...loan,payment:'annuity'},{...loan,payment:'differentiated'}]);
}

/** Recover a derive-only continuation that used the immediately preceding
 * report's local fact references. Recalculate its checked inputs in this report;
 * never accept a dangling reference or copy results from another scope. */
export function restoreReportDependencies(raw:unknown,state:Conversation):unknown{
 if(!raw||typeof raw!=='object')return raw;
 const candidate=raw as AssistantPlan,steps=candidate.report?.steps;
 const last=state.turns.findLast(t=>t.status==='query'||t.calculation||t.report?.request.steps.some(s=>s.kind==='calculate'));
 if(candidate.action!=='report'||!steps?.length||steps.some(s=>s.kind!=='derive')||!last?.report)return raw;
 const refs=steps.flatMap(s=>s.kind==='derive'?[s.left,...('ref'in s.right?[s.right.ref]:[])]:[]);
 if(!refs.length||refs.some(ref=>!last.report!.facts.some(f=>f.ref===ref)))return raw;
 const count=Math.max(...refs.map(ref=>Number(/^s([1-5])\./u.exec(ref)?.[1]??0)));
 const prefix=last.report.request.steps.slice(0,count);
 if(!count||count+steps.length>5||prefix.length!==count||prefix.some(s=>s.kind!=='calculate'))return raw;
 return {...candidate,report:{...candidate.report,steps:[...prefix,...steps]}};
}
/** Complete, bounded loan input. Unknown conditions go to the normal planner.
 * No payment type is assumed: show both schedules when it was not specified. */
export function localLoanPlan(question:string):AssistantPlan|null{
 let text=folded(question);
 const principal=/^(?:(?:рассчитай|посчитай) )?(?:мне )?кредит ([0-9][0-9 ]*(?:[.,][0-9]{1,2})?)\s*(тыс(?:яч[аиу]?)?\.?|к|млн\.?|миллион(?:а|ов)?)?\s*(?:рублей|рубля|руб\.?|₽)?\s*/u.exec(text);
 if(!principal)return null;text=text.slice(principal[0].length);
 const rate=/(?:под|ставка|со ставкой) ([0-9]+(?:[.,][0-9]{1,2})?)\s*%\s*(?:годовых)?/u.exec(text);
 const term=/(?:на|срок(?:ом)?) ([0-9]{1,3}) (лет|года?|месяц(?:а|ев)?)/u.exec(text);
 if(!rate||!term)return null;
 text=text.replace(rate[0],' ').replace(term[0],' ').replace(/[.,;:?！!]/gu,' ').replace(/\s+/gu,' ').trim();
 text=text.replace(/^(?:сколько (?:платить|платеж|в месяц платеж будет)(?: в месяц)?|какой (?:ежемесячный )?платеж|рассчитай платеж)$/u,'').trim();
 const payment=text?paymentWord(text):null;if(text&&!payment)return null;
 try{
  const scale=principal[2]?.startsWith('м')?1000000n:principal[2]?1000n:1n;
  const minor=BigInt(calculatorRublesMinor(principal[1]!.trim()))*scale;
  const input:LoanInput={kind:'loan',principalRubles:(minor/100n)+'.'+(minor%100n).toString().padStart(2,'0'),annualRatePercent:rate[1]!.replace(',','.'),months:Number(term[1])*(term[2]!.startsWith('месяц')?1:12),payment:payment??'annuity'};
  return loanPlan(payment?[input]:[input,{...input,payment:'differentiated'}]);
 }catch{return null;}
}

/** Known scenario operations copy checked inputs, never model-generated numbers. */
export function localCalculatorPlan(question:string,state:Conversation):AssistantPlan|null{
 const text=folded(question).replace(/^(?:а|и|тогда)\s+/u,'');
 const last=state.turns.findLast(t=>t.status==='query'||t.calculation||t.report?.request.steps.some(s=>s.kind==='calculate'));
 if(!last||last.status==='query'&&!last.report?.request.steps.some(s=>s.kind==='calculate'))return null;
 if(last.report?.request.steps.some(s=>s.kind!=='calculate'&&s.kind!=='derive'))return null;
 const inputs=last.calculation?[last.calculation]:last.report?.request.steps.filter(s=>s.kind==='calculate').map(s=>s.calculation)??[];
 const loans=inputs.filter((c):c is LoanInput=>c.kind==='loan');if(!loans.length||inputs.length!==loans.length)return null;
 // A new pending request may refer to different conditions, even if an older
 // calculation exists. Let the full planner resolve it instead of skipping it.
 const pending=state.turns.find(t=>t.messageId===state.pendingMessageId);
 if(pending&&state.turns.indexOf(pending)>state.turns.indexOf(last)&&! /^(?:что|какой|какие|сравни|на сколько)/u.test(folded(pending.question)))return null;
 if(/^(?:что|какой(?: из (?:них|вариантов))?) (?:выгоднее|дешевле|лучше)(?: в итоге)?(?: и на сколько(?: рублей)?)?$/u.test(text)||/^(?:сравни (?:их|оба(?: варианта)?|эти варианты)|на сколько (?:они отличаются|отличаются платежи|разница))$/u.test(text)){
  if(loans.length!==2||loans[0]!.payment===loans[1]!.payment)return null;
  const ordered=[...loans].sort((a,b)=>a.payment===b.payment?0:a.payment==='annuity'?-1:1);
  if(calculatorRublesMinor(ordered[0]!.principalRubles)!==calculatorRublesMinor(ordered[1]!.principalRubles))return null;
  return loanPlan(ordered);
 }
 let rest=text,rate:string|undefined;
 rest=rest.replace(/(?:при ставке|со ставкой|ставка|ставку) ([0-9]+(?:[.,][0-9]{1,2})?)\s*%/u,(_m,n:string)=>{rate=n.replace(',','.');return ' ';});
 const selected=new Set<LoanInput['payment']>();
 rest=rest.replace(/[а-я]+/gu,w=>{const p=paymentWord(w);if(p){selected.add(p);return ' ';}return w;});
 const graph=/график|платежи|платежей/u.test(rest);
 rest=rest.replace(/(?:остальные )?условия (?:сохрани|те же)/gu,' ').replace(/основным долгом/gu,' ').replace(/основной долг/gu,' ').replace(/процентами|проценты/gu,' ')
  .replace(/(?:^| )(?:(?:покажи|рассчитай|посчитай|для|у|и|с|платеж|платежи|платежей|график|состав|оба|вида|варианта)(?: |$))+/gu,' ').replace(/[.,;:]/gu,' ').trim();
 if(rest||(!selected.size&&!rate&&!graph))return null;
 const signature=(c:typeof loans[number])=>JSON.stringify(Object.fromEntries(Object.entries(c).filter(([k])=>k!=='payment').sort(([a],[b])=>a.localeCompare(b))));
 if(loans.some(c=>signature(c)!==signature(loans[0]!)))return null;
 const payments=selected.size?[...selected]:[...new Set(loans.map(c=>c.payment))];
 try{return loanPlan(payments.sort((a,b)=>a===b?0:a==='annuity'?-1:1).map(payment=>({...loans[0]!,payment,...(rate?{annualRatePercent:rate}:{})})));}catch{return null;}
}
