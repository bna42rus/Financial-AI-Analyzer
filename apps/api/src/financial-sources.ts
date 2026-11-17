import {parseFinancialSourceRequest} from '../../../packages/analyzer/src/financial-sources.ts';
import type {FinancialSourcesResult,FinancialSourceRequest,VerifiedSource} from '../../../packages/analyzer/src/financial-sources.ts';
import {dateFact} from '../../../packages/finance-core/src/model.ts';
export class FinancialSourceError extends Error{readonly code:string;constructor(code:string){super(code);this.code=code;}}
function error(code='FINANCIAL_SOURCE_UNAVAILABLE'):never{throw new FinancialSourceError(code);}
const day=(s:string)=>{dateFact({precision:'day',date:s});return s;};
const iso=(s:string)=>{const m=/^(\d{2})\.(\d{2})\.(\d{4})$/.exec(s);return m?day(`${m[3]}-${m[2]}-${m[1]}`):day(s.slice(0,10));};
const decoded=(s:string)=>s.replaceAll('&lt;','<').replaceAll('&gt;','>').replaceAll('&quot;','"').replaceAll('&amp;','&');
const clean=(s:string)=>decoded(s.replace(/<script\b[^>]*>[\s\S]*?<\/script>|<style\b[^>]*>[\s\S]*?<\/style>/giu,' ').replace(/<[^>]*>/gu,' ')).replace(/\s+/gu,' ').trim();
const publicCache=new Map<string,{expires:number;promise:Promise<VerifiedSource>}>();
const guidance={tax_deposits:{title:'ФНС: налогообложение доходов физических лиц',url:'https://www.nalog.gov.ru/rn77/taxation/taxes/ndfl/'},tax_deductions:{title:'ФНС: налоговые вычеты',url:'https://www.nalog.gov.ru/rn77/taxation/taxes/ndfl/nalog_vichet/'},deposit_insurance:{title:'АСВ: страхование вкладов',url:'https://www.asv.org.ru/insurance/'},credit_insurance:{title:'Банк России: страхование',url:'https://www.cbr.ru/insurance/'},investment_risks:{title:'Банк России: защита инвесторов',url:'https://www.cbr.ru/protection_rights/'}} as const;
async function bounded(fetcher:typeof fetch,url:string,init:RequestInit={}){
 const u=new URL(url);if(u.protocol!=='https:'||!['www.cbr.ru','www.nalog.gov.ru','www.asv.org.ru'].includes(u.hostname)||u.username||u.password)error('FINANCIAL_SOURCE_DENIED');
 const response=await fetcher(url,{...init,redirect:'error',signal:AbortSignal.timeout(8000),headers:{Accept:'application/xml,text/xml,text/html',...init.headers}});if(!response.ok||response.url&&response.url!==url)error();
 const reader=response.body?.getReader();if(!reader)error();const chunks:Uint8Array[]=[];let size=0;
 try{while(true){const v=await reader.read();if(v.done)break;size+=v.value.length;if(size>512000)error('FINANCIAL_SOURCE_TOO_LARGE');chunks.push(v.value);}}finally{await reader.cancel();}
 const bytes=new Uint8Array(size);let at=0;for(const b of chunks){bytes.set(b,at);at+=b.length;}const prefix=new TextDecoder().decode(bytes.slice(0,200)),text=new TextDecoder(/windows-1251/iu.test(prefix)?'windows-1251':'utf-8').decode(bytes);
 if(/<!DOCTYPE|<!ENTITY/iu.test(text))error('FINANCIAL_SOURCE_FORMAT_CHANGED');return text;
}
function money(n:bigint){const a=n<0n?-n:n;return (n<0n?'−':'')+(a/100n).toLocaleString('ru-RU')+','+(a%100n).toString().padStart(2,'0')+' ₽';}
export async function readFinancialSources(raw:unknown,currentDate:string,fetcher:typeof fetch=fetch,now=()=>new Date()):Promise<FinancialSourcesResult>{
 const request=parseFinancialSourceRequest(raw),date='date'in request&&request.date?request.date:day(currentDate);if(date>currentDate)error('FINANCIAL_SOURCE_FUTURE_DATE');
 // Only public topic/currency/date are keys. User questions, amounts and IDs never leave the process.
 const cacheKey=JSON.stringify(request.kind==='currency'?{kind:request.kind,currency:request.currency,date}:request.kind==='key_rate'?{kind:request.kind,date}:{kind:request.kind,topic:request.topic});
 let entry=publicCache.get(cacheKey);if(!entry||entry.expires<=now().getTime()){
  const promise:Promise<VerifiedSource>=(async()=>{
   const retrievedAt=now().toISOString();
   if(request.kind==='official_guidance'){
    const source=guidance[request.topic],html=await bounded(fetcher,source.url),title=clean(/<title[^>]*>([\s\S]*?)<\/title>/iu.exec(html)?.[1]??'');if(!title)error('FINANCIAL_SOURCE_FORMAT_CHANGED');
    return {id:'s1',title:source.title,url:source.url,retrievedAt,facts:[{label:'Проверенная официальная страница',value:title.slice(0,240),unit:'text' as const}],notice:'Проверена доступность первичного источника. Сама ссылка не подтверждает применимость конкретной нормы. Для точного налога/страхового покрытия нужны период, статус и условия; числовые правила без проверки документа не подставляются.'};
   }
   if(request.kind==='currency'){
    const url='https://www.cbr.ru/scripts/XML_daily.asp?date_req='+date.split('-').reverse().join('/'),xml=await bounded(fetcher,url),published=iso(/<ValCurs\b[^>]*Date="([^"]+)"/u.exec(xml)?.[1]??'');if(published>date)error('FINANCIAL_SOURCE_DATE_CHANGED');
    const block=[...xml.matchAll(/<Valute\b[^>]*>([\s\S]*?)<\/Valute>/gu)].map(m=>m[1]!).find(b=>new RegExp('<CharCode>'+request.currency+'</CharCode>','u').test(b));if(!block)error('FINANCIAL_SOURCE_CURRENCY_UNKNOWN');
    const nominal=/<Nominal>(\d+)<\/Nominal>/u.exec(block)?.[1],value=/<Value>(\d+(?:[.,]\d{1,6})?)<\/Value>/u.exec(block)?.[1];if(!nominal||!value||BigInt(nominal)<=0n)error('FINANCIAL_SOURCE_FORMAT_CHANGED');
    return {id:'s1',title:'Официальный курс Банка России',url,retrievedAt,publishedDate:published,facts:[{label:nominal+' '+request.currency,value:value.replace('.',',')+' ₽',unit:'text' as const},{label:'Номинал',value:nominal,unit:'text' as const},{label:'Курс в рублях за номинал',value,unit:'text' as const}],notice:'Официальный курс не является курсом покупки/продажи банка. Комиссии и спред обмена не включены.'};
   }
   const start=new Date(date+'T00:00:00Z');start.setUTCDate(start.getUTCDate()-90);
   const url='https://www.cbr.ru/DailyInfoWebServ/DailyInfo.asmx',body='<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><KeyRateXML xmlns="http://web.cbr.ru/"><fromDate>'+start.toISOString()+'</fromDate><ToDate>'+date+'T23:59:59</ToDate></KeyRateXML></soap:Body></soap:Envelope>';
   const xml=decoded(await bounded(fetcher,url,{method:'POST',body,headers:{'Content-Type':'text/xml; charset=utf-8',SOAPAction:'"http://web.cbr.ru/KeyRateXML"'}}));
   // Published XSD calls rows Item; the live SOAP service emits KR. Both are fixed CBR formats.
   const rows=[...xml.matchAll(/<(?:KR|Item)>([\s\S]*?)<\/(?:KR|Item)>/gu)].map(m=>({date:/<DT>([^<]+)<\/DT>/u.exec(m[1]!)?.[1]?.slice(0,10),rate:/<Rate>(\d+(?:[.,]\d{1,4})?)<\/Rate>/u.exec(m[1]!)?.[1]})).filter((r):r is {date:string;rate:string}=>!!r.date&&!!r.rate&&r.date<=date).sort((a,b)=>b.date.localeCompare(a.date));const row=rows[0];if(!row)error('FINANCIAL_SOURCE_FORMAT_CHANGED');day(row.date);
   return {id:'s1',title:'Ключевая ставка Банка России',url:'https://www.cbr.ru/hd_base/KeyRate/',retrievedAt,publishedDate:row.date,facts:[{label:'Ключевая ставка',value:row.rate.replace('.',',')+'% годовых',unit:'percent' as const}],notice:'Показана последняя опубликованная запись не позднее запрошенной даты. Это не ставка вашего кредитного договора.'};
  })();entry={expires:now().getTime()+15*60000,promise};publicCache.set(cacheKey,entry);if(publicCache.size>64)publicCache.delete(publicCache.keys().next().value!);promise.catch(()=>{if(publicCache.get(cacheKey)?.promise===promise)publicCache.delete(cacheKey);});
 }
 let source:VerifiedSource;try{source=structuredClone(await entry.promise);}catch(failure){if(failure instanceof FinancialSourceError)throw failure;throw new FinancialSourceError('FINANCIAL_SOURCE_UNAVAILABLE');}
 if(request.kind==='currency'&&request.amount!==undefined){const value=source.facts[2]!.value.replace(',','.'),[whole,fraction='']=value.split('.'),scale=10n**BigInt(fraction.length),rate=BigInt(whole!+fraction),nominal=BigInt(source.facts[1]!.value),[a,b='']=request.amount.replace(',','.').split('.'),amount=BigInt(a!)*100n+BigInt(b.padEnd(2,'0')),den=scale*nominal,minor=(amount*rate+den/2n)/den;source.facts.push({label:request.amount+' '+request.currency+' по официальному курсу',value:money(minor),unit:'money',minor:minor.toString()});}
 return {version:'cashneuro-financial-sources/1',request,sources:[source]};
}
export function resetFinancialSourceCacheForTests(){publicCache.clear();}
