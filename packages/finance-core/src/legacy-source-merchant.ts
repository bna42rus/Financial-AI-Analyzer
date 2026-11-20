// Compatibility data for the frozen source profiles, not the new catalog.
export const merchantNames={ozon:'Ozon',wildberries:'Wildberries',pyaterochka:'Пятёрочка',magnit:'Магнит',perekrestok:'Перекрёсток',lenta:'Лента',vkusvill:'ВкусВилл',auchan:'Ашан',metro:'METRO',dixy:'Дикси',fixprice:'Fix Price',samokat:'Самокат',lamoda:'Lamoda',dns:'DNS',mvideo:'М.Видео',sportmaster:'Спортмастер',hoff:'Hoff',leroymerlin:'Лемана ПРО',yandexmarket:'Яндекс Маркет',yandextaxi:'Яндекс Go'} as const;
export type MerchantCode=keyof typeof merchantNames;
export const legacySourceAliases:Record<MerchantCode,RegExp>={ozon:/^(?:ozon|озон)(?=$|[ ._*\d/-])/u,wildberries:/^(?:wildberries|вайлдберриз)(?=$|[ ._*\d/-])/u,pyaterochka:/^(?:пятерочка|pyaterochka)(?=$|[ ._*\d/-])/u,magnit:/^(?:магнит|magnit)(?=$|[ ._*\d/-])/u,perekrestok:/^(?:перекресток|perekrestok)(?=$|[ ._*\d/-])/u,lenta:/^(?:лента|lenta)(?=$|[ ._*\d/-])/u,vkusvill:/^(?:вкусвилл|vkusvill)(?=$|[ ._*\d/-])/u,auchan:/^(?:ашан|auchan)(?=$|[ ._*\d/-])/u,metro:/^metro(?=$|[ ._*\d/-])/u,dixy:/^(?:дикси|dixy)(?=$|[ ._*\d/-])/u,fixprice:/^(?:fix[ _-]?price|фикс прайс)(?=$|[ ._*\d/-])/u,samokat:/^(?:самокат|samokat)(?=$|[ ._*\d/-])/u,lamoda:/^(?:lamoda|ламода)(?=$|[ ._*\d/-])/u,dns:/^dns(?=$|[ ._*\d/-])/u,mvideo:/^(?:м[.]?видео|m[.]?video)(?=$|[ ._*\d/-])/u,sportmaster:/^(?:спортмастер|sportmaster)(?=$|[ ._*\d/-])/u,hoff:/^(?:hoff|хофф)(?=$|[ ._*\d/-])/u,leroymerlin:/^(?:лемана про|lemanapro|леруа мерлен|leroy merlin)(?=$|[ ._*\d/-])/u,yandexmarket:/^(?:яндекс[ ._-]+маркет|yandex[ ._-]+market)(?=$|[ ._*\d/-])/u,yandextaxi:/^(?:яндекс[ ._-]+(?:такси|go)|yandex[ ._-]+(?:taxi|go))(?=$|[ ._*\d/-])/u};
/** Frozen /4 source projection for old private predicates only. This neither
 * identifies a new merchant nor changes the source or displayed name. */
export function legacyRuleSourceMerchant(description:string,amountMinor:string,fallback:string):string{
 if(description.length>4000||/[\p{Cc}\p{Cf}]/u.test(description.replace(/[\n\r\t]/g,''))||! /^-?\d{1,19}$/.test(amountMinor))return fallback;
 const s=description.normalize('NFKC').toLowerCase().replace(/ё/g,'е').replace(/\s+/g,' ').trim();
 if(/перевод|получател|отправител|transfer|recipient|возврат.*комисси/u.test(s))return fallback;
 const purchase=/^(?:оплата товаров и услуг|оплата покупки|покупка|оплата в|оплата по карте|оплата картой|purchase|card payment)\s*[:.-]?\s+(.+)$/u.exec(s),refund=/^(?:возврат покупки|возврат средств за покупку|возврат оплаты|purchase refund|refund)\s*[:.-]?\s+(.+)$/u.exec(s);
 let tail:string|undefined;
 if(purchase&&!/возврат|комиссия|refund|fee/u.test(s)&&BigInt(amountMinor)<0n)tail=purchase[1];
 else if(refund&&BigInt(amountMinor)>0n)tail=refund[1];
 if(!tail)return fallback;
 const code=(Object.keys(legacySourceAliases) as MerchantCode[]).find(code=>legacySourceAliases[code].test(tail!));
 return code?merchantNames[code]:fallback;
}
