import {legacyRuleSourceMerchant} from './legacy-source-merchant.ts';
import {merchantKey,recognizeMerchant} from './merchant-recognition.ts';
import {effective,facet,object,choice,uuid,kinds} from './model.ts';
import type {Operation,Account,Category,Role,Kind} from './model.ts';
import {parsePersistedMinor} from './money.ts';
import {safeText} from '../../privacy/src/text.ts';
export type Rule={id:string;name:string;enabled:boolean;priority:number;conditions:{merchantEquals?:string;merchantContains?:string;descriptionContains?:string;accountId?:string;bankId?:string;counterpartyId?:string;counterpartyBankIdentity?:true;direction?:'in'|'out';kind?:Kind;amountFromMinor?:string;amountThroughMinor?:string;currency?:'RUB'};assignments:{role?:Role;kind?:Kind;categoryId?:string|null;subcategoryId?:string|null;merchant?:string;counterpartyId?:string|null;analyticsOverride?:'default'|'include'|'exclude'}};
export function validateRule(value:unknown):Omit<Rule,'id'> {
 const r=object(value,['name','enabled','priority','conditions','assignments']),c=object(r.conditions,['merchantEquals','merchantContains','descriptionContains','accountId','bankId','counterpartyId','counterpartyBankIdentity','direction','kind','amountFromMinor','amountThroughMinor','currency']),a=object(r.assignments,['role','kind','categoryId','subcategoryId','merchant','counterpartyId','analyticsOverride']);
 if(Object.keys(c).length===0||Object.keys(a).length===0||typeof r.enabled!=='boolean'||typeof r.priority!=='number'||!Number.isInteger(r.priority)||Math.abs(r.priority)>10000)throw new TypeError('INVALID_RULE');
 const conditions:Rule['conditions']={},assignments:Rule['assignments']={};
 for(const k of ['merchantEquals','merchantContains','descriptionContains','bankId']as const)if(k in c){conditions[k]=safeText(c[k],160);if(!conditions[k])throw new TypeError('EMPTY_CONDITION');}
 for(const k of ['accountId','counterpartyId']as const)if(k in c)conditions[k]=uuid(c[k]);
 if('counterpartyBankIdentity'in c){if(c.counterpartyBankIdentity!==true||typeof a.counterpartyId!=='string')throw new TypeError('INVALID_COUNTERPARTY_CONDITION');conditions.counterpartyBankIdentity=true;}
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
 const c=rule.conditions;
 if(!Object.keys(c).length)return false;
 const f=effective(operation),amount=BigInt(f.amountMinor),text=(s:string)=>s.normalize('NFKC').toLocaleLowerCase('ru-RU');
 // Freeze the former matching input only for an intact, untouched /5 bank
 // initializer. Manual/private/global/AI names still match their actual value.
 const compat=operation.source.versions.sourceSanitizer==='bank-source/5'&&operation.source.versions.sourceTextEvidence==='intact'&&operation.semantics.merchant.source==='bank'&&!operation.semantics.merchant.userVerified&&operation.semantics.merchant.value===operation.source.merchantText;
 const sourceMerchant=compat?legacyRuleSourceMerchant(operation.source.description,operation.source.amountMinor,operation.source.merchantText):f.merchantText;
 const semanticMerchant=compat?recognizeMerchant(sourceMerchant,operation.source.description).name:operation.semantics.merchant.value;
 const sameMerchant=(value:string)=>{if(text(semanticMerchant)===text(value)||text(sourceMerchant)===text(value))return true;const left=recognizeMerchant(semanticMerchant),right=recognizeMerchant(value);return left.matched&&right.matched&&!left.conflict&&!right.conflict&&(text(value)===text(right.name)||right.brand==='TimeWeb'&&/^(?:таймвэб|timeweb(?:[ .]cloud)?)$/iu.test(value.trim()))&&(left.brand??left.name)===(right.brand??right.name);};
 const merchantContains=(value:string)=>{
  if(text(semanticMerchant).includes(text(value)))return true;
  const field=operation.semantics.merchant;
  if(field.userVerified||['user','personal_rule','global_rule','ai'].includes(field.source)||operation.source.versions.sourceSanitizer==='bank-source/5'&&operation.source.versions.sourceTextEvidence!=='intact')return false;
  if(!semanticMerchant&&text(f.merchantText).includes(text(value)))return true;
  const actual=recognizeMerchant(semanticMerchant),expected=recognizeMerchant(value);
  return actual.matched&&expected.matched&&!actual.conflict&&!expected.conflict&&text(expected.name)===text(value)&&!!actual.brand&&actual.brand===expected.brand&&merchantKey(actual.name)===merchantKey(value);
 };
 const descriptionMatches=(value:string)=>text(f.description).includes(text(value))||['вендинг','vending'].includes(text(value))&&merchantKey(f.description).includes('vending');
 return (!c.merchantEquals||sameMerchant(c.merchantEquals))&&(!c.merchantContains||merchantContains(c.merchantContains)||text(c.merchantContains)==='таймвэб'&&recognizeMerchant(semanticMerchant).brand==='TimeWeb')&&(!c.descriptionContains||descriptionMatches(c.descriptionContains))&&(!c.accountId||c.accountId===f.accountId)&&(!c.bankId||c.bankId===account.bankId)&&(!c.counterpartyId||c.counterpartyId===operation.semantics.counterparty.value)&&(!c.counterpartyBankIdentity||!!operation.bankCounterpartyId&&operation.bankCounterpartyId===rule.assignments.counterpartyId)&&(!c.kind||c.kind===operation.semantics.kind.value)&&(!c.direction||c.direction==='in'&&amount>0n||c.direction==='out'&&amount<0n)&&(c.amountFromMinor===undefined||amount>=BigInt(c.amountFromMinor))&&(c.amountThroughMinor===undefined||amount<=BigInt(c.amountThroughMinor))&&(!c.currency||c.currency===f.currency);
}
/** Updating a rule never calls this on old operations; history needs a separate preview command. */
export function applyRules(operation:Operation,account:Account,rules:Rule[],onlyRuleId?:string,categories?:readonly Category[]):Operation {
 const op=structuredClone(operation);
 const matching=rules.filter(r=>r.enabled&&ruleMatches(op,account,r)).sort((a,b)=>Object.keys(b.conditions).length-Object.keys(a.conditions).length||b.priority-a.priority);
 let anyConflict=false,selectedConflict=false,selectedAssignment=false;
 const contenders=(assignment:keyof Rule['assignments'])=>{
  const offered=matching.filter(r=>assignment in r.assignments),first=offered[0];
  if(!first)return [];
  const ties=offered.filter(r=>Object.keys(r.conditions).length===Object.keys(first.conditions).length&&r.priority===first.priority);
  const scoped=!onlyRuleId||ties.some(r=>r.id===onlyRuleId);
  if(scoped)selectedAssignment=true;
  if(new Set(ties.map(r=>JSON.stringify(r.assignments[assignment]))).size>1){
   anyConflict=true;
   if(scoped)selectedConflict=true;
   return [];
  }
  return scoped?ties:[];
 };
 const assigned=new Set<keyof Operation['semantics']>();
 const mapping={role:'role',kind:'kind',categoryId:'category',subcategoryId:'subcategory',merchant:'merchant',counterpartyId:'counterparty'}as const;
 for(const [assignment,key]of Object.entries(mapping)as [keyof typeof mapping,typeof mapping[keyof typeof mapping]][]){
  const current=op.semantics[key];if(current.userVerified||key==='kind'&&current.source==='bank'&&current.confidence>=90)continue;
  const ties=contenders(assignment);if(!ties.length)continue;
  const winner=ties.find(r=>r.id===onlyRuleId)??ties[0]!;
  assigned.add(key);
  (op.semantics as Record<string,unknown>)[key]={...facet(winner.assignments[assignment],'personal_rule'),ruleId:winner.id};
 }
 if(categories&&(['role','category','subcategory'] as const).some(key=>assigned.has(key))){
  const {role,category,subcategory}=op.semantics;
  const root=categories.find(c=>c.id===category.value),child=categories.find(c=>c.id===subcategory.value);
  const allows=(c:Category)=>!['expense','income'].includes(role.value)||c.role==='both'||c.role===role.value;
  const rootValid=category.value===null||!!root&&!root.parentId&&allows(root);
  const childValid=subcategory.value===null||!!root&&!!child&&child.parentId===root.id&&allows(child);
  if(!rootValid||!childValid){
   if(rootValid&&assigned.has('category')&&!assigned.has('subcategory')&&!subcategory.userVerified){
    op.semantics.subcategory={...category,value:null};
   }else for(const key of ['role','category','subcategory'] as const){
    (op.semantics as Record<string,unknown>)[key]=operation.semantics[key];assigned.delete(key);
   }
  }
 }
 const resolvedReasons=new Set<string>();
 if(assigned.has('kind'))resolvedReasons.add('low_kind_confidence');
 if(assigned.has('role')&&op.semantics.role.value!=='unresolved')for(const reason of ['low_role_confidence','unresolved_role','unresolved_transfer'])resolvedReasons.add(reason);
 if(assigned.has('category')&&op.semantics.category.value!==null)resolvedReasons.add('low_category_confidence');
 op.reviewReasons=op.reviewReasons.filter(reason=>!resolvedReasons.has(reason));
 // Explicit transaction inclusion is a manual decision and is never overwritten.
 if(op.analyticsOverride==='default'){
  const ties=contenders('analyticsOverride');
  if(ties.length)op.analyticsOverride=ties[0]!.assignments.analyticsOverride!;
 }
 if(selectedConflict&&!op.reviewReasons.includes('conflicting_rules'))op.reviewReasons.push('conflicting_rules');
 if(!anyConflict&&(!onlyRuleId||selectedAssignment))op.reviewReasons=op.reviewReasons.filter(reason=>reason!=='conflicting_rules');
 return op;
}
