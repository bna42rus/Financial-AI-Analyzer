import {merchantNames,legacySourceAliases as aliases} from '../../finance-core/src/legacy-source-merchant.ts';
import type {MerchantCode} from '../../finance-core/src/legacy-source-merchant.ts';
export {merchantNames};
export type {MerchantCode};
import {bankDescription,parseBankDescription,merchantBankDescription,parseMerchantBankDescription,financialTransferText} from './bank-description.ts';
import type {BankDescription,MerchantBankDescription} from './bank-description.ts';
import type {Kind} from '../../finance-core/src/model.ts';

/** Legacy finite profiles remain unchanged. /4 adds locally sanitized bank text. */
export const legacySourceSanitizer='bank-source/1' as const;
export const sourceSanitizer='bank-source/2' as const;
export const localSourceSanitizer='bank-source/3' as const;
export const descriptionSourceSanitizer='bank-source/4' as const;
export const merchantSourceSanitizer='bank-source/5' as const;
export const sourceProfiles=[legacySourceSanitizer,sourceSanitizer,localSourceSanitizer,descriptionSourceSanitizer,merchantSourceSanitizer] as const;
export const hasBankDescription=(profile:unknown)=>profile===descriptionSourceSanitizer||profile===merchantSourceSanitizer;
const legacyMerchants=['ozon','wildberries','pyaterochka','magnit','perekrestok','lenta'];
export type SafeSource={event:'other'|'purchase'|'refund'|'fee'|'cash_withdrawal'|'cash_deposit'|'cashback'|'transfer_in'|'transfer_out';merchant:MerchantCode|null;details?:BankDescription|MerchantBankDescription};
const labels={purchase:'Покупка',refund:'Возврат покупки',fee:'Комиссия банка',cash_withdrawal:'Снятие наличных',cash_deposit:'Внесение наличных',cashback:'Кешбэк',transfer_in:'Входящий перевод',transfer_out:'Исходящий перевод'} as const;

