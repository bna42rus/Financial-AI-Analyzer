import {sanitizeText,safeText} from '../../privacy/src/text.ts';

export type BankDescription={description:string;merchantText:string;bankCategory:string;mcc:string|null};
const hidden='[скрыто]';
/** Device-side before transmission; repeated independently by the server. Raw
 * files and identity HMAC inputs remain device-only. No recipient is a merchant. */
export function cleanBankText(value:unknown,max=1000):string{
 if(typeof value!=='string'||value.length>4000)return '';
 let text=sanitizeText(value.replace(/[\r\n\t]/g,' '))
  .replace(/https?:\/\/\S+|www\.\S+/giu,hidden)
  .replace(/(?:\b(?:rrn|arn|auth|authorization|ref|reference|terminal|tid|mid|inn|snils|iban|bic|swift)\b|ИНН|СНИЛС|БИК|РРН|терминал|идентификатор|документ|авторизация|номер операции|код операции)\s*(?:№|:|=|#)?\s*[\p{L}\p{N}._\/-]+/giu,hidden)
  .replace(/(?:получатель|отправитель|плательщик|владелец|держатель|recipient|sender|cardholder)\s*[:=-]?\s*[^,;]+/giu,hidden)
  .replace(/(?<![\p{L}])[А-ЯЁ][а-яё]+\s+[А-ЯЁ][а-яё]+\s+[А-ЯЁ][а-яё]*(?:вич|вна|ична)(?![\p{L}])/gu,hidden)
  .replace(/(?:(?<![\p{L}])ИП\s+)[А-ЯЁ][а-яё]+(?:\s+[А-ЯЁ][а-яё]+){1,2}/gu,hidden)
  .replace(/(?<![\p{L}\p{N}])[А-ЯЁ][а-яё]+\s+[А-ЯЁ]\.\s*(?:[А-ЯЁ]\.)?/gu,hidden)
  .replace(/[\p{L}\p{N}_/-]{6,}/gu,token=>/\d/u.test(token)?hidden:token)
  .replace(/\d+/g,hidden)
  .replace(/\[реквизиты скрыты\]/g,hidden).replace(/(?:\[скрыто\]\s*){2,}/g,hidden+' ')
  .replace(/\s+/g,' ').trim();
 // Transfers can contain unlabelled names. Keep the event, never its recipient.
 if(/перевод|transfer|\bSBP\b|СБП/iu.test(text))text=/возврат/iu.test(text)?'Возврат перевода':/входящ|получен/iu.test(text)?'Входящий перевод':/исходящ|отправлен/iu.test(text)?'Исходящий перевод':'Перевод';
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
