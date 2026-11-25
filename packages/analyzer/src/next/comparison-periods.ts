/** Server-owned roles for a two-period comparison. Model array order is not
 * evidence of a baseline. With no explicit baseline, time runs forward. */
import type {OperationsFilter} from '../../../finance-core/src/operations.ts';
import {isCompletePeriodLiteral,periodExpression} from './period.ts';
type Period=Pick<OperationsFilter,'from'|'through'>;
function fail(code:string):never{throw new TypeError(code);}
const same=(a:Period,b:Period)=>a.from===b.from&&a.through===b.through;
export function comparisonPeriodOrder(periods:readonly [Period,Period],question:string,date:string):[number,number]{
 const [a,b]=periods;
 if(!a.from||!a.through||!b.from||!b.through)fail('TASK_COMPARISON_PERIOD_REQUIRED');
 if(!(a.through<b.from||b.through<a.from))fail('TASK_COMPARISON_PERIOD_OVERLAP');
 const text=question.normalize('NFKC').toLocaleLowerCase('ru-RU').replaceAll('ё','е');
 // An explicit role has to resolve from the message, independently of the
 // selected aliases. An unsupported/negated direction must never be inverted.
 if(/(?<!\p{L})(?:наоборот|обратно|обратном порядке)(?!\p{L})/u.test(text))fail('TASK_COMPARISON_DIRECTION_REQUIRED');
 const anchors=[...text.matchAll(/(?<!\p{L})(?:относительно|по сравнению с|в сравнении с|по отношению к|база\s*[:—-]|базовый период\s*[:—-]|за базу\s+(?:возьми(?:те)?|прими(?:те)?)|к|(?:меньше|больше|выше|ниже)(?:\s+чем)?)(?!\p{L})/gu)];
 const explicit=new Set<number>();
 let roleAnchors=0;
 for(const anchor of anchors){
  const before=text.slice(0,anchor.index).trim();
  const optional=/^(?:к|меньше|больше|выше|ниже)(?:\s+чем)?$/u.test(anchor[0]);
  const suffix=text.slice(anchor.index!+anchor[0].length).trim(),tokens=[...suffix.matchAll(/\S+/gu)];
  const candidates:{end:number;index:number}[]=[];let longest=0;
  for(let n=0;n<Math.min(tokens.length,8);n++){
   const end=tokens[n]!.index!+tokens[n]![0].length;
   const literal=suffix.slice(0,end).replace(/[?!.,;:]$/u,'').trim();
   if(!isCompletePeriodLiteral(literal,date))continue;longest=end;
   periods.forEach((period,index)=>{try{if(same(periodExpression(literal,literal,date,period),period))candidates.push({end,index});}catch{/* no source match */}});
  }
  if(!longest&&optional)continue;
  roleAnchors++;
  if(/(?:^|\s)не\s*$/u.test(before))fail('TASK_COMPARISON_DIRECTION_REQUIRED');
  const matches=new Set(candidates.filter(c=>c.end===longest).map(c=>c.index));
  if(matches.size!==1)fail('TASK_COMPARISON_DIRECTION_REQUIRED');
  explicit.add([...matches][0]!);
 }
 if(!roleAnchors&&/(?<!\p{L})(?:баз(?:а|у|ой|овый|овым)|относительн\p{L}*)(?!\p{L})/u.test(text))fail('TASK_COMPARISON_DIRECTION_REQUIRED');
 if(explicit.size>1)fail('TASK_COMPARISON_DIRECTION_CONFLICT');
 const base=explicit.size?[...explicit][0]!:a.from<b.from?0:1;
 return [base,1-base];
}
