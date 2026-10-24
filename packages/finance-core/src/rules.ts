import {merchantKey,recognizeMerchant} from './merchant-recognition.ts';
import {effective,facet,object,choice,uuid,kinds} from './model.ts';
import type {Operation,Account,Role,Kind} from './model.ts';
import {parsePersistedMinor} from './money.ts';
import {safeText} from '../../privacy/src/text.ts';
export type Rule={id:string;name:string;enabled:boolean;priority:number;conditions:{merchantEquals?:string;merchantContains?:string;descriptionContains?:string;accountId?:string;bankId?:string;counterpartyId?:string;direction?:'in'|'out';kind?:Kind;amountFromMinor?:string;amountThroughMinor?:string;currency?:'RUB'};assignments:{role?:Role;kind?:Kind;categoryId?:string|null;subcategoryId?:string|null;merchant?:string;counterpartyId?:string|null;analyticsOverride?:'default'|'include'|'exclude'}};
export function validateRule(value:unknown):Omit<Rule,'id'> {
 const r=object(value,['name','enabled','priority','conditions','assignments']),c=object(r.conditions,['merchantEquals','merchantContains','descriptionContains','accountId','bankId','counterpartyId','direction','kind','amountFromMinor','amountThroughMinor','currency']),a=object(r.assignments,['role','kind','categoryId','subcategoryId','merchant','counterpartyId','analyticsOverride']);
 if(Object.keys(c).length===0||Object.keys(a).length===0||typeof r.enabled!=='boolean'||typeof r.priority!=='number'||!Number.isInteger(r.priority)||Math.abs(r.priority)>10000)throw new TypeError('INVALID_RULE');
 const conditions:Rule['conditions']={},assignments:Rule['assignments']={};
 for(const k of ['merchantEquals','merchantContains','descriptionContains','bankId']as const)if(k in c){conditions[k]=safeText(c[k],160);if(!conditions[k])throw new TypeError('EMPTY_CONDITION');}
 for(const k of ['accountId','counterpartyId']as const)if(k in c)conditions[k]=uuid(c[k]);
 if('direction'in c)conditions.direction=choice(c.direction,['in','out']);if('kind'in c)conditions.kind=choice(c.kind,kinds);if('currency'in c)conditions.currency=choice(c.currency,['RUB']);
 for(const k of ['amountFromMinor','amountThroughMinor']as const)if(k in c){parsePersistedMinor(c[k]);conditions[k]=c[k] as string;}
 if(conditions.amountFromMinor!==undefined&&conditions.amountThroughMinor!==undefined&&BigInt(conditions.amountFromMinor)>BigInt(conditions.amountThroughMinor))throw new TypeError('INVALID_RANGE');
 if('role'in a)assignments.role=choice(a.role,['expense','income','neutral','unresolved']);if('kind'in a)assignments.kind=choice(a.kind,kinds);
 for(const k of ['categoryId','subcategoryId','counterpartyId']as const)if(k in a)assignments[k]=a[k]===null?null:uuid(a[k]);
 if('merchant'in a)assignments.merchant=safeText(a.merchant,160);if('analyticsOverride'in a)assignments.analyticsOverride=choice(a.analyticsOverride,['default','include','exclude']);
 return {name:safeText(r.name,160),enabled:r.enabled,priority:r.priority,conditions,assignments};
}
/** The same closed predicate is used for future imports and explicit historical selection. */
export function ruleMatches(operation:Operation,account:Account,rule:Rule):boolean {
 const f=effective(operation),amount=BigInt(f.amountMinor),text=(s:string)=>s.toLocaleLowerCase('ru-RU'),c=rule.conditions;
 const sameMerchant=(value:string)=>{if(text(operation.semantics.merchant.value)===text(value)||text(f.merchantText)===text(value))return true;const left=recognizeMerchant(operation.semantics.merchant.value),right=recognizeMerchant(value);return left.matched&&right.matched&&!left.conflict&&!right.conflict&&text(value)===text(right.name)&&left.name===right.name;};
 const descriptionMatches=(value:string)=>text(f.description).includes(text(value))||['вендинг','vending'].includes(text(value))&&merchantKey(f.description).includes('vending');
 return (!c.merchantEquals||sameMerchant(c.merchantEquals))&&(!c.merchantContains||text(operation.semantics.merchant.value).includes(text(c.merchantContains)))&&(!c.descriptionContains||descriptionMatches(c.descriptionContains))&&(!c.accountId||c.accountId===f.accountId)&&(!c.bankId||c.bankId===account.bankId)&&(!c.counterpartyId||c.counterpartyId===operation.semantics.counterparty.value)&&(!c.kind||c.kind===operation.semantics.kind.value)&&(!c.direction||c.direction==='in'&&amount>0n||c.direction==='out'&&amount<0n)&&(c.amountFromMinor===undefined||amount>=BigInt(c.amountFromMinor))&&(c.amountThroughMinor===undefined||amount<=BigInt(c.amountThroughMinor))&&(!c.currency||c.currency===f.currency);
}
/** Updating a rule never calls this on old operations; history needs a separate preview command. */
export function applyRules(operation:Operation,account:Account,rules:Rule[]):Operation {
 const op=structuredClone(operation);
 const matching=rules.filter(r=>r.enabled&&ruleMatches(op,account,r)).sort((a,b)=>Object.keys(b.conditions).length-Object.keys(a.conditions).length||b.priority-a.priority);
 const mapping={role:'role',kind:'kind',categoryId:'category',subcategoryId:'subcategory',merchant:'merchant',counterpartyId:'counterparty'}as const;
 for(const [assignment,key]of Object.entries(mapping)as [keyof typeof mapping,typeof mapping[keyof typeof mapping]][]){
  const current=op.semantics[key];if(current.userVerified||key==='kind'&&current.source==='bank'&&current.confidence>=90)continue;
  const offered=matching.filter(r=>assignment in r.assignments),first=offered[0];if(!first)continue;
  const ties=offered.filter(r=>Object.keys(r.conditions).length===Object.keys(first.conditions).length&&r.priority===first.priority);
  if(new Set(ties.map(r=>JSON.stringify(r.assignments[assignment]))).size>1){op.reviewReasons=[...new Set([...op.reviewReasons,'conflicting_rules'])];continue;}
  const value=first.assignments[assignment];(op.semantics as Record<string,unknown>)[key]={...facet(value,'personal_rule'),ruleId:first.id};
 }
 // Explicit transaction inclusion is a manual decision and is never overwritten.
 if(op.analyticsOverride==='default'){
  const offered=matching.filter(r=>'analyticsOverride'in r.assignments),first=offered[0];
  if(first){const ties=offered.filter(r=>Object.keys(r.conditions).length===Object.keys(first.conditions).length&&r.priority===first.priority);
   if(new Set(ties.map(r=>r.assignments.analyticsOverride)).size>1)op.reviewReasons=[...new Set([...op.reviewReasons,'conflicting_rules'])];else op.analyticsOverride=first.assignments.analyticsOverride!;
  }
 }
 return op;
}
