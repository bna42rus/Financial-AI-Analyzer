import {BankPdfError,pdfMoney} from './bank-pdf.ts';
import {dateFact} from '../../finance-core/src/model.ts';
import {extractSafeSource,localSourceSanitizer} from './safe-source.ts';
import type {ExtractedFile,ExtractedRow} from './local.ts';
import type {Bank} from './contract.ts';

export const localBankAdapter='bank-local/1' as const;
export const localParserVersions=['tbank-movement-pdf/2','ozon-movement-pdf/2','sber-card-pdf/2','tbank-table/1','ozon-table/1','sber-table/1','tbank-ocr/1','ozon-ocr/1','sber-ocr/1'] as const;
const norm=(s:string)=>s.normalize('NFKC').toLowerCase().replace(/ё/g,'е').replace(/\s+/g,' ').trim();
const bankName=(s:string):Bank|null=>({'т-банк':'tbank','тбанк':'tbank','тинькофф':'tbank','tbank':'tbank','ozon банк':'ozon','озон банк':'ozon','сбербанк':'sber','сбер':'sber'} as Record<string,Bank>)[norm(s)]??null;
export const MAX_TABLE_TEXT=2_000_000,MAX_TABLE_CELLS=40_000;
/** Exact RFC-style quoting; no delimiter guessing from transaction descriptions. */
export function csvTable(text:string):string[][]{
 if(text.length>MAX_TABLE_TEXT)throw new BankPdfError('LOCAL_LIMIT');
 text=text.replace(/^\uFEFF/,'');
 const parse=(delimiter:string)=>{
  const rows:string[][]=[],row:string[]=[];let cell='',quoted=false,closed=false,cells=0;
  function push(){if(++cells>MAX_TABLE_CELLS||cell.length>4000)throw new BankPdfError('LOCAL_LIMIT');row.push(cell);cell='';closed=false;}
  for(let i=0;i<text.length;i++){
   const c=text[i]!;
   if(quoted){if(c==='"'){if(text[i+1]==='"'){cell+='"';i++;}else{quoted=false;closed=true;}}else cell+=c;continue;}
   if(c==='"'){if(cell||closed)throw new BankPdfError('UNSUPPORTED_LAYOUT');quoted=true;}
   else if(c===delimiter)push();
   else if(c==='\r'||c==='\n'){if(c==='\r'&&text[i+1]==='\n')i++;push();rows.push(row.splice(0));}
   else{if(closed)throw new BankPdfError('UNSUPPORTED_LAYOUT');cell+=c;}
  }
  if(quoted)throw new BankPdfError('UNSUPPORTED_LAYOUT');if(cell||row.length||closed){push();rows.push(row);}return rows;
 };
 const candidates:string[][][]=[];
 for(const delimiter of [';',',','\t'])try{const table=parse(delimiter);if(table.some(r=>r.map(norm).includes('дата операции')&&r.length>=5))candidates.push(table);}catch(error){if(error instanceof BankPdfError&&error.code==='LOCAL_LIMIT')throw error;}
 if(candidates.length!==1)throw new BankPdfError(candidates.length?'AMBIGUOUS_FORMAT':'UNSUPPORTED_LAYOUT');return candidates[0]!;
}
/** Only explicit textual calendar facts and timezone-marked instants. */
export function tableDate(value:string){
 const s=value.trim(),m=/^(\d{2})\.(\d{2})\.(\d{4})$/.exec(s);
 if(m)return dateFact({precision:'day',date:`${m[3]}-${m[2]}-${m[1]}`});
 if(/^\d{4}-\d{2}-\d{2}$/.test(s))return dateFact({precision:'day',date:s});
 if(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|[+-]\d{2}:\d{2})$/.test(s)){
  // Validate the calendar independently: Date.parse can normalize 30 February.
  dateFact({precision:'day',date:s.slice(0,10)});
  if(!/T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d/.test(s))throw new Error('INVALID_DATE');
  return dateFact({precision:'instant',instant:new Date(s).toISOString()});
 }
 throw new Error('INVALID_DATE');
}
/** Self-identifying tables, not an arbitrary mapping wizard or an inferred account. */
export function parseBankTable(fileId:string,bytes:Uint8Array,table:string[][]):ExtractedFile{
 if(table.length>1100||table.reduce((n,r)=>n+r.length,0)>MAX_TABLE_CELLS)throw new BankPdfError('LOCAL_LIMIT');
 const headers=table.flatMap((r,i)=>r.map(norm).includes('дата операции')?[i]:[]);if(headers.length!==1)throw new BankPdfError('UNSUPPORTED_LAYOUT');
 const h=headers[0]!,header=table[h]!.map(norm);if(new Set(header).size!==header.length)throw new BankPdfError('AMBIGUOUS_FORMAT');
 const idx=(names:string[])=>header.findIndex(v=>names.includes(v));
 const date=idx(['дата операции']),amount=idx(['сумма операции','сумма в рублях']),currency=idx(['валюта']),description=idx(['описание','описание операции','назначение платежа']),bankColumn=idx(['банк']),accountColumn=idx(['номер счета','номер лицевого счета','номер договора']),posted=idx(['дата обработки','дата проводки']);
 if([date,amount,currency,description].some(i=>i<0))throw new BankPdfError('UNSUPPORTED_LAYOUT');
 const meta=(names:string[])=>table.slice(0,h).filter(r=>r.length===2&&names.includes(norm(r[0]!))).map(r=>r[1]!);
 const bankMeta=meta(['банк']),accountMeta=meta(['номер счета','номер лицевого счета','номер договора']);
 if(bankMeta.length>1||accountMeta.length>1||bankColumn<0&&!bankMeta.length||accountColumn<0&&!accountMeta.length)throw new BankPdfError('UNSUPPORTED_LAYOUT');
 const source=table.slice(h+1).filter(r=>r.some(c=>c.trim()));if(source.length>1000)throw new BankPdfError('LOCAL_LIMIT');
 const declared=source.map(r=>bankName(bankColumn<0?bankMeta[0]!:r[bankColumn]??''));
 if(declared.some(b=>!b)||new Set(declared).size>1)throw new BankPdfError('AMBIGUOUS_FORMAT');
 const bank=declared[0]??bankName(bankMeta[0]??'');if(!bank)throw new BankPdfError('UNKNOWN_FORMAT');
 if(bankMeta.length&&bankName(bankMeta[0]!)!==bank)throw new BankPdfError('AMBIGUOUS_FORMAT');
 const rows:ExtractedRow[]=source.map(r=>{
  const row:ExtractedRow={operationDate:undefined,postedDate:null,amountMinor:undefined,currency:r[currency]?.trim(),direction:'unknown',account:{kind:bank==='ozon'?'bank_contract':'bank_account',value:accountColumn<0?accountMeta[0]:r[accountColumn]},parser:`${bank}-table/1`};
  if(r.length!==header.length)return row;
  try{row.operationDate=tableDate(r[date]!);if(posted>=0&&r[posted]!.trim())row.postedDate=tableDate(r[posted]!);}catch{row.operationDate=undefined;}
  try{const a=r[amount]!.trim();Object.assign(row,pdfMoney(/^[+-]?\d+$/.test(a)?a+'.00':/^[+-]?\d+[.,]\d$/.test(a)?a+'0':a));}catch{/* Never turn bad money into zero. */}
  row.currency=['RUB','RUR','643','₽','руб.'].includes(r[currency]!.trim())?'RUB':r[currency];
  // A per-row account must agree with explicit file metadata when both are present.
  if(accountMeta.length&&accountColumn>=0&&norm(r[accountColumn]??'')!==norm(accountMeta[0]!))row.account.value=undefined;
  row.localDescription=r[description];row.safeSource=extractSafeSource(row.localDescription,row.amountMinor,localSourceSanitizer);return row;
 });
 return {fileId,bank,bytes,rows};
}
