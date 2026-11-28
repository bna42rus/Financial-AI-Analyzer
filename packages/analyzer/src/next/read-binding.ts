/** Server-side binding recovery for a complete, condition-only follow-up.
 * Never a relevance classifier, history search or arbitrary prose heuristic. */
import type {Intent} from './intent.ts';
import type {Query} from '../registry.ts';
import {assistantAmountLiteral} from '../assistant-money.ts';
import {isCompletePeriodLiteral,periodExpression} from './period.ts';
const fold=(s:string)=>s.normalize('NFKC').toLocaleLowerCase('ru-RU').replaceAll('ё','е').replace(/\s+/gu,' ').trim();
function conflict():never{throw new TypeError('TASK_CONTEXT_DECISION_CONFLICT');}
type NamedValues=Partial<Record<'accounts'|'categories'|'counterparties'|'merchant',readonly string[]>>;
export function normalizeReadBinding(intent:Intent,previous:Query|null,question:string,date:string,blocked=false,names:NamedValues={}):Intent{
 if(blocked||!previous||intent.action!=='read'||intent.binding.mode!=='new'||intent.parameters.conditions.length!==1)return intent;
 const edit=intent.parameters.conditions[0]!;if(edit.op!=='set')return intent;
 // Strip only conversational glue and sentence punctuation. The entire
 // remaining message must be understood by one closed literal adapter.
 const body=question.trim().replace(/[?!.]+$/u,'').trim().replace(/^(?:(?:а|и|теперь|тогда)\s+)+/iu,'');
 let expression=edit.expression;
 if(edit.field==='period'||edit.field==='postedPeriod'){
  const period=edit.field==='period'?{from:previous.filter.from,through:previous.filter.through}:{from:previous.filter.postedFrom,through:previous.filter.postedThrough};
  if(!isCompletePeriodLiteral(body,date)&&!isCompletePeriodLiteral(body,date,period))return intent;
  periodExpression(expression,question,date,edit.field==='period'?{from:previous.filter.from,through:previous.filter.through}:{from:previous.filter.postedFrom,through:previous.filter.postedThrough});
  expression=body; // Explicit text is applied after the current UI-field merge.
 }else if(edit.field==='amount'){
  let literal;try{literal=assistantAmountLiteral(body,'absolute_operation');}catch{return intent;}
  let proposed;try{proposed=assistantAmountLiteral(expression,'absolute_operation');}catch{conflict();}
  if(literal.amountFrom!==proposed.amountFrom||literal.amountThrough!==proposed.amountThrough)conflict();
  expression=body;
 }else if(['accounts','categories','counterparties','merchant'].includes(edit.field)){
  const allowed=names[edit.field as keyof NamedValues]??[];
  if(!body||fold(body)!==fold(expression)||!allowed.some(name=>fold(name)===fold(body)))return intent;
  expression=body; // Retain the original spelling as quoted name evidence.
 }else return intent;
 // A condition-only sentence requests no new metric, grouping, comparison or
 // statistics. Model-carried defaults cannot erase those server-owned fields.
 return {...intent,binding:{mode:'continue',conditions:'merge_ui'},parameters:{...intent.parameters,metric:null,grouping:null,comparison:null,options:{},conditions:[{...edit,expression}]}};
}
