/** Evidence-backed period formatting. A normalized value never supplies its
 * own evidence: the current question must independently resolve to that period.
 * This is a literal adapter, not an intent/relevance classifier. */
import {dateFact} from '../../../finance-core/src/model.ts';
import {parseOperationsFilter} from '../../../finance-core/src/operations.ts';
import type {OperationsFilter} from '../../../finance-core/src/operations.ts';
import {periodLiteral} from '../task-literals.ts';
import {analyzerLexicon,resolveLexeme} from './lexicon.ts';
import {foldSource,sourceOccurrences} from './source-literals.ts';
type Period=Pick<OperationsFilter,'from'|'through'>;
const same=(a:Period,b:Period)=>a.from===b.from&&a.through===b.through;
function fail(code:string):never{throw new TypeError(code);}
const sameYearForms=analyzerLexicon.find(e=>e.family==='year_reference'&&e.key==='same')!.forms.map(foldSource).sort((a,b)=>b.length-a.length);
function sameYearBody(value:string):string|null{
 for(const form of sameYearForms){
  if(value.endsWith(' '+form))return value.slice(0,-form.length-1);
  if(value.startsWith(form+' '))return value.slice(form.length+1).replace(/^[:,]\s*/u,'');
  if(value.startsWith(form+', ')||value.startsWith(form+': '))return value.slice(form.length+2);
 }
 return null;
}
/** A contextual year is a separate source from the current calendar year or
 * the UI's merged period. Only a selected, bounded one-year task supplies it. */
