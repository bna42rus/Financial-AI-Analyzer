/** Shared browser/server guard; it is not a substitute for local statement/HMAC processing. */
const identifiers=/(?:\b(?:\d[\s-]?){13,20}\b)|(?:\b(?:\+?7|8)[\s()-]*(?:\d[\s()-]*){10}\b)|(?:(?:сч[её]т|карт[аы]|договор|телефон|account|card|contract|phone)\s*(?:№|номер|number|:)?\s*[\d+][\d\s()-]{5,})/giu;
const emails=/[\p{L}\p{N}.!#$%&'*+/=?^_`{|}~-]+@[\p{L}\p{N}](?:[\p{L}\p{N}.-]*[\p{L}\p{N}])?\.[\p{L}\p{N}-]{2,}/giu;
const passports=/(?<![\p{L}\p{N}])(?:паспорт|passport)\s*(?:(?:серия|series)\s*)?(?:no\.?|номер|number|:)?\s*\d{2}[ -]?\d{2}\s*(?:(?:no\.?|номер|number|:)?\s*)\d{6}(?!\d)/giu;
const labelledIdentifiers=/(?<![\p{L}\p{N}])(?:сч[её]т|карт[аы]|договор|телефон|account|card|contract|phone|код авторизации|authorization code|номер документа|document id)\s*(?:no\.?|номер|number|:)?\s*(?:[+\d][\d\s()-]{5,}|(?=[\p{L}\p{N}._/-]{6,128}(?![\p{L}\p{N}]))(?=[\p{L}\p{N}._/-]*\d)[\p{L}\p{N}][\p{L}\p{N}._/-]{5,127})/giu;
export function sanitizeText(value:string):string {
 // Join identifiers before matching. Invisible format characters must not
 // split a card/passport/email into fragments that bypass the network guard.
 return value.normalize('NFKC').replace(/\p{Cf}/gu,'').replace(passports,'[реквизиты скрыты]').replace(emails,'[реквизиты скрыты]').replace(labelledIdentifiers,'[реквизиты скрыты]').replace(identifiers,'[реквизиты скрыты]').replace(/[\u0000-\u001f\u007f]/g,' ').trim();
}
export function safeText(value:unknown,max=500):string {
 if(typeof value!=='string'||value.length>max||sanitizeText(value)!==value.trim()||/[\u0000-\u001f\u007f]/.test(value))throw new TypeError('UNSANITIZED_TEXT');return value.trim();
}
