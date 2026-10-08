import {BankPdfError,MAX_PDF_BYTES,MAX_PDF_PAGES,MAX_PDF_ITEMS,MAX_PDF_TEXT,parseBankPdf} from './bank-pdf.ts';
import type {PdfLayout,TextItem} from './bank-pdf.ts';
import type {ExtractedFile} from './local.ts';

/** Minimal local PDF engine boundary. No URL, password callback, telemetry or storage argument. */
export type LocalPdfEngine={getDocument:(options:Record<string,unknown>)=>{promise:Promise<{numPages:number;getPage:(n:number)=>Promise<{getTextContent:()=>Promise<{items:unknown[]}>;cleanup:()=>void}>}>;destroy:()=>Promise<void>}};
/** Password exists only during this local attempt. Errors never retain the engine's message/stack. */
export async function readLocalPdf(engine:LocalPdfEngine,fileId:string,bytes:Uint8Array,password?:string,signal?:AbortSignal):Promise<ExtractedFile>{
 if(signal?.aborted)throw new BankPdfError('PREPARATION_CLOSED');if(bytes.length>MAX_PDF_BYTES)throw new BankPdfError('LOCAL_LIMIT');
 if(password!==undefined&&(typeof password!=='string'||password.length>1024))throw new BankPdfError('LOCAL_READ_FAILED');
 const copy=new Uint8Array(bytes);let task:ReturnType<LocalPdfEngine['getDocument']>|undefined,destroyed=false;
 const destroy=async()=>{if(task&&!destroyed){destroyed=true;await task.destroy();}};
 const abort=()=>{void destroy().catch(()=>{});};signal?.addEventListener('abort',abort,{once:true});
 try{
  task=engine.getDocument({data:copy,password,verbosity:0,isEvalSupported:false,useWorkerFetch:false,useWasm:false,disableFontFace:true,stopAtErrors:true,enableXfa:false,disableRange:true,disableStream:true,disableAutoFetch:true});password=undefined;
  if(signal?.aborted)throw new BankPdfError('PREPARATION_CLOSED');
  const doc=await task.promise;if(doc.numPages>MAX_PDF_PAGES)throw new BankPdfError('LOCAL_LIMIT');
  const layout:PdfLayout=[];let itemCount=0,characters=0;
  for(let n=1;n<=doc.numPages;n++){
   if(signal?.aborted)throw new BankPdfError('PREPARATION_CLOSED');const page=await doc.getPage(n);
   try{const content=await page.getTextContent(),items:TextItem[]=[];
    for(const raw of content.items){const i=raw as {str?:unknown;transform?:number[];width?:number};if(typeof i.str!=='string')continue;
     itemCount++;characters+=i.str.length;if(itemCount>MAX_PDF_ITEMS||characters>MAX_PDF_TEXT)throw new BankPdfError('LOCAL_LIMIT');
     items.push({text:i.str,x:i.transform?.[4]??NaN,y:i.transform?.[5]??NaN,width:i.width??NaN});
    }layout.push(items);
   }finally{page.cleanup();}
  }
  if(signal?.aborted)throw new BankPdfError('PREPARATION_CLOSED');return parseBankPdf(fileId,bytes,layout);
 }catch(error){
  if(signal?.aborted)throw new BankPdfError('PREPARATION_CLOSED');if(error instanceof BankPdfError)throw error;
  const e=error as {name?:string;code?:number};if(e?.name==='PasswordException')throw new BankPdfError(e.code===2?'WRONG_PASSWORD':'PASSWORD_REQUIRED');
  throw new BankPdfError('LOCAL_READ_FAILED');
 }finally{signal?.removeEventListener('abort',abort);password=undefined;await destroy().catch(()=>{});if(copy.byteLength)copy.fill(0);}
}
