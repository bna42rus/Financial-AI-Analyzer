import type {Account,BankFact,Operation} from './model.ts';
import {catalogFold,hasLiteral} from './catalog-lexical.ts';
export const installmentPolicyVersion='cashneuro-installment-contract/1' as const;
/** A brand is not a contract. Only an explicit outgoing repayment heading
 * qualifies; split category allocations and a halva grocery do not. */
export function installmentPaymentEvidence(source:Pick<BankFact,'description'|'amountMinor'|'versions'>):boolean{
 if(source.versions.sourceSanitizer!=='bank-source/5'||source.versions.sourceTextEvidence!=='intact'||BigInt(source.amountMinor)>=0n)return false;
 const text=catalogFold(source.description);
 if(hasLiteral(text,['не платеж','без платежа','возврат','отмена','прогноз','плановый график','покупка халвы','разделить покупку']))return false;
 const heading=/^(?:(?:очередной|ежемесячный|первый|второй|последний) )?(?:платеж|погашение|списание)(?=$|[^\p{L}\p{N}])/u.test(text);
 return heading&&hasLiteral(text,['по рассрочке','по договору рассрочки','платеж частями','платеж долями','сервис долями','сервиса долями','по договору долями','dolyame','dolyami','doliami','яндекс сплит','yandex split','супер сплит','super split','плати частями','карта халва']);
}
export type InstallmentAssessment={status:'not_applicable'|'owner_decision'|'existing_model'}|{status:'BLOCKED_UNSUPPORTED_CONTRACT';reason:'INSTALLMENT_MODEL_REQUIRED'};
export function assessInstallmentContract(op:Operation,account:Account|undefined):InstallmentAssessment{
 if(!installmentPaymentEvidence(op.source))return {status:'not_applicable'};
 const {kind,role}=op.semantics;
 if(op.decomposition||[kind,role].some(f=>f.userVerified||['user','personal_rule'].includes(f.source)))return {status:'owner_decision'};
 // Independently established bank kind on a compatible real owned account.
 // The service name never creates that mapping, a debt or a second purchase.
 if(kind.source==='bank'&&kind.confidence>=90&&(kind.value==='loan_payment'&&account?.type==='loan'||kind.value==='credit_card_repayment'&&account?.type==='credit_card'))return {status:'existing_model'};
 return {status:'BLOCKED_UNSUPPORTED_CONTRACT',reason:'INSTALLMENT_MODEL_REQUIRED'};
}
