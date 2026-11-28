/** Bounded source facts, never a relevance classifier or a permissive schema.
 * Server state is trusted only after the caller's scope/access checks. */
import {parseIntent} from './intent.ts';
import type {Intent,ConditionEdit} from './intent.ts';
import type {State,Environment,ReadTask} from './tasks.ts';
import type {Query} from '../registry.ts';
import {periodFacts,isCompletePeriodLiteral} from './period.ts';
import {hasExplicitComparisonBase,comparisonPeriodOrder} from './comparison-periods.ts';
const fold=(v:string)=>v.normalize('NFKC').toLocaleLowerCase('ru-RU').replaceAll('ё','е').trim();
const same=(a:unknown,b:unknown)=>stable(a)===stable(b);
function stable(v:unknown):string{return JSON.stringify(v,(_key,value)=>value&&typeof value==='object'&&!Array.isArray(value)?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b))):Array.isArray(value)?[...value].sort():value);}
function fail(code:string):never{throw new TypeError(code);}
function distance(a:string,b:string){
 const rows=Array.from({length:a.length+1},()=>Array<number>(b.length+1).fill(0));
 for(let i=0;i<=a.length;i++)rows[i]![0]=i;for(let j=0;j<=b.length;j++)rows[0]![j]=j;
 for(let i=1;i<=a.length;i++)for(let j=1;j<=b.length;j++){
  rows[i]![j]=Math.min(rows[i-1]![j]!+1,rows[i]![j-1]!+1,rows[i-1]![j-1]!+(a[i-1]===b[j-1]?0:1));
  if(i>1&&j>1&&a[i-1]===b[j-2]&&a[i-2]===b[j-1])rows[i]![j]=Math.min(rows[i]![j]!,rows[i-2]![j-2]!+1);
 }return rows[a.length]![b.length]!;
}
export function paymentChoice(question:string){
 const quote=question.trim().replace(/[?!.]+$/u,'').trim().replace(/^(?:(?:а|тогда|теперь|выбери|у меня)\s+)+/iu,''),word=fold(quote);
 if(!/^\p{L}{8,24}$/u.test(word))return null;
 const choices=[['annuity','аннуитетный'],['differentiated','дифференцированный']] as const;
 const matches=choices.filter(([,label])=>distance(word,label)<=2);
 return matches.length===1?{payment:matches[0]![0],quote}:null;
}
function nearestLoan(state:State){return [...state.history].reverse().find(t=>t.kind==='loan');}
function knownBinding(intent:Intent,state:State){
 const b=intent.binding;if(b.mode==='answer')return !!state.pending&&state.pending.handle===b.clarification&&b.option===null;
 if(b.mode!=='reference')return true;
 const m=/^(t[1-9][0-9]*)(?:_v([1-9][0-9]*))?$/.exec(b.handle),task=m&&state.history.find(t=>t.handle===m[1]);
 return !!task&&(!m![2]||task.kind==='loan'&&!!task.results[Number(m![2])-1]);
}
function chartWords(question:string):string[]|false{
 const text=fold(question).replace(/(?:,?\s+не\s+(?:меняя|изменяя)\s+(?:условий|параметров))[.!?]*$/u,''),words=text.match(/\p{L}+/gu)??[];
 if(!words.length||!/^[\p{L}\s.,?!;:—–-]+$/u.test(text))return false;
 const allowed=/^(?:вернись|вернитесь|верни|верните|возвратись|покажи|покажите|построй|постройте|к|и|по|для|того|этому|этого|сохраненному|сохраненного|прежнему|предыдущему|расчету|расчета|модели|модель|сценарию|сценария|кредита|кредиту|займа|займу|график|графики|графика|платежей|платежи|ежемесячных|ежемесячные|основного|основным|долга|долгом|процентов|процентами|оба|обоих|типов|типа|вместе|с)$/u;
 return words.every(w=>allowed.test(w))&&words.some(w=>/^график/u.test(w))&&(words.some(w=>/^(?:покажи|покажите|построй|постройте)$/u.test(w))||words[0]?.startsWith('график'))?words:false;
}
export function isLoanChartResume(question:string){
 const words=chartWords(question);
 return !!words&&words.some(w=>/^(?:расчету|расчета|модели|модель|сценарию|сценария)$/u.test(w))&&words.some(w=>/^(?:кредита|кредиту|займа|займу)$/u.test(w));
}
function chartTarget(question:string,state:State){
 const words=chartWords(question);if(!words)return null;
 const active=state.history.find(t=>t.handle===state.active),loan=isLoanChartResume(question)?nearestLoan(state):active?.kind==='loan'?active:null;
 const both=(words.includes('оба')||words.includes('обоих'))&&(words.some(w=>w==='типа'||w==='типов')||words.some(w=>w==='платежей'||w==='платежи')&&!words.some(w=>/^(?:долга|долгом|процентов|процентами)$/u.test(w)));
 return loan?{loan,both}:null;
}
function keys(value:unknown,allowed:string[]):value is Record<string,any>{return !!value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).every(k=>allowed.includes(k));}
function currentVariantQuestion(question:string){
 const text=fold(question),words=text.match(/\p{L}+/gu)??[];
 if(!/^[\p{L}\s.,?!;:—–-]+$/u.test(text)||!/(?:из этих(?: двух)?|эти(?: два)?|оба) вариант(?:а|ов|ы)/u.test(text))return false;
 return words.every(w=>/^(?:а|тогда|теперь|какой|какие|который|что|из|этих|эти|два|двух|оба|обоих|вариант|варианта|вариантов|варианты|дешевле|выгоднее|дороже|лучше|самый|дешевый|дорогой|сравни|сравните|по|в|итоге|будет|с|и|меньше|больше|меньшей|большей|минимальной|максимальной|наименьшей|наибольшей|переплата|переплате|переплатой|проценты|процентам|процентов|общей|сумме|выплат|платежу|платеж|платежей)$/u.test(w));
}
/** Resolve a deictic selection before the wire's six-scenario bound. Every
 * supplied alias must still be owned and valid; no list is blindly truncated. */
