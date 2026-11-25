/** Evidence-backed period formatting. A normalized value never supplies its
 * own evidence: the current question must independently resolve to that period.
 * This is a literal adapter, not an intent/relevance classifier. */
import {dateFact} from '../../../finance-core/src/model.ts';
import {parseOperationsFilter} from '../../../finance-core/src/operations.ts';
import type {OperationsFilter} from '../../../finance-core/src/operations.ts';
import {periodLiteral,questionQuote} from '../task-literals.ts';
type Period=Pick<OperationsFilter,'from'|'through'>;
const same=(a:Period,b:Period)=>a.from===b.from&&a.through===b.through;
function fail(code:string):never{throw new TypeError(code);}
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
function literal(quote:string,date:string,previous:Period):Period{
 const source=quote.normalize('NFKC').toLocaleLowerCase('ru-RU').replace(/[(),]/gu,' ').replace(/\s+/gu,' ').trim();
 const normalized=source.replace(/^(?:за|в)\s+/u,'').replace(/[.?]$/u,'').trim().replace(/^(\p{L}+)\s*[-–—]\s*(\d{4})$/u,'$1 $2')
  .replace(/^(январ|феврал|апрел|июн|июл|сентябр|октябр|ноябр|декабр)(?:[её]м|ю)(?=\s|$)/u,'$1ь')
  .replace(/^(март|август)(?:ом|у)(?=\s|$)/u,'$1').replace(/^ма(?:ем|ю)(?=\s|$)/u,'май');
 const period=canonical(normalized)??periodLiteral(normalized,normalized,date);
 if(/^\p{L}+$/u.test(normalized)&&period.from?.endsWith('-01')&&period.from!==period.through&&previous.from&&previous.through){
  if(previous.from.slice(0,4)!==previous.through.slice(0,4))fail('TASK_PERIOD_YEAR_AMBIGUOUS');
  return periodLiteral(normalized,normalized,previous.from.slice(0,4)+'-01-01');
 }
 return period;
}
export function isCompletePeriodLiteral(value:string,date:string):boolean{
 if(!value||value.length>2000)return false;try{literal(value,date,{});return true;}catch{return false;}
}
export function periodExpression(expression:string,question:string,date:string,previous:Period={}):Period{
 if(!question||question.length>2000||!expression||expression.length>2000)fail('TASK_PERIOD_UNSUPPORTED');
 let proposed:Period|null;
 try{proposed=canonical(expression.trim());}catch{fail('TASK_PERIOD_UNSUPPORTED');}
 if(!proposed){questionQuote(expression,question);return literal(expression,date,previous);}
 // Whole-token spans prevent YYYY-MM being treated as evidence inside a day.
 // Use the existing grammar and retain maximal spans so an explicit year or
 // larger range cannot disappear while matching a convenient smaller token.
 const tokens=[...question.matchAll(/[\p{L}\p{N}]+(?:[-./][\p{L}\p{N}]+)*|[—–]/gu)];
 const found:{start:number;end:number;period:Period}[]=[];
 for(let i=0;i<tokens.length;i++)for(let j=i;j<Math.min(tokens.length,i+8);j++){
  const start=tokens[i]!.index!,end=tokens[j]!.index!+tokens[j]![0].length;
  if(end-start>200)break;
  try{const period=literal(question.slice(start,end),date,previous);found.push({start,end,period});}catch{continue;}
  if(found.length>64)fail('TASK_PERIOD_EVIDENCE_AMBIGUOUS');
 }
 const maximal=found.filter(a=>!found.some(b=>b!==a&&b.start<=a.start&&b.end>=a.end&&(b.start<a.start||b.end>a.end)));
 if(!maximal.length)fail('TASK_EVIDENCE_MISSING');
 if(maximal.some(p=>!same(p.period,maximal[0]!.period)))fail('TASK_PERIOD_EVIDENCE_AMBIGUOUS');
 if(!same(proposed,maximal[0]!.period))fail('TASK_PERIOD_EVIDENCE_MISMATCH');
 return proposed;
}