function qualifiedYear(value:string,date:string,reference:Period):{text:string}|null{
 const inclusive=value.endsWith(' включительно');if(inclusive)value=value.slice(0,-13);
 const contextual=sameYearBody(value);
 let body=contextual??value,year:number|null=null,calendar=false;
 if(contextual===null){
  const match=/^(.+?) ([\p{L}]+) (?:год|года|году)$/u.exec(value);
  if(match){const relation=resolveLexeme('time_relation',match[2]!);body=match[1]!;calendar=true;if(relation.status==='known')year=Number(date.slice(0,4))+(relation.key==='previous'?-1:relation.key==='next'?1:0);}
 }
 if(contextual===null&&!calendar)return null;
 const match=/^(?:(с \d{1,2} по \d{1,2}) )?([\p{L}]+)\.?(?: (\d{4}))?$/u.exec(body);
 if(!match)return null;
 const month=resolveLexeme('calendar_month',match[2]!,true);if(month.status!=='known')return null;
 if(contextual!==null){
  if(!reference.from||!reference.through)fail('TASK_PERIOD_YEAR_CONTEXT_REQUIRED');
  try{parseOperationsFilter(reference);}catch{fail('TASK_PERIOD_YEAR_CONTEXT_REQUIRED');}
  if(reference.from.slice(0,4)!==reference.through.slice(0,4))fail('TASK_PERIOD_YEAR_AMBIGUOUS');
  year=Number(reference.from.slice(0,4));
 }
 if(year===null)fail('TASK_PERIOD_YEAR_QUALIFIER_UNSUPPORTED');
 if(match[3]&&Number(match[3])!==year)fail('TASK_PERIOD_YEAR_CONFLICT');
 if(inclusive&&!match[1])fail('TASK_PERIOD_YEAR_VALUE_UNSUPPORTED');
 return {text:(match[1]?match[1]+' ':'')+month.canonical+' '+String(year).padStart(4,'0')+(inclusive?' включительно':'')};
}
function canonical(expression:string):Period|null{
 const month=/^(\d{4})-(\d{2})$/.exec(expression);
 if(month){
  const from=expression+'-01';dateFact({precision:'day',date:from});
  const end=new Date(from+'T00:00:00Z');end.setUTCMonth(end.getUTCMonth()+1,0);
  return {from,through:end.toISOString().slice(0,10)};
 }
 if(/^\d{4}-\d{2}-\d{2}$/.test(expression))return parseOperationsFilter({from:expression,through:expression});
 const range=/^(?:с\s+)?(\d{4}-\d{2}-\d{2})\s*(?:\/|по|до|—|–|-|\.\.)\s*(\d{4}-\d{2}-\d{2})(?:\s+включительно)?$/u.exec(expression);
 if(range)return parseOperationsFilter({from:range[1],through:range[2]});
 return null;
}
function literal(quote:string,date:string,previous:Period,allowBareTypos=true,reference:Period=previous):Period{
 const source=quote.normalize('NFKC').toLocaleLowerCase('ru-RU').replace(/[(),]/gu,' ').replace(/\s+/gu,' ').trim();
 let normalized=source.replace(/^(?:за|в)\s+/u,'').replace(/[.?]$/u,'').trim().replace(/^(\p{L}+)\s*[-–—]\s*(\d{4})$/u,'$1 $2')
  .replace(/^(январ|феврал|апрел|июн|июл|сентябр|октябр|ноябр|декабр)(?:[её]м|ю)(?=\s|$)/u,'$1ь')
  .replace(/^(март|август)(?:ом|у)(?=\s|$)/u,'$1').replace(/^ма(?:ем|ю)(?=\s|$)/u,'май');
 const qualified=qualifiedYear(normalized,date,reference);if(qualified)normalized=qualified.text;
 const month=/^([\p{L}]+)\.?(?:\s+(\d{4})(?: года| г\.?)?)?$/u.exec(normalized);
 if(month){const term=resolveLexeme('calendar_month',month[1]!,allowBareTypos||/^(?:за|в)\s/u.test(source)||!!month[2]);if(term.status==='known')normalized=term.canonical+(month[2]?' '+month[2]:'');}
 const range=/^(с \d{1,2} по \d{1,2} )([\p{L}]+)\.?( \d{4}(?: года)?(?: включительно)?)$/u.exec(normalized);
 if(range){const term=resolveLexeme('calendar_month',range[2]!,true);if(term.status==='known')normalized=range[1]+term.canonical+range[3];}
 const relative=/^([\p{L}]+) ([\p{L}]+)\.?$/u.exec(normalized);
 if(relative){const relation=resolveLexeme('time_relation',relative[1]!,true),unit=resolveLexeme('calendar_unit',relative[2]!,true);if(relation.status==='known'&&unit.status==='known'&&unit.key==='month'&&['previous','current'].includes(relation.key))normalized=(relation.key==='previous'?'предыдущий':'текущий')+' месяц';}
 let period:Period;
 try{period=canonical(normalized)??periodLiteral(normalized,normalized,date);}catch(error){if(qualified)fail('TASK_PERIOD_YEAR_VALUE_UNSUPPORTED');throw error;}
 if(/^\p{L}+$/u.test(normalized)&&period.from?.endsWith('-01')&&period.from!==period.through&&previous.from&&previous.through){
  if(previous.from.slice(0,4)!==previous.through.slice(0,4))fail('TASK_PERIOD_YEAR_AMBIGUOUS');
  return periodLiteral(normalized,normalized,previous.from.slice(0,4)+'-01-01');
 }
 return period;
}
export function isCompletePeriodLiteral(value:string,date:string,previous:Period={}):boolean{
 if(!value||value.length>2000)return false;try{literal(value,date,previous);return true;}catch{return false;}
}
export function periodFacts(question:string,date:string,previous:Period={},reference:Period=previous){
 if(!question||question.length>2000)fail('TASK_PERIOD_UNSUPPORTED');
 // Whole-token spans prevent YYYY-MM being treated as evidence inside a day.
 // Use the existing grammar and retain maximal spans so an explicit year or
 // larger range cannot disappear while matching a convenient smaller token.
 const tokens=[...question.matchAll(/[\p{L}\p{N}]+(?:[-./][\p{L}\p{N}]+)*|[—–]/gu)];
 const bareContext=/^(?:(?:а|теперь|тогда|покажи|выведи)\s+)*(?:(?:за|в)\s+)?[\p{L}]+\.?[?!]*$/iu.test(question.trim());
 const found:{start:number;end:number;period:Period}[]=[];
 const blocked:{start:number;end:number}[]=[];
 for(let i=0;i<tokens.length;i++)for(let j=i;j<Math.min(tokens.length,i+8);j++){
  const start=tokens[i]!.index!,end=tokens[j]!.index!+tokens[j]![0].length;
  if(end-start>200)break;
  try{const period=literal(question.slice(start,end),date,previous,bareContext,reference);found.push({start,end,period});}catch(error){if(error instanceof TypeError&&/^TASK_PERIOD_YEAR_/u.test(error.message))blocked.push({start,end});continue;}
  if(found.length>64)fail('TASK_PERIOD_EVIDENCE_AMBIGUOUS');
 }
 // An unresolved qualifier must not leave a smaller bare-month interpretation.
 const proven=found.filter(a=>!blocked.some(b=>b.start<=a.start&&b.end>=a.end));
 const maximal=proven.filter(a=>!proven.some(b=>b!==a&&b.start<=a.start&&b.end>=a.end&&(b.start<a.start||b.end>a.end)));
 return maximal.map(f=>({...f,source:question.slice(f.start,f.end)}));
}
export function periodExpression(expression:string,question:string,date:string,previous:Period={},reference:Period=previous):Period{
 if(!question||question.length>2000||!expression||expression.length>2000)fail('TASK_PERIOD_UNSUPPORTED');
 let proposed:Period|null;
 try{proposed=canonical(expression.trim());}catch{fail('TASK_PERIOD_UNSUPPORTED');}
 if(!proposed){
  const value=literal(expression,date,previous,true,reference),quote=expression.replace(/[.?]$/u,'');
  const all=periodFacts(question,date,previous,reference);
  const quoted=all.filter(f=>sourceOccurrences(quote,f.source).length);
  const facts=quoted.length?quoted:all;
  if(!quoted.length&&all.some(f=>!same(f.period,all[0]!.period)))fail('TASK_PERIOD_EVIDENCE_AMBIGUOUS');
  if(!facts.length)fail('TASK_EVIDENCE_MISSING');
  if(facts.some(f=>!same(value,f.period)))fail('TASK_PERIOD_EVIDENCE_MISMATCH');
  return value;
 }
 const maximal=periodFacts(question,date,previous,reference);
 if(!maximal.length)fail('TASK_EVIDENCE_MISSING');
 if(maximal.some(p=>!same(p.period,maximal[0]!.period)))fail('TASK_PERIOD_EVIDENCE_AMBIGUOUS');
 if(!same(proposed,maximal[0]!.period))fail('TASK_PERIOD_EVIDENCE_MISMATCH');
 return proposed;
}