export function parseSafeSource(value:unknown,amountMinor?:string,profile:typeof sourceProfiles[number]=sourceSanitizer):SafeSource|null{
 if(value===null)return null;
 if(!value||typeof value!=='object'||Array.isArray(value))throw new TypeError('INVALID_SAFE_SOURCE');
 const r=value as Record<string,unknown>;
 const detailed=hasBankDescription(profile);
 if(Object.keys(r).length!==(detailed?3:2)||detailed&&!Object.hasOwn(r,'details')||!Object.hasOwn(r,'event')||!Object.hasOwn(r,'merchant')||!((profile===localSourceSanitizer||detailed)?[...(detailed?['other']:[]),'purchase','refund','fee','cash_withdrawal','cash_deposit','cashback','transfer_in','transfer_out']:['purchase','refund','fee']).includes(r.event as string)||r.merchant!==null&&(!Object.hasOwn(merchantNames,r.merchant as string)||typeof r.merchant!=='string'||profile===legacySourceSanitizer&&!legacyMerchants.includes(r.merchant)))throw new TypeError('INVALID_SAFE_SOURCE');
 const event=r.event as SafeSource['event'];
 if(amountMinor!==undefined&&event!=='other'&&(['refund','cash_deposit','cashback','transfer_in'].includes(event)?BigInt(amountMinor)<=0n:BigInt(amountMinor)>=0n)||!['purchase','refund'].includes(event)&&r.merchant!==null)throw new TypeError('INVALID_SAFE_SOURCE');
 return {event,merchant:r.merchant as MerchantCode|null,...(detailed?{details:profile===merchantSourceSanitizer?parseMerchantBankDescription(r.details):parseBankDescription(r.details)}:{})};
}
/** Device-only input to a keyed digest. It must never become a persisted label. */
export function normalizeSourceDescription(text:unknown):string|null{
 if(typeof text!=='string'||text.length>4000||/[\p{Cc}\p{Cf}]/u.test(text.replace(/[\n\r\t]/g,'')))return null;
 return text.normalize('NFKC').toLowerCase().replace(/ё/g,'е').replace(/\s+/g,' ').trim()||null;
}
/** Deliberately narrow templates; unknown or conflicting text supplies no signal. */
export function extractSafeSource(text:unknown,amountMinor:unknown,profile:typeof sourceProfiles[number]=sourceSanitizer):SafeSource|null{
 if(hasBankDescription(profile)){
  const details=profile===merchantSourceSanitizer?merchantBankDescription(text):bankDescription(text);
  let base=extractSafeSource(text,amountMinor,localSourceSanitizer);
  // /1../4 retain their frozen finite templates. /5 can keep a commercial
  // payment that contains перевод without manufacturing a money transfer.
  if(!base&&profile===merchantSourceSanitizer&&'textEvidence' in details&&details.textEvidence==='intact'&&!financialTransferText(details.description)){
   const purchase=/^(?:оплата товаров и услуг|оплата покупки|покупка(?: в)?|оплата услуг|оплата в|оплата по карте|оплата картой|purchase|card payment)\s*[:.-]?\s+.+$/iu.test(details.description);
   const refund=/^(?:возврат покупки|возврат средств за покупку|возврат оплаты|purchase refund|refund)\s*[:.-]?\s+.+$/iu.test(details.description);
   if(purchase||refund){try{base=parseSafeSource({event:purchase?'purchase':'refund',merchant:null},typeof amountMinor==='string'?amountMinor:undefined,localSourceSanitizer);}catch{/* No sign-consistent event. */}}
  }
  if(!details.description)return null;
  return parseSafeSource({...base??{event:'other',merchant:null},details},typeof amountMinor==='string'?amountMinor:undefined,profile);
 }
 const s=normalizeSourceDescription(text);if(!s||typeof amountMinor!=='string'||! /^-?\d{1,19}$/.test(amountMinor))return null;
 if(profile===localSourceSanitizer){
  const match=/^(снятие наличных|внесение наличных|кешбэк|кэшбэк|входящий перевод|исходящий перевод)(?:$|\s)/u.exec(s);
  if(match&&!/возврат|комисси|refund|fee/u.test(s)){
   const event=({'снятие наличных':'cash_withdrawal','внесение наличных':'cash_deposit','кешбэк':'cashback','кэшбэк':'cashback','входящий перевод':'transfer_in','исходящий перевод':'transfer_out'} as Record<string,SafeSource['event']>)[match[1]!]!;
   try{return parseSafeSource({event,merchant:null},amountMinor,profile);}catch{return null;}
  }
 }
 // Transfer/recipient and mixed-event evidence never becomes a merchant purchase.
 if(/перевод|получател|отправител|transfer|recipient|возврат.*комисси/u.test(s))return null;
 let event:SafeSource['event'],tail:string;
 const purchase=/^(?:оплата товаров и услуг|оплата покупки|покупка|оплата в|оплата по карте|оплата картой|purchase|card payment)\s*[:.-]?\s+(.+)$/u.exec(s),refund=/^(?:возврат покупки|возврат средств за покупку|возврат оплаты|purchase refund|refund)\s*[:.-]?\s+(.+)$/u.exec(s);
 if(purchase&&!/возврат|комиссия|refund|fee/u.test(s)){event='purchase';tail=purchase[1]!;}
 else if(refund){event='refund';tail=refund[1]!;}
 else if(/^комиссия банка(?:\s|$)/u.test(s)){event='fee';tail='';}
 else return null;
 const merchant=(Object.keys(aliases) as MerchantCode[]).find(code=>aliases[code].test(tail))??null;
 try{return parseSafeSource({event,merchant},amountMinor,profile);}catch{return null;}
}
export function sourceFields(source:SafeSource|null|undefined,profile:unknown=sourceSanitizer):{sourceKind:Kind;merchantText:string;description:string;bankCategory?:string;sourceMcc?:string|null}{
 return source?{sourceKind:source.event,merchantText:profile===merchantSourceSanitizer?source.details?.merchantText??'':source.merchant===null?source.details?.merchantText??'':merchantNames[source.merchant],description:source.details?.description??(source.event==='other'?'':labels[source.event]),...(source.details?{bankCategory:source.details.bankCategory,sourceMcc:source.details.mcc}: {})}:{sourceKind:'other',merchantText:'',description:''};
}
