import type {Kind} from '../../finance-core/src/model.ts';

/** Finite-output profile. No source substring, recipient, URL or identifier is emitted. */
export const sourceSanitizer='bank-source/1' as const;
export const merchantNames={ozon:'Ozon',wildberries:'Wildberries',pyaterochka:'Пятёрочка',magnit:'Магнит',perekrestok:'Перекрёсток',lenta:'Лента'} as const;
export type MerchantCode=keyof typeof merchantNames;
export type SafeSource={event:'purchase'|'refund'|'fee';merchant:MerchantCode|null};
const labels={purchase:'Покупка',refund:'Возврат покупки',fee:'Комиссия банка'} as const;
const aliases:Record<MerchantCode,RegExp>={ozon:/^(?:ozon|озон)(?=$|[ ._*\d-])/u,wildberries:/^(?:wildberries|вайлдберриз)(?=$|[ ._*\d-])/u,pyaterochka:/^(?:пятерочка|pyaterochka)(?=$|[ ._*\d-])/u,magnit:/^(?:магнит|magnit)(?=$|[ ._*\d-])/u,perekrestok:/^(?:перекресток|perekrestok)(?=$|[ ._*\d-])/u,lenta:/^(?:лента|lenta)(?=$|[ ._*\d-])/u};
export function parseSafeSource(value:unknown,amountMinor?:string):SafeSource|null{
 if(value===null)return null;
 if(!value||typeof value!=='object'||Array.isArray(value))throw new TypeError('INVALID_SAFE_SOURCE');
 const r=value as Record<string,unknown>;
 if(Object.keys(r).length!==2||!Object.hasOwn(r,'event')||!Object.hasOwn(r,'merchant')||!['purchase','refund','fee'].includes(r.event as string)||r.merchant!==null&&(!Object.hasOwn(merchantNames,r.merchant as string)||typeof r.merchant!=='string'))throw new TypeError('INVALID_SAFE_SOURCE');
 const event=r.event as SafeSource['event'];
 if(amountMinor!==undefined&&(event==='refund'?BigInt(amountMinor)<=0n:BigInt(amountMinor)>=0n)||event==='fee'&&r.merchant!==null)throw new TypeError('INVALID_SAFE_SOURCE');
 return {event,merchant:r.merchant as MerchantCode|null};
}
/** Deliberately narrow templates; unknown or conflicting text supplies no signal. */
export function extractSafeSource(text:unknown,amountMinor:unknown):SafeSource|null{
 if(typeof text!=='string'||text.length>4000||typeof amountMinor!=='string'||! /^-?\d{1,19}$/.test(amountMinor)||/[\p{Cc}\p{Cf}]/u.test(text.replace(/[\n\r\t]/g,'')))return null;
 const s=text.normalize('NFKC').toLowerCase().replace(/ё/g,'е').replace(/\s+/g,' ').trim();
 // Transfer/recipient and mixed-event evidence never becomes a merchant purchase.
 if(/перевод|получател|отправител|возврат.*комисси/u.test(s))return null;
 let event:SafeSource['event'],tail:string;
 const purchase=/^(?:оплата товаров и услуг|оплата покупки|покупка|оплата в)\s*[:.-]?\s+(.+)$/u.exec(s),refund=/^(?:возврат покупки|возврат средств за покупку)\s*[:.-]?\s+(.+)$/u.exec(s);
 if(purchase&&!/возврат|комиссия/u.test(s)){event='purchase';tail=purchase[1]!;}
 else if(refund){event='refund';tail=refund[1]!;}
 else if(/^комиссия банка(?:\s|$)/u.test(s)){event='fee';tail='';}
 else return null;
 const merchant=(Object.keys(aliases) as MerchantCode[]).find(code=>aliases[code].test(tail))??null;
 try{return parseSafeSource({event,merchant},amountMinor);}catch{return null;}
}
export function sourceFields(source:SafeSource|null|undefined):{sourceKind:Kind;merchantText:string;description:string}{
 return source?{sourceKind:source.event,merchantText:source.merchant===null?'':merchantNames[source.merchant],description:labels[source.event]}:{sourceKind:'other',merchantText:'',description:''};
}
