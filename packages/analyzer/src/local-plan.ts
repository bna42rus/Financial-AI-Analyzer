/** Bounded read grammar. Unknown words/conditions always fall through to AI.
 * Uses the same compiler, ownership guards and exact calculation as AI plans. */
import {assistantVersion,parseAssistantPlan} from './assistant-plan.ts';
import type {AssistantPlan,Calendar} from './assistant-plan.ts';
import type {Conversation} from './assistant-conversation.ts';
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

/** A single unambiguous payment-type choice needs no model to copy numbers. */
export function localCalculatorPlan(question:string,state:Conversation):AssistantPlan|null{
 const text=question.normalize('NFKC').toLocaleLowerCase('ru').replaceAll('ё','е').replace(/[?.!]+$/u,'').trim().replace(/^(?:а|и|тогда)\s+/u,'');
 const last=state.turns.findLast(t=>t.status==='query'||t.calculation||t.report?.request.steps.some(s=>s.kind==='calculate'));
 if(!last||last.status==='query'&&!last.report?.request.steps.some(s=>s.kind==='calculate'))return null;
 const inputs=last.calculation?[last.calculation]:last.report?.request.steps.filter(s=>s.kind==='calculate').map(s=>s.calculation)??[];
 const loans=inputs.filter((c):c is import('./calculators.ts').LoanInput=>c.kind==='loan');if(!loans.length)return null;
 const distance=(a:string,b:string)=>{let p=Array.from({length:b.length+1},(_,i)=>i);for(let i=1;i<=a.length;i++){const n=[i];for(let j=1;j<=b.length;j++)n[j]=Math.min(n[j-1]!+1,p[j]!+1,p[j-1]!+Number(a[i-1]!==b[j-1]));p=n;}return p[b.length]!;};
 if(!/^[а-я]{7,24}$/u.test(text))return null;
 const payment=distance(text,'аннуитетный')<=3?'annuity':distance(text,'дифференцированный')<=3?'differentiated':null;if(!payment)return null;
 const signature=(c:typeof loans[number])=>JSON.stringify(Object.fromEntries(Object.entries(c).filter(([k])=>k!=='payment').sort(([a],[b])=>a.localeCompare(b))));
 if(loans.some(c=>signature(c)!==signature(loans[0]!)))return null;
 return parseAssistantPlan({version:assistantVersion,topic:'general_finance',action:'calculate',calculation:{...loans[0],payment}});
}
