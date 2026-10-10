import {extractSafeSource} from './safe-source.ts';
import {dateFact} from '../../finance-core/src/model.ts';
import {parsePersistedMinor} from '../../finance-core/src/money.ts';
import type {BankDate} from '../../finance-core/src/model.ts';
import type {Bank} from './contract.ts';
import type {ExtractedRow,ExtractedFile} from './local.ts';

/** Raw layout is device-only. Do not serialize it into diagnostics or server requests. */
export type TextItem={text:string;x:number;y:number;width:number};
export type PdfLayout=TextItem[][];
export const bankPdfAdapter='bank-pdf/2' as const;
export const legacyPdfParserVersions={tbank:'tbank-movement-pdf/1',ozon:'ozon-movement-pdf/1',sber:'sber-card-pdf/1'} as const;
export const pdfParserVersions={tbank:'tbank-movement-pdf/2',ozon:'ozon-movement-pdf/2',sber:'sber-card-pdf/2'} as const;
export type PdfFailure='UNKNOWN_FORMAT'|'AMBIGUOUS_FORMAT'|'UNSUPPORTED_LAYOUT'|'LOCAL_LIMIT'|'LOCAL_READ_FAILED'|'PASSWORD_REQUIRED'|'WRONG_PASSWORD'|'OCR_REQUIRED'|'PREPARATION_CLOSED';
export class BankPdfError extends Error {readonly code:PdfFailure;constructor(code:PdfFailure){super(code);this.code=code;}}
export const MAX_PDF_BYTES=20*1024*1024,MAX_PDF_PAGES=100,MAX_PDF_ITEMS=100000,MAX_PDF_TEXT=2000000;
const norm=(s:string)=>s.normalize('NFKC').toLowerCase().replace(/ё/g,'е').replace(/\s+/g,' ').trim();
type Line={y:number;items:TextItem[];text:string};
function lines(items:TextItem[]):Line[]{
 const out:Line[]=[];
 for(const item of [...items].sort((a,b)=>b.y-a.y||a.x-b.x)){
  if(!item.text.trim())continue;
  let line=out.at(-1);if(!line||Math.abs(line.y-item.y)>1.5){line={y:item.y,items:[],text:''};out.push(line);}line.items.push(item);
 }
 for(const line of out){line.items.sort((a,b)=>a.x-b.x);line.text=line.items.map(i=>i.text.trim()).join(' ');}
 return out;
}
function anchor(line:Line,re:RegExp){return line.items.find(i=>re.test(norm(i.text)))?.x;}
function cell(line:Line,start:number,end=Infinity){return line.items.filter(i=>i.x>=start-2&&i.x<end-2).map(i=>i.text.trim()).filter(Boolean).join(' ');}
function calendar(value:string):string{
 const m=/^(\d{2})\.(\d{2})\.(\d{4})$/.exec(value.trim());if(!m)throw new TypeError('INVALID_DATE');
 const date=`${m[3]}-${m[2]}-${m[1]}`;dateFact({precision:'day',date});return date;
}
function sourceDate(value:string,moscow:boolean):BankDate{
 const m=/^(\d{2}\.\d{2}\.\d{4})(?:\s+(\d{2}:\d{2}(?::\d{2})?))?$/.exec(value.trim());if(!m)throw new TypeError('INVALID_DATE');
 const date=calendar(m[1]!);if(!m[2])return {precision:'day',date};
 const time=m[2].length===5?m[2]+':00':m[2];if(!/^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(time))throw new TypeError('INVALID_DATE');
 if(!moscow)return {precision:'day',date};
 return dateFact({precision:'instant',instant:new Date(`${date}T${time}+03:00`).toISOString()});
}
/** Exact decimal conversion. An absent amount never becomes zero. */
export function pdfMoney(input:string,unsignedDebit=false){
 const s=input.normalize('NFKC').replace(/−/g,'-').trim().replace(/\s*(?:₽|руб\.?|р\.?|RUB)\s*$/iu,'').trim().replace(/^([+-])\s+(?=\d)/,'$1');
 const m=/^([+-]?)(\d{1,3}(?: \d{3})+|\d+)[.,](\d{2})$/.exec(s);if(!m)throw new TypeError('INVALID_AMOUNT');
 const digits=m[2]!.replace(/ /g,'');if(digits.length>17)throw new TypeError('INVALID_AMOUNT');
 const n=BigInt(digits)*100n+BigInt(m[3]!);const minus=m[1]==='-'||!m[1]&&unsignedDebit;
 const amountMinor=(minus?-n:n).toString();parsePersistedMinor(amountMinor);
 return {amountMinor,direction:n===0n?'unknown' as const:minus?'debit' as const:'credit' as const};
}
type Columns={date:number;posted?:number;postedEnd?:number;time?:number;amount:number;end:number;description:number;descriptionEnd?:number;doc?:number;moscow:boolean};
function header(bank:Bank,page:Line[],index:number):Columns|null{
 const line=page[index]!,next=page[index+1];
 if(bank==='tbank'&&/дата и время/.test(norm(line.text))&&/сумма операции/.test(norm(line.text))){
  const date=anchor(line,/^дата и время$/),posted=anchor(line,/^дата$/),amount=anchor(line,/^сумма операции$/),description=anchor(line,/^описание$/);
  if(date===undefined||posted===undefined||amount===undefined||description===undefined)return null;
  const postedEnd=anchor(line,/^сумма в валюте$/);if(postedEnd===undefined)return null;
  const descriptionEnd=anchor(line,/^номер$/);if(descriptionEnd===undefined)return null;
  return {date,posted,postedEnd,amount,end:description,description,descriptionEnd,moscow:false};
 }
 if(bank==='sber'&&/дата операции/.test(norm(line.text))&&/сумма в (?:рублях|валюте счета)/.test(norm(line.text))&&next){
  const below=page.slice(index+1,index+4),date=anchor(line,/^дата операции/),description=below.map(l=>anchor(l,/^описание операции$/)).find(x=>x!==undefined),amount=anchor(line,/^сумма в /),end=anchor(line,/^остаток средств/);
  if(date===undefined||description===undefined||amount===undefined||end===undefined)return null;
  // Amounts are right-aligned inside their column; descriptions begin at a fixed left edge.
  const time=(date+description)/2;return {date,time,amount:amount-22,end:end-3,description,moscow:/\(мск\)/.test(norm(line.text))};
 }
 if(bank==='ozon'&&/дата операции/.test(norm(line.text))&&/назначение платежа/.test(norm(line.text))){
  const date=anchor(line,/^дата операции$/),doc=anchor(line,/^документ$/),description=anchor(line,/^назначение платежа$/);
  const upper=page[index-1],amount=upper&&anchor(upper,/^сумма операции$/),currency=next&&anchor(next,/^валюта$/);
  if(date===undefined||doc===undefined||description===undefined||amount===undefined||currency===undefined)return null;
  return {date,doc,amount:(amount+description)/2,end:currency-3,description,moscow:false};
 }
 return null;
}
function rowStart(line:Line,c:Columns){
 const first=cell(line,c.date,c.posted??c.time??c.doc??c.description),amount=cell(line,c.amount,c.end);
 if(/^\d{2}\.\d{2}\./.test(first)&&(c.time===undefined||/^\d{2}:/.test(cell(line,c.time,c.description))||Boolean(amount)))return true;
 // A financial row with a missing/corrupted date is still an issue, never silently omitted.
 const description=cell(line,c.description,c.description<c.amount?c.amount:Infinity);
 if(!description)return false;try{pdfMoney(amount);return true;}catch{return false;}
}
function account(bank:Bank,first:Line[]){
 const label=bank==='tbank'?/номер лицевого счета\s*:?/:bank==='sber'?/номер счета\s*:?/:/номер договора\s*:/;
 const found=first.filter(l=>label.test(norm(l.text))).map(l=>{
  if(bank==='ozon')return /номер договора\s*:\s*№\s*([A-Za-z0-9][A-Za-z0-9-]{0,127})(?:\s+от\s|$)/iu.exec(l.text)?.[1]??null;
  const s=norm(l.text),m=label.exec(s)!,tail=s.slice(m.index+m[0].length),value=/^\s*([\d -]+)/.exec(tail)?.[1]?.replace(/[ -]/g,'');
  return value&&/^\d{20}$/.test(value)?value:null;
 });
 if(found.length!==1||!found[0])throw new BankPdfError('UNSUPPORTED_LAYOUT');
 return {kind:bank==='ozon'?'bank_contract' as const:'bank_account' as const,value:found[0]};
}
/** Parse only observed versioned layouts. Only finite safe signals may survive; raw descriptions/document/auth codes are discarded.
 * Document/auth codes are not certified stable transaction IDs and cannot drive automatic dedupe. */
