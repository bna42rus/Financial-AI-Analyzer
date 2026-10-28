import {sanitizeText,safeText} from '../../privacy/src/text.ts';

export type BankDescription={description:string;merchantText:string;bankCategory:string;mcc:string|null};
export type MerchantBankDescription=BankDescription&{textEvidence:'intact'|'unknown'};
const hidden='[скрыто]';
/** Device-side before transmission; repeated independently by the server. Raw
 * files and identity HMAC inputs remain device-only. Names and ordinary numbers
 * stay readable; retaining a transfer description does not make it a merchant. */
export function cleanBankText(value:unknown,max=1000):string{
 if(typeof value!=='string'||value.length>4000)return '';
 const source=value.normalize('NFKC').replace(/\p{Cf}/gu,'').replace(/[\r\n\t]/g,' ').replace(/(?:https?|ftp):\/\/\S+|www\.\S+/giu,hidden);
 const labelled=source.replace(/(?<![\p{L}\p{N}])(?:договор(?:а|у|ом|е|ов)?|контракт(?:а|у|ом|е)?|contract|agreement)\s*(?:(?:№|номер|number|no\.?|n|:|=|#)\s*|(?=[\p{L}\p{N}._\/-]*\d))(?!\[)(?:[\p{L}\p{N}][\p{L}\p{N}._\/-]{0,127})(?:[ -]+\d[\d._\/-]*)*/giu,hidden);
 const text=sanitizeText(labelled)
  .replace(/(?<![\p{L}\p{N}])(?:ИНН|БИК|СНИЛС|inn|bic|snils)\s*(?:№|:|=|#)?\s*\d[\d -]{2,}\d/giu,hidden)
  .replace(/(?<![\p{L}\p{N}])(?:карт[аы]|сч[её]т(?:а)?|договор|телефон|паспорт|card|account|contract|phone|passport)\s*(?:№|номер|number|:|=|#)?\s*(?=[+\d*хХxX])(?:[+\d*хХxX() -]{3,})/giu,hidden+' ')
  .replace(/(?:\b(?:rrn|arn|auth|authorization|ref|reference|terminal|tid|mid|inn|snils|iban|bic|swift)\b|ИНН|СНИЛС|БИК|РРН|терминал|идентификатор|документ|код авторизации|авторизаци(?:я|и)|номер операции|номер документа|номер договора|номер сч[её]та|номер карты|код операции)\s*(?:№|:|=|#)?\s*[\p{L}\p{N}._\/-]+/giu,hidden)
  .replace(/\[реквизиты скрыты\]/g,hidden).replace(/(?:\[скрыто\]\s*){2,}/g,hidden+' ')
  .replace(/\s+/g,' ').trim();
 return text.slice(0,max).trim();
}
export function bankDescription(description:unknown,merchant:unknown='',bankCategory:unknown='',mcc:unknown=null):BankDescription{
 const text=cleanBankText(description),category=cleanBankText(bankCategory,160);
 let name=cleanBankText(merchant,160);
 if(!name){const match=/^(?:оплата товаров и услуг|оплата покупки|покупка(?: в)?|оплата в|оплата по карте|оплата картой|purchase|card payment|возврат покупки|возврат средств за покупку|возврат оплаты|purchase refund|refund)\s*[:.-]?\s+(.+)$/iu.exec(text);name=match?.[1]?.slice(0,160).trim()??'';}
 if(/перевод|transfer|\bSBP\b|СБП/iu.test(text)||/\[скрыто\]/u.test(name)&&!/[\p{L}]{2,}/u.test(name.replaceAll(hidden,'')))name='';
 return {description:text,merchantText:name,bankCategory:category,mcc:typeof mcc==='string'&&/^[0-9]{4}$/.test(mcc)&&mcc!=='0000'?mcc:null};
}
export function parseBankDescription(value:unknown):BankDescription{
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error('INVALID_BANK_DESCRIPTION');
 const r=value as Record<string,unknown>;
 if(Object.keys(r).sort().join(',')!=='bankCategory,description,mcc,merchantText')throw Error('INVALID_BANK_DESCRIPTION');
 const result={description:safeText(r.description,1000),merchantText:safeText(r.merchantText,160),bankCategory:safeText(r.bankCategory,160),mcc:r.mcc};
 if(result.mcc!==null&&(typeof result.mcc!=='string'||!/^\d{4}$/.test(result.mcc)||result.mcc==='0000')||cleanBankText(result.description)!==result.description||cleanBankText(result.merchantText,160)!==result.merchantText||cleanBankText(result.bankCategory,160)!==result.bankCategory)throw Error('INVALID_BANK_DESCRIPTION');
 return result as BankDescription;
}

/** /5 uses event wording, not a substring such as перевод in Бюро переводов.
 * SBP can also be a payment channel; an explicit purchase heading is distinct
 * from a transfer heading. Neither case establishes a merchant identity. */
export function financialTransferText(text:string):boolean{
 const payment=/^(?:оплата|покупка|возврат покупки|возврат оплаты|purchase|card payment|purchase refund|refund)(?=$|[^\p{L}\p{N}])/iu.test(text);
 return /^(?:(?:входящий|исходящий|внутренний|денежный|банковский)\s+)?перевод(?=$|[^\p{L}\p{N}])|^(?:(?:incoming|outgoing|bank|money|internal)\s+)?transfer(?=$|[^\p{L}\p{N}])/iu.test(text)||
  /(?<![\p{L}\p{N}])(?:денежный перевод|перевод (?:денежных средств|средств|на карту|по номеру телефона))(?=$|[^\p{L}\p{N}])/iu.test(text)||
  !payment&&/(?<![\p{L}\p{N}])(?:СБП|SBP)(?![\p{L}\p{N}])/iu.test(text);
}

/** New imports only. Privacy joins hidden identifiers before masking, as before.
 * Record lost literal boundaries instead of treating a joined word as evidence.
 * No raw text/identifier or secret is added to the wire. */
export function merchantBankDescription(description:unknown,merchant:unknown='',bankCategory:unknown='',mcc:unknown=null):MerchantBankDescription{
 const details=bankDescription(description,merchant,bankCategory,mcc);
 let name=cleanBankText(merchant,160);
 if(!name){
  const match=/^(?:оплата товаров и услуг|оплата покупки|покупка(?: в)?|оплата услуг|оплата в|оплата по карте|оплата картой|purchase|card payment|возврат покупки|возврат средств за покупку|возврат оплаты|purchase refund|refund)\s*[:.-]?\s+(.+)$/iu.exec(details.description);
  name=match?.[1]?.slice(0,160).trim()??'';
 }
 if(financialTransferText(details.description)||name.includes(hidden)&&!/[\p{L}]{2,}/u.test(name.replaceAll(hidden,'')))name='';
 return {...details,merchantText:name,textEvidence:[description,merchant,bankCategory].some(v=>typeof v==='string'&&/\p{Cf}/u.test(v))?'unknown':'intact'};
}

export function parseMerchantBankDescription(value:unknown):MerchantBankDescription{
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error('INVALID_BANK_DESCRIPTION');
 const {textEvidence,...details}=value as Record<string,unknown>;
 if(textEvidence!=='intact'&&textEvidence!=='unknown')throw Error('INVALID_BANK_DESCRIPTION');
 return {...parseBankDescription(details),textEvidence};
}
