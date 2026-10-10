import type {Kind} from '../../finance-core/src/model.ts';

/** Finite-output profile. No source substring, recipient, URL or identifier is emitted. */
export const legacySourceSanitizer='bank-source/1' as const;
export const sourceSanitizer='bank-source/2' as const;
export const sourceProfiles=[legacySourceSanitizer,sourceSanitizer] as const;
const legacyMerchants=['ozon','wildberries','pyaterochka','magnit','perekrestok','lenta'];
export const merchantNames={ozon:'Ozon',wildberries:'Wildberries',pyaterochka:'Пятёрочка',magnit:'Магнит',perekrestok:'Перекрёсток',lenta:'Лента',vkusvill:'ВкусВилл',auchan:'Ашан',metro:'METRO',dixy:'Дикси',fixprice:'Fix Price',samokat:'Самокат',lamoda:'Lamoda',dns:'DNS',mvideo:'М.Видео',sportmaster:'Спортмастер',hoff:'Hoff',leroymerlin:'Лемана ПРО',yandexmarket:'Яндекс Маркет',yandextaxi:'Яндекс Go'} as const;
export type MerchantCode=keyof typeof merchantNames;
export type SafeSource={event:'purchase'|'refund'|'fee';merchant:MerchantCode|null};
const labels={purchase:'Покупка',refund:'Возврат покупки',fee:'Комиссия банка'} as const;
const aliases:Record<MerchantCode,RegExp>={ozon:/^(?:ozon|озон)(?=$|[ ._*\d/-])/u,wildberries:/^(?:wildberries|вайлдберриз)(?=$|[ ._*\d/-])/u,pyaterochka:/^(?:пятерочка|pyaterochka)(?=$|[ ._*\d/-])/u,magnit:/^(?:магнит|magnit)(?=$|[ ._*\d/-])/u,perekrestok:/^(?:перекресток|perekrestok)(?=$|[ ._*\d/-])/u,lenta:/^(?:лента|lenta)(?=$|[ ._*\d/-])/u,vkusvill:/^(?:вкусвилл|vkusvill)(?=$|[ ._*\d/-])/u,auchan:/^(?:ашан|auchan)(?=$|[ ._*\d/-])/u,metro:/^metro(?=$|[ ._*\d/-])/u,dixy:/^(?:дикси|dixy)(?=$|[ ._*\d/-])/u,fixprice:/^(?:fix[ _-]?price|фикс прайс)(?=$|[ ._*\d/-])/u,samokat:/^(?:самокат|samokat)(?=$|[ ._*\d/-])/u,lamoda:/^(?:lamoda|ламода)(?=$|[ ._*\d/-])/u,dns:/^dns(?=$|[ ._*\d/-])/u,mvideo:/^(?:м[.]?видео|m[.]?video)(?=$|[ ._*\d/-])/u,sportmaster:/^(?:спортмастер|sportmaster)(?=$|[ ._*\d/-])/u,hoff:/^(?:hoff|хофф)(?=$|[ ._*\d/-])/u,leroymerlin:/^(?:лемана про|lemanapro|леруа мерлен|leroy merlin)(?=$|[ ._*\d/-])/u,yandexmarket:/^(?:яндекс[ ._-]+маркет|yandex[ ._-]+market)(?=$|[ ._*\d/-])/u,yandextaxi:/^(?:яндекс[ ._-]+(?:такси|go)|yandex[ ._-]+(?:taxi|go))(?=$|[ ._*\d/-])/u};
export function parseSafeSource(value:unknown,amountMinor?:string,profile:typeof sourceProfiles[number]=sourceSanitizer):SafeSource|null{
 if(value===null)return null;
 if(!value||typeof value!=='object'||Array.isArray(value))throw new TypeError('INVALID_SAFE_SOURCE');
 const r=value as Record<string,unknown>;
 if(Object.keys(r).length!==2||!Object.hasOwn(r,'event')||!Object.hasOwn(r,'merchant')||!['purchase','refund','fee'].includes(r.event as string)||r.merchant!==null&&(!Object.hasOwn(merchantNames,r.merchant as string)||typeof r.merchant!=='string'||profile===legacySourceSanitizer&&!legacyMerchants.includes(r.merchant)))throw new TypeError('INVALID_SAFE_SOURCE');
 const event=r.event as SafeSource['event'];
 if(amountMinor!==undefined&&(event==='refund'?BigInt(amountMinor)<=0n:BigInt(amountMinor)>=0n)||event==='fee'&&r.merchant!==null)throw new TypeError('INVALID_SAFE_SOURCE');
 return {event,merchant:r.merchant as MerchantCode|null};
}
/** Device-only input to a keyed digest. It must never become a persisted label. */
export function normalizeSourceDescription(text:unknown):string|null{
 if(typeof text!=='string'||text.length>4000||/[\p{Cc}\p{Cf}]/u.test(text.replace(/[\n\r\t]/g,'')))return null;
 return text.normalize('NFKC').toLowerCase().replace(/ё/g,'е').replace(/\s+/g,' ').trim()||null;
}
/** Deliberately narrow templates; unknown or conflicting text supplies no signal. */
export function extractSafeSource(text:unknown,amountMinor:unknown):SafeSource|null{
 const s=normalizeSourceDescription(text);if(!s||typeof amountMinor!=='string'||! /^-?\d{1,19}$/.test(amountMinor))return null;
 // Transfer/recipient and mixed-event evidence never becomes a merchant purchase.
 if(/перевод|получател|отправител|transfer|recipient|возврат.*комисси/u.test(s))return null;
 let event:SafeSource['event'],tail:string;
 const purchase=/^(?:оплата товаров и услуг|оплата покупки|покупка|оплата в|оплата по карте|оплата картой|purchase|card payment)\s*[:.-]?\s+(.+)$/u.exec(s),refund=/^(?:возврат покупки|возврат средств за покупку|возврат оплаты|purchase refund|refund)\s*[:.-]?\s+(.+)$/u.exec(s);
 if(purchase&&!/возврат|комиссия|refund|fee/u.test(s)){event='purchase';tail=purchase[1]!;}
 else if(refund){event='refund';tail=refund[1]!;}
 else if(/^комиссия банка(?:\s|$)/u.test(s)){event='fee';tail='';}
 else return null;
 const merchant=(Object.keys(aliases) as MerchantCode[]).find(code=>aliases[code].test(tail))??null;
 try{return parseSafeSource({event,merchant},amountMinor);}catch{return null;}
}
export function sourceFields(source:SafeSource|null|undefined):{sourceKind:Kind;merchantText:string;description:string}{
 return source?{sourceKind:source.event,merchantText:source.merchant===null?'':merchantNames[source.merchant],description:labels[source.event]}:{sourceKind:'other',merchantText:'',description:''};
}
