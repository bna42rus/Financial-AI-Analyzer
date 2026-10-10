import {unzipSync} from 'fflate';
import {BankPdfError,MAX_PDF_BYTES} from './bank-pdf.ts';
import {MAX_TABLE_CELLS,parseBankTable} from './bank-table.ts';
import type {ExtractedFile} from './local.ts';

const MAX_XML=4_000_000,MAX_EXPANDED=20_000_000;
/** Browser DOM only; reject DTDs, encrypted archives, external relationships and executable cells. */
export function readLocalXlsx(fileId:string,bytes:Uint8Array):ExtractedFile{
 if(bytes.length>MAX_PDF_BYTES)throw new BankPdfError('LOCAL_LIMIT');
 try{
  let count=0,total=0;
  const files=unzipSync(bytes,{filter:e=>{
   if(++count>200||e.originalSize>MAX_XML||(total+=e.originalSize)>MAX_EXPANDED)throw new BankPdfError('LOCAL_LIMIT');
   if(/vbaProject|externalLinks|embeddings/i.test(e.name))throw new BankPdfError('UNSUPPORTED_LAYOUT');
   return /^(?:\[Content_Types\]\.xml|xl\/(?:workbook\.xml|styles\.xml|sharedStrings\.xml|_rels\/workbook\.xml\.rels|worksheets\/sheet\d+\.xml))$/.test(e.name);
  }});
  function xml(name:string,optional=false){
   const b=files[name];if(!b){if(optional)return null;throw new BankPdfError('UNSUPPORTED_LAYOUT');}
   const s=new TextDecoder('utf-8',{fatal:true}).decode(b);if(/<!DOCTYPE|<!ENTITY/i.test(s))throw new BankPdfError('UNSUPPORTED_LAYOUT');
   const doc=new DOMParser().parseFromString(s,'application/xml');if(doc.getElementsByTagName('parsererror').length)throw new BankPdfError('UNSUPPORTED_LAYOUT');return doc;
  }
  const descendants=(node:Document|Element,name:string)=>Array.from(node.getElementsByTagNameNS('*',name));
  const workbook=xml('xl/workbook.xml')!,rels=xml('xl/_rels/workbook.xml.rels')!,sheets=descendants(workbook,'sheet');
  const relationships=descendants(rels,'Relationship');if(relationships.some(r=>r.getAttribute('TargetMode')==='External'))throw new BankPdfError('UNSUPPORTED_LAYOUT');
  const shared=xml('xl/sharedStrings.xml',true),strings=shared?descendants(shared,'si').map(n=>descendants(n,'t').map(t=>t.textContent??'').join('')):[];
  if(strings.length>MAX_TABLE_CELLS||strings.some(s=>s.length>4000))throw new BankPdfError('LOCAL_LIMIT');
  const styles=xml('xl/styles.xml',true),formats=new Map(styles?descendants(styles,'numFmt').map(n=>[Number(n.getAttribute('numFmtId')),n.getAttribute('formatCode')??'']):[]);
  const cellXfs=styles&&descendants(styles,'cellXfs')[0],xf=cellXfs?descendants(cellXfs,'xf').map(n=>Number(n.getAttribute('numFmtId'))):[];
  const date1904=['1','true'].includes(descendants(workbook,'workbookPr')[0]?.getAttribute('date1904')??'');
  function value(c:Element){
   // Neither a cached formula result nor an invented error marker is a bank
   // fact. Empty required cells become row issues; absent text cannot create
   // description HMAC/strict-dedupe evidence.
   if(descendants(c,'f').length)return '';
   const t=c.getAttribute('t'),v=descendants(c,'v')[0]?.textContent??'';
   if(t==='inlineStr')return descendants(c,'t').map(n=>n.textContent??'').join('');
   if(t==='s'){if(!/^\d+$/.test(v)||!Object.hasOwn(strings,Number(v)))throw new BankPdfError('UNSUPPORTED_LAYOUT');return strings[Number(v)]!;}
   if(t==='e'||t==='b')return '';
   const format=xf[Number(c.getAttribute('s')??0)]??0,custom=formats.get(format)??'';
   if([14,15,16,17,22].includes(format)||/y.*d|d.*y/i.test(custom.replace(/"[^"]*"/g,''))){
    // Date serials with times are not rounded or assigned an invented timezone.
    if(!/^\d{1,6}(?:\.0+)?$/.test(v))return '';
    const n=Number(v),epoch=date1904?Date.UTC(1904,0,1):Date.UTC(1899,11,31);
    if(!date1904&&n===60)return '';
    return new Date(epoch+(n-(date1904||n<60?0:1))*86400000).toISOString().slice(0,10);
   }
   return v;
  }
  const parsed:ExtractedFile[]=[];let cells=0;
  for(const sheet of sheets){
   if(sheet.getAttribute('state')&&sheet.getAttribute('state')!=='visible')throw new BankPdfError('UNSUPPORTED_LAYOUT');
   const id=sheet.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships','id'),rel=relationships.find(r=>r.getAttribute('Id')===id),target=rel?.getAttribute('Target')?.replace(/^\/xl\//,'');
   if(!target||!/^worksheets\/sheet\d+\.xml$/.test(target))throw new BankPdfError('UNSUPPORTED_LAYOUT');
   const doc=xml('xl/'+target)!,rows:string[][]=[];
   for(const row of descendants(doc,'row')){
    const out:string[]=[];
    for(const c of descendants(row,'c')){
     if(++cells>MAX_TABLE_CELLS)throw new BankPdfError('LOCAL_LIMIT');
     const ref=/^([A-Z]{1,2})\d+$/.exec(c.getAttribute('r')??'');if(!ref)throw new BankPdfError('UNSUPPORTED_LAYOUT');
     const col=[...ref[1]!].reduce((n,ch)=>n*26+ch.charCodeAt(0)-64,0)-1;if(col>=40||Object.hasOwn(out,col))throw new BankPdfError('UNSUPPORTED_LAYOUT');
     out[col]=value(c);if(out[col]!.length>4000)throw new BankPdfError('LOCAL_LIMIT');
    }
    if(out.some(v=>v.trim()))rows.push(Array.from({length:out.length},(_,i)=>out[i]??''));
   }
   if(!rows.length)continue;
   // Do not silently drop a nonempty worksheet that could contain financial rows.
   parsed.push(parseBankTable(fileId,bytes,rows));
  }
  if(parsed.length!==1)throw new BankPdfError('UNSUPPORTED_LAYOUT');return parsed[0]!;
 }catch(error){if(error instanceof BankPdfError)throw error;throw new BankPdfError('LOCAL_READ_FAILED');}
}