export function parseBankPdf(fileId:string,bytes:Uint8Array,layout:PdfLayout):ExtractedFile{
 if(bytes.length>MAX_PDF_BYTES||layout.length>MAX_PDF_PAGES)throw new BankPdfError('LOCAL_LIMIT');
 let n=0,chars=0;for(const page of layout)for(const i of page){n++;chars+=i.text.length;if(![i.x,i.y,i.width].every(Number.isFinite))throw new BankPdfError('UNSUPPORTED_LAYOUT');}
 if(n>MAX_PDF_ITEMS||chars>MAX_PDF_TEXT)throw new BankPdfError('LOCAL_LIMIT');if(!chars)throw new BankPdfError('OCR_REQUIRED');
 const pages=layout.map(lines),first=pages[0]??[],all=norm(pages.flat().map(l=>l.text).join('\n'));
 // The issuer must appear before the first table, or in the publisher URL, rather than in a transfer description.
 const intro=norm(first.slice(0,first.findIndex(l=>/дата операции|дата и время.*сумма/.test(norm(l.text)))<0?first.length:first.findIndex(l=>/дата операции|дата и время.*сумма/.test(norm(l.text)))).map(l=>l.text).join(' '));
 const matches:Bank[]=[];
 if(/справка о движении средств/.test(intro)&&(/т.?банк|тинькофф/.test(intro)||/tbank\.ru/.test(all)))matches.push('tbank');
 if(/справка о движении/.test(intro)&&/озон банк/.test(intro))matches.push('ozon');
 if(/выписка/.test(intro)&&/сбербанк/.test(intro))matches.push('sber');
 if(matches.length!==1)throw new BankPdfError(matches.length?'AMBIGUOUS_FORMAT':'UNKNOWN_FORMAT');
 const bank=matches[0]!,alias=account(bank,first),rows:ExtractedRow[]=[];
 const declaredRub=/валюта\s*:?\s*российский рубль/.test(intro);
 const ozonMoscow=/дата и время операции.{0,50}московскому/.test(all);
 let seenHeader=false,continuation:Columns|null=null;
 for(const page of pages){
  // This Ozon template continues the same table on page two without repeating its header.
  let c:Columns|null=bank==='ozon'?continuation:null,active:Line[]=[],pageHeader=Boolean(c);
  function flush(){
   if(!c||!active.length)return;
   const start=active[0]!,row:ExtractedRow={operationDate:undefined,postedDate:null,amountMinor:undefined,currency:'RUB',direction:'unknown',account:alias};
   const leftEnd=c.posted??c.time??c.doc??c.description;
   const startDate=cell(start,c.date,leftEnd),continuationDates=active.slice(1).map(l=>cell(l,c!.date,leftEnd)).filter(Boolean);
   try{const timePart=continuationDates.find(s=>/^\d{2}:/.test(s));
    row.operationDate=sourceDate(bank==='ozon'||bank==='tbank'?[startDate,timePart].filter(Boolean).join(' '):startDate,bank==='ozon'?ozonMoscow:c.moscow);
    if(bank==='sber'){
     const time=cell(start,c.time!,c.description);if(time)row.operationDate=sourceDate(startDate+' '+time,c.moscow);
     const posted=continuationDates.filter(v=>/^\d{2}\.\d{2}\.\d{4}$/.test(v));if(posted.length>1)throw new Error();if(posted[0])row.postedDate=sourceDate(posted[0],false);
    }else if(c.posted!==undefined)row.postedDate=sourceDate(cell(start,c.posted,c.postedEnd),false);
   }catch{row.operationDate=undefined;}
   try{const amount=cell(start,c.amount,c.end);Object.assign(row,pdfMoney(amount,bank==='sber'));
    if(bank==='tbank'?!/(?:₽|руб\.?|р\.?|RUB)\s*$/iu.test(amount):bank==='ozon'?!declaredRub:!declaredRub&&!page.some(l=>/сумма в рублях/.test(norm(l.text))))row.currency='UNSUPPORTED';
   }catch{/* Preparation records INVALID_AMOUNT without raw fragments. */}
   row.localDescription=active.map(l=>cell(l,c!.description,c!.descriptionEnd??c!.amount)).join(' ');
   row.safeSource=extractSafeSource(row.localDescription,row.amountMinor);
   rows.push(row);if(rows.length>1000)throw new BankPdfError('LOCAL_LIMIT');active=[];
  }
  for(let i=0;i<page.length;i++){
   const line=page[i]!,h=header(bank,page,i);
   if(h){flush();c=h;seenHeader=true;pageHeader=true;continue;}
   if(!c)continue;
   if(/^итого|^продолжение|^дата и время операции|^операции по/.test(norm(line.text))){flush();c=null;continue;}
   if(rowStart(line,c)){flush();active=[line];continue;}
   if(active.length)active.push(line);
  }
  flush();
  if(!pageHeader&&page.some(l=>/^\d{2}\.\d{2}\./.test(l.items[0]?.text.trim()??'')&&l.items.some(i=>i.x>250&&/^[+−-]?\s*\d[\d\s]*[.,]\d{2}(?:\s*₽)?$/.test(i.text.trim()))))throw new BankPdfError('UNSUPPORTED_LAYOUT');
  continuation=c;
 }
 if(!seenHeader)throw new BankPdfError('UNSUPPORTED_LAYOUT');
 return {fileId,bank,bytes,rows};
}
