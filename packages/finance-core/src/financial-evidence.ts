import {defaultRole,effective,facet,initialSemantics} from './model.ts';
import type {BankFact,Category,Operation,Semantics} from './model.ts';
import {parsePersistedMinor} from './money.ts';
import {resolveOwnCategory} from './category-resolution.ts';
import {catalogFold} from './catalog-lexical.ts';

export const financialEvidenceVersion='cashneuro-financial-evidence/1' as const;
const interestRule=financialEvidenceVersion+':bank-interest';
type FinancialSource=Pick<BankFact,'sourceKind'|'merchantText'|'amountMinor'|'description'|'versions'>;
type InterestEvidence={role:'income'|'expense';subject:'deposit'|'loan'};
/** Whole, explicit cash event headings, never a bank/brand/category/comment match.
 * Unknown, forecast, return and composite movements need their own evidence. */
export function bankInterestEvidence(source:FinancialSource):InterestEvidence|null{
 if(source.versions.sourceSanitizer!=='bank-source/5'||source.versions.sourceTextEvidence!=='intact'||!['other','interest'].includes(source.sourceKind??'other'))return null;
 const text=catalogFold(source.description),amount=parsePersistedMinor(source.amountMinor);
 if(!amount||/[\p{Cf}]/u.test(source.description)||/(?:^|[^\p{L}\p{N}])(?:не|без|возврат\p{L}*|отмен\p{L}*|прогноз\p{L}*|ожида\p{L}*|планов\p{L}*|расчет\p{L}*|предварительн\p{L}*|компенсац\p{L}*|корректиров\p{L}*|бонус\p{L}*)(?=$|[^\p{L}\p{N}])/u.test(text))return null;
 const deposit='(?:по (?:вкладу|депозиту|накопительному счету|счету)|на остаток(?: по счету)?)',loan='(?:по (?:кредиту|займу|кредитной карте))';
 // A technical tail may identify a period/reference; another monetary event
 // cannot silently become a single interest payment.
 const tail='(?:$|[\\s:;,.—–-].*)';
 if(/(?:principal|погашени\p{L}*|комисси\p{L}*|страхов\p{L}*|тело кредита|основно[йг]\p{L}* долг|сумма вклада|с возвратом|покупк\p{L}*|перевод\p{L}*)/u.test(text))return null;
 if(amount>0n&&new RegExp('^(?:(?:выплата|начисление|зачисление|получение) процентов '+deposit+'|проценты '+deposit+')'+tail,'u').test(text))return {role:'income',subject:'deposit'};
 if(amount<0n&&new RegExp('^(?:(?:уплата|оплата|списание|удержание) процентов '+loan+'|проценты '+loan+')'+tail,'u').test(text))return {role:'expense',subject:'loan'};
 return null;
}

/** Source initialization is separate from the immutable source fact. Legacy
 * finite extraction and bank sourceKind are not rewritten by this policy. */
export function initialBankSemantics(source:FinancialSource,merchant=source.merchantText):Semantics{
 const semantics=initialSemantics(source.sourceKind??'other',merchant,source.amountMinor);
 if(semantics.kind.value==='other'){
  semantics.kind=facet('other','bank',false,0);
  const interest=bankInterestEvidence(source);
  if(interest){semantics.kind={...facet('interest'),ruleId:interestRule};semantics.role={...facet(interest.role),ruleId:interestRule};}
 }
 return semantics;
}
const automaticKind=(s:Semantics)=>!s.kind.userVerified&&(s.kind.source==='bank'||s.kind.source==='deterministic_system_rule'&&s.kind.ruleId===interestRule);
/** Refresh only the bank initializer/current policy. Private, global, AI and
 * verified decisions survive reimports; lost evidence does not linger. */
export function refreshBankSemantics(previous:Semantics,source:FinancialSource):Semantics{
 const out=structuredClone(previous),fresh=initialBankSemantics(source);
 if(automaticKind(previous)){
  out.kind=fresh.kind;
  if(!previous.role.userVerified&&previous.role.source==='deterministic_system_rule'&&(previous.kind.value!==fresh.kind.value||fresh.kind.value==='interest'||previous.kind.value==='interest'))out.role=fresh.role;
 }
 if(!previous.merchant.userVerified&&previous.merchant.source==='bank'&&(source.merchantText||previous.kind.value!==fresh.kind.value))out.merchant=fresh.merchant;
 return out;
}
/** Read-only effective direction, including amount correction and its reset.
 * A role chosen by the owner/private/global/model remains independent. */
export function effectiveFinancialRole(operation:Operation){
 const role=operation.semantics.role;
 return operation.semantics.kind.value==='interest'&&!role.userVerified&&['bank','deterministic_system_rule'].includes(role.source)?{...role,value:defaultRole('interest',effective(operation).amountMinor)}:role;
}
/** Only an explicit subject and a unique visible compatible own node qualify.
 * A broad or missing private tree never causes category creation/resurrection. */
export function applyFinancialRecognition(operation:Operation,categories:readonly Category[]):Operation{
 if(operation.decomposition||operation.semantics.kind.value!=='interest')return operation;
 const evidence=bankInterestEvidence(operation.source),role=effectiveFinancialRole(operation).value,c=operation.semantics.category,sub=operation.semantics.subcategory;
 if(!evidence||evidence.role!==role||[c,sub].some(f=>f.userVerified||f.value!==null||!['bank','deterministic_system_rule'].includes(f.source)))return operation;
 const target=evidence.subject==='deposit'?{key:'received_interest',path:['Проценты и инвестиции','Проценты по счетам и вкладам'],labels:['Проценты по счетам и вкладам','Проценты по вкладам','Проценты по депозитам']}: {key:'paid_loan_interest',path:['Кредиты и долги','Проценты'],labels:['Проценты','Проценты по кредиту','Проценты по кредитам']};
 const own=resolveOwnCategory(target.key,categories,role,{target});if(own.status!=='resolved')return operation;
 return {...operation,semantics:{...operation.semantics,category:{...facet(own.categoryId),ruleId:interestRule},subcategory:{...facet(own.subcategoryId),ruleId:interestRule}}};
}
