import type {BankDate,BankFact} from './model.ts';
export const bankCalendarVersion='cashneuro-bank-calendar/1' as const;
export function calendarKnown(date:BankDate){return date.precision==='day'||typeof date.sourceOffsetMinutes==='number';}
/** Calendar metadata is not transaction identity. Compare canonical instants
 * separately; differing observed offsets are retained as a conflict. */
export function mergeBankCalendar(selected:BankDate,observations:readonly BankDate[]):{date:BankDate;conflict:boolean}{
 if(selected.precision==='day')return {date:selected,conflict:false};
 const offsets=new Set(observations.flatMap(d=>d.precision==='instant'&&Date.parse(d.instant)===Date.parse(selected.instant)&&typeof d.sourceOffsetMinutes==='number'?[d.sourceOffsetMinutes]:[]));
 if(offsets.size>1)return {date:{...selected,sourceOffsetMinutes:null},conflict:true};
 if(offsets.size===1)return {date:{...selected,sourceOffsetMinutes:[...offsets][0]!},conflict:false};
 return {date:selected,conflict:false};
}
export function resolveSourceCalendar(fact:BankFact,observations:readonly {operationDate?:BankDate;postedDate?:BankDate|null}[]):BankFact{
 const operation=mergeBankCalendar(fact.operationDate,observations.flatMap(o=>o.operationDate?[o.operationDate]:[]));
 const posted=fact.postedDate===null?null:mergeBankCalendar(fact.postedDate,observations.flatMap(o=>o.postedDate?[o.postedDate]:[]));
 const versions={...fact.versions};delete versions.operationCalendarEvidence;delete versions.postedCalendarEvidence;
 if(operation.conflict)versions.operationCalendarEvidence='conflict';if(posted?.conflict)versions.postedCalendarEvidence='conflict';
 return {...fact,operationDate:operation.date,postedDate:posted?.date??null,versions};
}
/** Matching descriptors intentionally omit this presentation/period metadata. */
export const sameCalendar=(a:BankDate|null,b:BankDate|null)=>a===null||b===null?a===b:a.precision==='day'?b.precision==='day'&&a.date===b.date:b.precision==='instant'&&Date.parse(a.instant)===Date.parse(b.instant)&&a.sourceOffsetMinutes===b.sourceOffsetMinutes;