function currentComparisonFrame(raw:unknown,question:string,state:State):unknown{
 if(state.pending||state.running||state.failure||!currentVariantQuestion(question)||!keys(raw,['version','action','binding','parameters','presentation'])||raw.action!=='compare')return raw;
 const active=state.history.find(t=>t.handle===state.active),p=raw.parameters;
 if(active?.kind!=='loan'||active.results.length<2||active.results.length>6||!keys(p,['scenarios','criterion','objective'])||!Array.isArray(p.scenarios)||p.scenarios.length<2||p.scenarios.length>100||new Set(p.scenarios).size!==p.scenarios.length)return raw;
 if(/(?:^|\s)(?:оба|обоих|два|двух)(?:\s|[.,?!]|$)/u.test(fold(question))&&active.results.length!==2)return raw;
 const selected=active.results.map((_v,i)=>active.handle+'_v'+(i+1)),covered=new Set<string>();
 for(const alias of p.scenarios){
  if(typeof alias!=='string'||alias.length>32)return raw;const m=/^(t[1-9][0-9]*)(?:_v([1-9][0-9]*))?$/.exec(alias),task=m&&state.history.find(t=>t.handle===m[1]);
  if(task?.kind!=='loan'||m![2]&&!task.results[Number(m![2])-1])return raw;
  for(const handle of m![2]?[alias]:task.results.map((_v,i)=>task.handle+'_v'+(i+1)))covered.add(handle);
 }
 if(!selected.every(handle=>covered.has(handle)))return raw;
 try{const parsed=parseIntent({...raw,parameters:{...p,scenarios:selected}});return knownBinding(parsed,state)?{...parsed,binding:{mode:'continue',conditions:'pin'}}:raw;}catch{return raw;}
}
/** A source quote is non-executable evidence, not a new calculator field.
 * Validate the entire canonical frame after removing only clear.quote. */
function clearQuoteFrame(raw:unknown,question:string):unknown{
 if(!keys(raw,['version','action','binding','parameters','presentation'])||!['read','calculate'].includes(raw.action))return raw;
 const frame=structuredClone(raw),p=frame.parameters,list=frame.action==='read'?p?.conditions:p?.edits;
 if(!Array.isArray(list)||list.length>32)return raw;
 let changed=false;
 for(const edit of list){
  if(!edit||typeof edit!=='object'||Array.isArray(edit)||edit.op!=='clear'||!Object.hasOwn(edit,'quote'))continue;
  if(typeof edit.quote!=='string'||!edit.quote||edit.quote.length>1000||!question.includes(edit.quote))return raw;
  delete edit.quote;changed=true;
 }
 if(changed)try{return parseIntent(frame);}catch{/* Unknown fields remain invalid. */}
 return raw;
}
/** Source-proven commands decode family confusion. Unknown fields and other
 * calculator parameters remain invalid. */
