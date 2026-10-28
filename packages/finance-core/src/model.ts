import {parsePersistedMinor} from './money.ts';

export const kinds=['purchase','transfer_in','transfer_out','own_transfer','refund','reversal','cash_withdrawal','cash_deposit','credit_card_repayment','loan_disbursement','loan_payment','interest','fee','insurance','cashback','other'] as const;
export type Kind=typeof kinds[number];
export type Role='expense'|'income'|'neutral'|'unresolved';
export type Source='user'|'personal_rule'|'deterministic_system_rule'|'global_rule'|'ai'|'bank';
export type Facet<T>={value:T;source:Source;confidence:number;userVerified:boolean;ruleId?:string};
export type BankDate={precision:'day';date:string}|{precision:'instant';instant:string;sourceOffsetMinutes?:number|null};
export type Account={id:string;bankId:string;name:string;type:'debit_card'|'credit_card'|'bank_account'|'loan'|'savings'|'deposit'|'other';analyticsEnabled:boolean;defaultVisible:boolean;loanMode:'cashflow'|'economic'|null;mergedIntoId?:string|null};
export type Category={id:string;name:string;parentId:string|null;role:'expense'|'income'|'both';hidden:boolean};
export type Semantics={kind:Facet<Kind>;role:Facet<Role>;category:Facet<string|null>;subcategory:Facet<string|null>;merchant:Facet<string>;counterparty:Facet<string|null>};
export type BankFact={accountId:string;operationDate:BankDate;postedDate:BankDate|null;amountMinor:string;currency:'RUB';sourceKind?:Kind;operationAmountMinor?:string|null;operationCurrency?:string|null;merchantText:string;description:string;bankCategory:string;sourceMcc?:string|null;bankRefHmac:string|null;versions:Record<string,string>};
export type Corrections={accountId?:string;operationDate?:BankDate;postedDate?:BankDate|null;amountMinor?:string};
export type Operation={id:string;source:BankFact;accountAssignmentId?:string;corrections:Corrections;semantics:Semantics;comment:string;analyticsOverride:'default'|'include'|'exclude';decomposition:boolean;reviewReasons:string[]};
export type Component={id:string;transactionId:string;type:'principal'|'interest'|'fee'|'insurance'|'other';amountMinor:string;role:Facet<Role>;category:Facet<string|null>;subcategory:Facet<string|null>};
export const linkKinds=['own_transfer','credit_card_repayment','refund','reversal','expense_reimbursement','debt_repayment'] as const;
export type Link={id:string;sourceId:string;targetId:string;sourceComponentId:string|null;targetComponentId:string|null;sourceAllocationId?:string|null;targetAllocationId?:string|null;kind:typeof linkKinds[number];amountMinor:string;status:'candidate'|'confirmed'|'rejected';confidence:number;createdBy:Source};
export type Graph={accounts:Account[];categories:Category[];operations:Operation[];components:Component[];links:Link[];loanMode:'cashflow'|'economic';categoryBindings?:Readonly<Record<string,{categoryId:string;subcategoryId:string|null}>>};
export function facet<T>(value:T,source:Source='deterministic_system_rule',userVerified=false,confidence=100):Facet<T>{return {value,source,userVerified,confidence};}
export function defaultRole(kind:Kind,amountMinor?:string):Role {
 if(kind==='interest'){const amount=amountMinor===undefined?0n:parsePersistedMinor(amountMinor);return amount>0n?'income':amount<0n?'expense':'unresolved';}
 if(['purchase','loan_payment','fee','insurance'].includes(kind))return 'expense';
 if(kind==='cashback')return 'income';
 if(['own_transfer','cash_withdrawal','cash_deposit','credit_card_repayment','loan_disbursement'].includes(kind))return 'neutral';
 return 'unresolved';
}
export function initialSemantics(kind:Kind,merchant='',amountMinor?:string):Semantics {return {kind:facet(kind,'bank'),role:facet(defaultRole(kind,amountMinor)),category:facet(null),subcategory:facet(null),merchant:facet(merchant,'bank'),counterparty:facet(null)};}
export function object(value:unknown,keys:string[]):Record<string,unknown>{
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!keys.includes(k)))throw new TypeError('INVALID_FIELDS');return value as Record<string,unknown>;
}
export function choice<const T extends string>(value:unknown,values:readonly T[]):T {if(typeof value!=='string'||!values.includes(value as T))throw new TypeError('INVALID_VALUE');return value as T;}
export function uuid(value:unknown):string {if(typeof value!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value))throw new TypeError('INVALID_ID');return value.toLowerCase();}
export function dateFact(value:unknown):BankDate {
 const r=object(value,['precision','date','instant','sourceOffsetMinutes']);
 if(r.precision==='day'&&Object.keys(r).length===2&&typeof r.date==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(r.date)&&Number.isFinite(Date.parse(r.date))&&new Date(r.date).toISOString().slice(0,10)===r.date)return {precision:'day',date:r.date};
 if(r.precision==='instant'&&!('date'in r)&&Object.keys(r).length===('sourceOffsetMinutes'in r?3:2)&&typeof r.instant==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(r.instant)&&Number.isFinite(Date.parse(r.instant))){
  if('sourceOffsetMinutes'in r&&r.sourceOffsetMinutes!==null&&(typeof r.sourceOffsetMinutes!=='number'||!Number.isInteger(r.sourceOffsetMinutes)||Math.abs(r.sourceOffsetMinutes)>840))throw new TypeError('INVALID_DATE');
  const d=new Date(r.instant).toISOString();if(d===r.instant||d.replace('.000Z','Z')===r.instant)return {precision:'instant',instant:d,...('sourceOffsetMinutes'in r?{sourceOffsetMinutes:r.sourceOffsetMinutes as number|null}:{})};
 }
 throw new TypeError('INVALID_DATE');
}
/** Source-local when known. Unknown-zone instants use an explicitly reviewable
 * UTC reference day, never an invented Moscow/profile/travel timezone. */
export function operationDay(date:BankDate):string {return date.precision==='day'?date.date:new Date(Date.parse(date.instant)+(date.sourceOffsetMinutes??0)*60000).toISOString().slice(0,10);}
export function correction(value:unknown):Corrections {
 const r=object(value,['accountId','operationDate','postedDate','amountMinor']),out:Corrections={};
 if('accountId'in r)out.accountId=uuid(r.accountId);
 if('operationDate'in r)out.operationDate=dateFact(r.operationDate);
 if('postedDate'in r)out.postedDate=r.postedDate===null?null:dateFact(r.postedDate);
 if('amountMinor'in r){parsePersistedMinor(r.amountMinor);out.amountMinor=r.amountMinor as string;}
 return out;
}
export function effective(op:Operation){return {...op.source,...(op.accountAssignmentId?{accountId:op.accountAssignmentId}:{}),...op.corrections};}
