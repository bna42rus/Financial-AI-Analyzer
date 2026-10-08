import type {PreparedRow} from './contract.ts';
import type {BankDate} from '../../finance-core/src/model.ts';

export type SourceCandidate={transactionId:string;fileHmac:string;ordinal:number;bankRefHmac:string|null;operationDate:BankDate;postedDate:BankDate|null;amountMinor:string;currency:string;direction:string};
const sameDate=(a:BankDate|null,b:BankDate|null)=>a===null||b===null?a===b:a.precision==='day'?b.precision==='day'&&a.date===b.date:b.precision==='instant'&&a.instant===b.instant;
export function sameSource(a:PreparedRow,b:SourceCandidate){return sameDate(a.operationDate,b.operationDate)&&sameDate(a.postedDate,b.postedDate)&&a.amountMinor===b.amountMinor&&a.currency===b.currency&&a.direction===b.direction&&a.bankRefHmac===b.bankRefHmac;}
/** Caller restricts candidates to the same user, bank and source alias, never effective edits.
 * One transaction may be consumed at most once per file, including across durable checkpoints. */
export function matchSource(row:PreparedRow,fileHmac:string,candidates:SourceCandidate[],used:Set<string>){
 const unique=(items:SourceCandidate[])=>[...new Set(items.map(c=>c.transactionId))];
 const instance=unique(candidates.filter(c=>!used.has(c.transactionId)&&c.fileHmac===fileHmac&&c.ordinal===row.ordinal&&sameSource(row,c)));
 if(instance.length===1)return {transactionId:instance[0]!,possibleIds:[] as string[]};
 const strong=row.bankRefHmac===null?[]:unique(candidates.filter(c=>!used.has(c.transactionId)&&c.bankRefHmac===row.bankRefHmac));
 if(strong.length===1)return {transactionId:strong[0]!,possibleIds:[] as string[]};
 // The text-free profile cannot establish a cross-file strict fingerprint. Date/amount are only candidates.
 const possible=unique(candidates.filter(c=>row.bankRefHmac!==null&&c.bankRefHmac===row.bankRefHmac||(c.fileHmac!==fileHmac||c.ordinal===row.ordinal)&&sameDate(row.operationDate,c.operationDate)&&row.amountMinor===c.amountMinor&&row.currency===c.currency&&row.direction===c.direction));
 return {transactionId:null,possibleIds:possible};
}