export function recoverLoanGraphFrame(raw:unknown,question:string,state:State):unknown{
 const canonical=clearQuoteFrame(raw,question);if(canonical!==raw)return canonical;
 const comparison=currentComparisonFrame(raw,question,state);if(comparison!==raw)return comparison;
 if(state.pending||state.running||state.failure||!chartTarget(question,state)||!keys(raw,['version','action','binding','parameters','presentation'])||raw.action!=='read')return raw;
 const p=raw.parameters;
 if(!keys(p,['metric','grouping','comparison','conditions','options'])||p.metric!=='loan_payments'||p.grouping!=='time'||p.comparison!=='none'||!Array.isArray(p.conditions)||p.conditions.length||!keys(p.options,['chart','format','detail']))return raw;
 if(!keys(raw.presentation,['format','detail'])||raw.presentation.format!=='chart'||p.options.chart!==undefined&&!['line','bar','table'].includes(p.options.chart)||p.options.format!==undefined&&p.options.format!==raw.presentation.format||p.options.detail!==undefined&&p.options.detail!==raw.presentation.detail)return raw;
 const candidate={...raw,action:'calculate',parameters:{calculator:'loan',edits:[]}};
 try{const parsed=parseIntent(candidate);return knownBinding(parsed,state)?parsed:raw;}catch{return raw;}
}
function signature(task:ReadTask){
 const q=task.node.query,filter={...q.filter},options={...q.options};delete filter.from;delete filter.through;delete options.comparisonPeriod;
 if(options.statistic==='sum')delete options.statistic;if(options.purpose==='summary')delete options.purpose;if(options.dateBasis==='operation')delete options.dateBasis;
 return stable({metric:q.metric,grouping:q.grouping,filter,options});
}
export function normalizeSourceIntent(intent:Intent,state:State,env:Environment):Intent{
 if(state.running||state.failure||!knownBinding(intent,state))return intent;
 const comparison=currentComparisonFrame(intent,env.question,state);if(comparison!==intent)return comparison as Intent;
 const previous=nearestLoan(state),choice=paymentChoice(env.question);
 if(choice&&(previous||state.pending?.draft.kind==='loan')&&(intent.action==='explain'||intent.action==='calculate'&&intent.parameters.calculator==='loan')){
  const binding=state.pending?.draft.kind==='loan'?{mode:'answer',clarification:state.pending.handle,option:null} as const:{mode:'reference',handle:previous!.handle,conditions:'pin'} as const;
  return {version:intent.version,action:'calculate',binding,parameters:{calculator:'loan',edits:[{field:'payment',op:'set',value:choice.payment,quote:choice.quote}]},presentation:intent.presentation};
 }
 if(state.pending)return intent;
 const chart=chartTarget(env.question,state);
 if(chart&&(intent.action==='calculate'&&intent.parameters.calculator==='loan'||intent.action==='explain'||intent.action==='read'&&!intent.parameters.conditions.length))return {version:intent.version,action:'calculate',binding:{mode:'reference',handle:chart.loan.handle,conditions:'pin'},parameters:{calculator:'loan',edits:chart.both?[{field:'payment',op:'clear'}]:[]},presentation:{...intent.presentation,format:'chart'}};
 if(intent.action!=='read'||!hasExplicitComparisonBase(env.question)||intent.parameters.conditions.some(e=>e.field!=='period'||e.op!=='set')||Object.keys(intent.parameters.options).length)return intent;
 if(/(?:сильнее|больше|меньше|самый|самая|самое|максим|миним|средн|медиан|процент|дол[яюи])/iu.test(env.question))return intent;
 const active=[...state.history].reverse().find(t=>t.kind==='read'),facts=periodFacts(env.question,env.date,active?.kind==='read'?active.node.query.filter:{});
 const periods=[...new Map(facts.map(f=>[stable(f.period),f.period])).values()];if(periods.length!==2)return intent;
 const groups=new Map<string,Map<number,ReadTask>>();
 for(const t of state.history){
  if(t.kind!=='read'||intent.parameters.metric&&t.node.query.metric!==intent.parameters.metric||intent.parameters.grouping&&t.node.query.grouping!==intent.parameters.grouping)continue;
  const index=periods.findIndex(p=>same(p,{from:t.node.query.filter.from,through:t.node.query.filter.through}));if(index<0)continue;
  const key=signature(t),group=groups.get(key)??new Map<number,ReadTask>();group.set(index,t);groups.set(key,group);
 }
 const pairs=[...groups.values()].filter(g=>g.size===2);if(pairs.length!==1)fail('TASK_COMPARISON_CONTEXT_AMBIGUOUS');
 comparisonPeriodOrder([periods[0]!,periods[1]!],env.question,env.date); // Prove the baseline, including conflicts/negation.
 return {version:intent.version,action:'compare',binding:{mode:'new'},parameters:{scenarios:[pairs[0]!.get(0)!.handle,pairs[0]!.get(1)!.handle],criterion:'value',objective:'max'},presentation:intent.presentation};
}
/** A missing model edit does not erase a directly stated temporal condition.
 * Only an anchored temporal literal is supplied, never arbitrary named text. */
export function sourcePeriodEdit(question:string,date:string,base:Query):ConditionEdit|null{
 const facts=periodFacts(question,date,base.filter).filter(f=>/^(?:за|в|с|последние|последних)\s|^(?:сегодня|вчера)$/iu.test(f.source)||isCompletePeriodLiteral(question,date));
 const unique=[...new Map(facts.map(f=>[stable(f.period),f])).values()];if(unique.length>1)fail('TASK_PERIOD_EVIDENCE_AMBIGUOUS');
 return unique.length?{field:'period',op:'set',expression:unique[0]!.source}:null;
}
