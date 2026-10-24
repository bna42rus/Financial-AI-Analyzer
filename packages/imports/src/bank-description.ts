import {sanitizeText,safeText} from '../../privacy/src/text.ts';

export type BankDescription={description:string;merchantText:string;bankCategory:string;mcc:string|null};
const hidden='[скрыто]';
/** Device-side before transmission; repeated independently by the server. Raw
 * files and identity HMAC inputs remain device-only. Names and ordinary numbers
 * stay readable; retaining a transfer description does not make it a merchant. */
export function cleanBankText(value:unknown,max=1000):string{
 if(typeof value!=='string'||value.length>4000)return '';
 const source=value.normalize('NFKC').replace(/\p{Cf}/gu,'').replace(/[\r\n\t]/g,' ').replace(/(?:https?|ftp):\/\/\S+|www\.\S+/giu,hidden);
 const text=sanitizeText(source)
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
