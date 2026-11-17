import {legacyRuleSourceMerchant} from './legacy-source-merchant.ts';
import {bankMerchantLiteral} from './bank-merchant.ts';
import {recognizeCatalogEvidence} from './catalog-evidence.ts';
import {merchantKey,recognizeMerchant} from './merchant-recognition.ts';
import {effective,facet,object,choice,uuid,kinds} from './model.ts';
import type {Operation,Account,Category,Role,Kind} from './model.ts';
import {parsePersistedMinor} from './money.ts';
import {safeText} from '../../privacy/src/text.ts';
export type Rule={id:string;name:string;enabled:boolean;priority:number;conditions:{merchantEquals?:string;merchantContains?:string;descriptionContains?:string;accountId?:string;bankId?:string;counterpartyId?:string;bankCounterpartyId?:string;counterpartyBankIdentity?:true;direction?:'in'|'out';kind?:Kind;amountFromMinor?:string;amountThroughMinor?:string;currency?:'RUB'};assignments:{role?:Role;kind?:Kind;categoryId?:string|null;subcategoryId?:string|null;merchant?:string;counterpartyId?:string|null;analyticsOverride?:'default'|'include'|'exclude'}};
export function validateRule(value:unknown):Omit<Rule,'id'> {
 const r=object(value,['name','enabled','priority','conditions','assignments']),c=object(r.conditions,['merchantEquals','merchantContains','descriptionContains','accountId','bankId','counterpartyId','bankCounterpartyId','counterpartyBankIdentity','direction','kind','amountFromMinor','amountThroughMinor','currency']),a=object(r.assignments,['role','kind','categoryId','subcategoryId','merchant','counterpartyId','analyticsOverride']);
 if(Object.keys(c).length===0||Object.keys(a).length===0||typeof r.enabled!=='boolean'||typeof r.priority!=='number'||!Number.isInteger(r.priority)||Math.abs(r.priority)>10000)throw new TypeError('INVALID_RULE');
 const conditions:Rule['conditions']={},assignments:Rule['assignments']={};
 for(const k of ['merchantEquals','merchantContains','descriptionContains','bankId']as const)if(k in c){conditions[k]=safeText(c[k],160);if(!conditions[k])throw new TypeError('EMPTY_CONDITION');}
 for(const k of ['accountId','counterpartyId','bankCounterpartyId']as const)if(k in c)conditions[k]=uuid(c[k]);
 if('counterpartyBankIdentity'in c){if(c.counterpartyBankIdentity!==true||typeof a.counterpartyId!=='string')throw new TypeError('INVALID_COUNTERPARTY_CONDITION');conditions.counterpartyBankIdentity=true;}
 if('direction'in c)conditions.direction=choice(c.direction,['in','out']);if('kind'in c)conditions.kind=choice(c.kind,kinds);if('currency'in c)conditions.currency=choice(c.currency,['RUB']);
 for(const k of ['amountFromMinor','amountThroughMinor']as const)if(k in c){parsePersistedMinor(c[k]);conditions[k]=c[k] as string;}
 if(conditions.amountFromMinor!==undefined&&conditions.amountThroughMinor!==undefined&&BigInt(conditions.amountFromMinor)>BigInt(conditions.amountThroughMinor))throw new TypeError('INVALID_RANGE');
 if('role'in a)assignments.role=choice(a.role,['expense','income','neutral','unresolved']);if('kind'in a)assignments.kind=choice(a.kind,kinds);
 for(const k of ['categoryId','subcategoryId','counterpartyId']as const)if(k in a)assignments[k]=a[k]===null?null:uuid(a[k]);
 if('merchant'in a)assignments.merchant=safeText(a.merchant,160);if('analyticsOverride'in a)assignments.analyticsOverride=choice(a.analyticsOverride,['default','include','exclude']);
 return {name:safeText(r.name,160),enabled:r.enabled,priority:r.priority,conditions,assignments};
}
/** Review decisions use the bank's stable, tenant-scoped identity for transfers. */
export function reviewRuleSource(kind:Kind,amountMinor:string,merchant:string,hasBankCounterparty:boolean):'transfer'|'purchase'|undefined{
 const amount=BigInt(amountMinor);
 if(amount===0n)return;
 if((kind==='transfer_in'||kind==='transfer_out'||kind==='own_transfer')&&hasBankCounterparty)return 'transfer';
 if(kind==='purchase'&&amount<0n&&merchant.trim())return 'purchase';
}
export function reviewRuleConditions(operation:Operation,draft:{kind?:Kind;merchant?:string}={}):Rule['conditions']|undefined{
 const fact=effective(operation),kind=draft.kind??operation.semantics.kind.value,amount=BigInt(fact.amountMinor),merchant=(draft.merchant??operation.semantics.merchant.value).trim();
 if(amount===0n)return;
 const direction=amount<0n?'out':'in';
 const accountId=fact.accountId;
 const source=reviewRuleSource(kind,fact.amountMinor,merchant,!!operation.bankCounterpartyId);
 if(source==='transfer'&&kind==='own_transfer')return {bankCounterpartyId:operation.bankCounterpartyId};
 if(source==='transfer')return {bankCounterpartyId:operation.bankCounterpartyId,accountId,direction,kind};
 if(source==='purchase')return {merchantEquals:operation.semantics.merchant.value.trim()||merchant,accountId,direction,kind};
}
/** The same closed predicate is used for future imports and explicit historical selection. */
export function ruleMatches(operation:Operation,account:Account,rule:Rule):boolean {
 const c=rule.conditions;
 if(c.bankCounterpartyId&&rule.assignments.kind==='own_transfer'&&!['transfer_in','transfer_out','own_transfer'].includes(operation.semantics.kind.value))return false;
 if(!Object.keys(c).length)return false;
 const f=effective(operation),amount=BigInt(f.amountMinor),text=(s:string)=>s.normalize('NFKC').toLocaleLowerCase('ru-RU');
 // Freeze the former matching input only for an intact, untouched /5 bank
 // initializer. Manual/private/global/AI names still match their actual value.
 const compat=operation.source.versions.sourceSanitizer==='bank-source/5'&&operation.source.versions.sourceTextEvidence==='intact'&&operation.semantics.merchant.source==='bank'&&!operation.semantics.merchant.userVerified&&operation.semantics.merchant.value===operation.source.merchantText;
 const sourceMerchant=compat?legacyRuleSourceMerchant(operation.source.description,operation.source.amountMinor,operation.source.merchantText):f.merchantText;
 const semanticMerchant=compat?recognizeMerchant(sourceMerchant,operation.source.description).name:operation.semantics.merchant.value;
 const automaticName=!operation.semantics.merchant.userVerified&&['bank','deterministic_system_rule'].includes(operation.semantics.merchant.source)&&operation.source.versions.sourceSanitizer==='bank-source/5'&&operation.source.versions.sourceTextEvidence==='intact';
 const aliasEqual=(value:string)=>{
  if(automaticName&&(text(bankMerchantLiteral(operation.source))===text(value)||text(operation.source.merchantText)===text(value)))return true;
  const actual=recognizeCatalogEvidence({merchantText:semanticMerchant,description:operation.source.description}),expected=recognizeCatalogEvidence({merchantText:value,description:''});
  return actual.status==='recognized'&&expected.status==='recognized'&&actual.entry.name===expected.entry.name&&[expected.entry.name,...expected.entry.aliases].some(alias=>text(alias)===text(value));
 };
 const sameMerchant=(value:string)=>{if(text(semanticMerchant)===text(value)||text(sourceMerchant)===text(value)||aliasEqual(value))return true;const left=recognizeMerchant(semanticMerchant),right=recognizeMerchant(value);return left.matched&&right.matched&&!left.conflict&&!right.conflict&&(text(value)===text(right.name)||right.brand==='TimeWeb'&&/^(?:таймвэб|timeweb(?:[ .]cloud)?)$/iu.test(value.trim()))&&(left.brand??left.name)===(right.brand??right.name);};
 const merchantContains=(value:string)=>{
  if(text(semanticMerchant).includes(text(value)))return true;
  const field=operation.semantics.merchant;
  if(field.userVerified||['user','personal_rule','global_rule','ai'].includes(field.source)||operation.source.versions.sourceSanitizer==='bank-source/5'&&operation.source.versions.sourceTextEvidence!=='intact')return false;
  if(automaticName&&text(bankMerchantLiteral(operation.source)).includes(text(value)))return true;
  if(!semanticMerchant&&text(f.merchantText).includes(text(value)))return true;
  const actual=recognizeMerchant(semanticMerchant),expected=recognizeMerchant(value);
  return actual.matched&&expected.matched&&!actual.conflict&&!expected.conflict&&text(expected.name)===text(value)&&!!actual.brand&&actual.brand===expected.brand&&merchantKey(actual.name)===merchantKey(value);
 };
 const descriptionMatches=(value:string)=>text(f.description).includes(text(value))||['вендинг','vending'].includes(text(value))&&merchantKey(f.description).includes('vending');
 return (!c.merchantEquals||sameMerchant(c.merchantEquals))&&(!c.merchantContains||merchantContains(c.merchantContains)||text(c.merchantContains)==='таймвэб'&&recognizeMerchant(semanticMerchant).brand==='TimeWeb')&&(!c.descriptionContains||descriptionMatches(c.descriptionContains))&&(!c.accountId||c.accountId===f.accountId)&&(!c.bankId||c.bankId===account.bankId)&&(!c.counterpartyId||c.counterpartyId===operation.semantics.counterparty.value)&&(!c.bankCounterpartyId||c.bankCounterpartyId===operation.bankCounterpartyId)&&(!c.counterpartyBankIdentity||!!operation.bankCounterpartyId&&operation.bankCounterpartyId===rule.assignments.counterpartyId)&&(!c.kind||c.kind===operation.semantics.kind.value||['transfer_in','transfer_out'].includes(c.kind)&&operation.semantics.kind.value==='own_transfer'&&operation.semantics.kind.source==='deterministic_system_rule'&&c.kind===(amount<0n?'transfer_out':'transfer_in'))&&(!c.direction||c.direction==='in'&&amount>0n||c.direction==='out'&&amount<0n)&&(c.amountFromMinor===undefined||amount>=BigInt(c.amountFromMinor))&&(c.amountThroughMinor===undefined||amount<=BigInt(c.amountThroughMinor))&&(!c.currency||c.currency===f.currency);
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
  const current=op.semantics[key];if(current.userVerified)continue;
  if(key==='kind'&&current.source==='bank'&&current.confidence>=90){const proposed=matching.find(r=>r.assignments.kind!==undefined)?.assignments.kind;if(!['transfer_in','transfer_out','own_transfer'].includes(op.semantics.kind.value)||!proposed||!['transfer_in','transfer_out','own_transfer'].includes(proposed))continue;}
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
