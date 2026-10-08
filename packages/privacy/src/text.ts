/** Shared browser/server guard; it is not a substitute for local statement/HMAC processing. */
const identifiers=/(?:\b(?:\d[\s-]?){13,20}\b)|(?:\b(?:\+?7|8)[\s()-]*(?:\d[\s()-]*){10}\b)|(?:(?:сч[её]т|карт[аы]|договор|телефон|account|card|contract|phone)\s*(?:№|номер|number|:)?\s*[\d+][\d\s()-]{5,})/giu;
export function sanitizeText(value:string):string {return value.normalize('NFKC').replace(identifiers,'[реквизиты скрыты]').replace(/[\u0000-\u001f\u007f]/g,' ').trim();}
export function safeText(value:unknown,max=500):string {
 if(typeof value!=='string'||value.length>max||sanitizeText(value)!==value.trim()||/[\u0000-\u001f\u007f]/.test(value))throw new TypeError('UNSANITIZED_TEXT');return value.trim();
}
