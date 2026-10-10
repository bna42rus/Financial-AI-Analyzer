import {localBankAdapter,csvTable,parseBankTable} from '../../../packages/imports/src/bank-table.ts';
import {readLocalXlsx} from '../../../packages/imports/src/xlsx-reader.ts';
import {pdfParserVersions} from '../../../packages/imports/src/bank-pdf.ts';
import type {PDFPageProxy} from 'pdfjs-dist';
import {sourceSanitizer,localSourceSanitizer,extractSafeSource} from '../../../packages/imports/src/safe-source.ts';
import {createLocalPreparation} from '../../../packages/imports/src/local.ts';
import type {LocalContext,ExtractedFile} from '../../../packages/imports/src/local.ts';
import {bankPdfAdapter,BankPdfError,MAX_PDF_BYTES} from '../../../packages/imports/src/bank-pdf.ts';
import type {PdfFailure} from '../../../packages/imports/src/bank-pdf.ts';
import {readLocalPdf} from '../../../packages/imports/src/pdf-reader.ts';
import type {LocalPdfEngine} from '../../../packages/imports/src/pdf-reader.ts';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

/** Device-only entry point. No File/filename/password/layout can be passed to a server client. */
export async function prepareLocalBankFiles(context:LocalContext,batchId:string,inputs:{fileId:string;file:File;password?:string}[],signal?:AbortSignal,legacyPdfOnly=false){
 if(inputs.length<1||inputs.length>10)throw new BankPdfError('LOCAL_LIMIT');
 const session=await createLocalPreparation(context,signal,legacyPdfOnly?bankPdfAdapter:localBankAdapter,legacyPdfOnly?sourceSanitizer:localSourceSanitizer),files:ExtractedFile[]=[],issues:{fileId:string;code:PdfFailure}[]=[];
 try{
  const pdf=await import('pdfjs-dist');pdf.GlobalWorkerOptions.workerSrc=workerUrl;
  for(const input of inputs){
   if(signal?.aborted)throw new BankPdfError('PREPARATION_CLOSED');
   if(input.file.size>MAX_PDF_BYTES){issues.push({fileId:input.fileId,code:'LOCAL_LIMIT'});continue;}
   let bytes:Uint8Array;
   try{bytes=new Uint8Array(await input.file.arrayBuffer());}catch{issues.push({fileId:input.fileId,code:'LOCAL_READ_FAILED'});continue;}
   try{
    try{
      const ext=input.file.name?.split('.').at(-1)?.toLowerCase()??'pdf';let extracted:ExtractedFile;
      if(ext==='csv'){
       let text:string;try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{text=new TextDecoder('windows-1251',{fatal:true}).decode(bytes);}
       extracted=parseBankTable(input.fileId,bytes,csvTable(text));text='';
      }else if(ext==='xlsx')extracted=readLocalXlsx(input.fileId,bytes);
      else if(ext==='pdf')extracted=await readLocalPdf(pdf as unknown as LocalPdfEngine,input.fileId,bytes,input.password,signal,legacyPdfOnly?undefined:async raw=>{
       const page=raw as PDFPageProxy,scale=2,viewport=page.getViewport({scale});
       if(viewport.width*viewport.height>6_000_000)throw new BankPdfError('LOCAL_LIMIT');
       const canvas=document.createElement('canvas');canvas.width=Math.ceil(viewport.width);canvas.height=Math.ceil(viewport.height);
       const context=canvas.getContext('2d');if(!context)throw new BankPdfError('LOCAL_READ_FAILED');
       const render=page.render({canvas,canvasContext:context,viewport}),abort=()=>render.cancel();signal?.addEventListener('abort',abort,{once:true});
       try{await render.promise;const {recognizeLocalPage}=await import('./ocr-local');return await recognizeLocalPage(canvas,scale,signal);}
       finally{signal?.removeEventListener('abort',abort);context.clearRect(0,0,canvas.width,canvas.height);canvas.width=0;canvas.height=0;}
      });
      else throw new BankPdfError('UNKNOWN_FORMAT');
      if(!legacyPdfOnly)for(const row of extracted.rows){row.parser??=pdfParserVersions[extracted.bank as keyof typeof pdfParserVersions];if(!(row.parser as string).includes('-ocr/'))row.safeSource=extractSafeSource(row.localDescription,row.amountMinor,localSourceSanitizer);}
      files.push(extracted);
     }
    catch(error){if(!(error instanceof BankPdfError)||error.code==='PREPARATION_CLOSED')throw error;
     issues.push({fileId:input.fileId,code:error.code});files.push({fileId:input.fileId,bytes,bank:'other',rows:[],error:'LOCAL_READ_FAILED'});
    }
    // prepare requires file bytes for per-user HMAC; bytes are cleared after the batch is prepared.
   }catch(error){bytes.fill(0);throw error;}
  }
  if(signal?.aborted)throw new BankPdfError('PREPARATION_CLOSED');
  const batch=files.length?await session.prepare(batchId,files):null;return {batch,localIssues:issues};
 }finally{session.dispose();for(const f of files){f.bytes.fill(0);f.rows.length=0;}}
}

/** Compatibility entry for the previously verified text-PDF profile. */
export const prepareLocalBankPdfs=(...args:Parameters<typeof prepareLocalBankFiles>)=>prepareLocalBankFiles(args[0],args[1],args[2],args[3],true);
