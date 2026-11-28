/** Source spelling only. No fuzzy names, invented aliases, scope expansion or
 * removal of negation. Semantic dates and monetary inequalities stay separate. */
import {resolveLexeme} from './lexicon.ts';
export const foldSource=(s:string)=>s.normalize('NFKC').toLocaleLowerCase('ru-RU').replaceAll('ё','е').replace(/[«»“”„]/gu,'"').replace(/[‘’]/gu,"'").replace(/\s+/gu,' ').trim();
const word=(s:string)=>/[\p{L}\p{N}_]/u.test(s);
export function sourceOccurrences(value:string,question:string){
 const needle=foldSource(value),source=foldSource(question),found:{start:number;end:number}[]=[];
 if(!needle)return found;
 for(let at=source.indexOf(needle);at>=0;at=source.indexOf(needle,at+1))if((!word(needle[0]!)||!word(source[at-1]??''))&&(!word(needle.at(-1)!)||!word(source[at+needle.length]??'')))found.push({start:at,end:at+needle.length});
 return found;
}
const unquote=(s:string)=>s.length>1&&(s[0]==='"'&&s.at(-1)==='"'||s[0]==="'"&&s.at(-1)==="'")?s.slice(1,-1).trim():s;
type NameField='accounts'|'categories'|'counterparties';
const prepositions={accounts:['с','со','на','по','из'],categories:['по','в','из','для'],counterparties:['у','по','для','от']};
function rolePhrase(field:NameField,value:string){
 const words=value.split(' '),prep=prepositions[field].includes(words[0]!)?words.shift()!:null;
 const role=resolveLexeme('entity_role',words.shift()??'',true);
 return role.status==='known'&&role.key===field&&words.length?{prep,name:unquote(words.join(' '))}:null;
}
function roleSource(field:NameField,prep:string|null,start:number,question:string){
 const before=foldSource(question).slice(0,start).replace(/["']\s*$/u,'').trimEnd();
 const match=/(?:^|[^\p{L}\p{N}_])(?:(с|со|на|по|из|для|в|у|от) )?([\p{L}]+)$/u.exec(before);
 if(!match||match[1]&&!prepositions[field].includes(match[1])||prep!==null&&prep!==(match[1]??null)||/(?:^|\s)(?:не|без|кроме|исключая)$/u.test(before.slice(0,match.index).trimEnd()))return false;
 const role=resolveLexeme('entity_role',match[2]!,true);return role.status==='known'&&role.key===field;
}
export function sourceNameIndex(field:NameField,expression:string,question:string,names:readonly string[]):number{
 const value=foldSource(expression),folded=names.map(foldSource);
 // A catalog name itself may begin with a role word. Keep that interpretation;
 // if decoding the wrapper points to another item, require clarification.
 const role=rolePhrase(field,value),forms=new Set([value,unquote(value),...(role?[role.name]:[])]);
 const candidates=folded.flatMap((n,i)=>forms.has(n)?[i]:[]);
 if(candidates.length!==1)throw new TypeError(candidates.length?'TASK_ENTITY_AMBIGUOUS':'TASK_ENTITY_MISSING');
 const name=folded[candidates[0]!]!;
 const literal=name===value||name===unquote(value);
 if(literal&&!sourceOccurrences(expression,question).length)throw new TypeError('TASK_EVIDENCE_MISSING');
 const source=foldSource(question);
 const spans=folded.flatMap(n=>sourceOccurrences(n,question).filter(s=>{const before=source[s.start-1];return before!=='\"'&&before!=="'"||source[s.end]===before;}).map(s=>({...s,name:n})));
 const maximal=spans.filter(a=>!spans.some(b=>b.start<=a.start&&b.end>=a.end&&(b.start<a.start||b.end>a.end)));
 if(!maximal.some(s=>s.name===name&&(literal||!!role&&roleSource(field,role.prep,s.start,question))))throw new TypeError('TASK_EVIDENCE_MISSING');
 return candidates[0]!;
}
