import {createLocalPreparation} from '../../../packages/imports/src/local.ts';
import type {LocalContext,ExtractedFile} from '../../../packages/imports/src/local.ts';
import {bankPdfAdapter,BankPdfError,MAX_PDF_BYTES} from '../../../packages/imports/src/bank-pdf.ts';
import type {PdfFailure} from '../../../packages/imports/src/bank-pdf.ts';
import {readLocalPdf} from '../../../packages/imports/src/pdf-reader.ts';
import type {LocalPdfEngine} from '../../../packages/imports/src/pdf-reader.ts';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

/** Device-only entry point. No File/filename/password/layout can be passed to a server client. */
export async function prepareLocalBankPdfs(context:LocalContext,batchId:string,inputs:{fileId:string;file:File;password?:string}[],signal?:AbortSignal){
 if(inputs.length<1||inputs.length>10)throw new BankPdfError('LOCAL_LIMIT');
 const session=await createLocalPreparation(context,signal,bankPdfAdapter),files:ExtractedFile[]=[],issues:{fileId:string;code:PdfFailure}[]=[];
 try{
  const pdf=await import('pdfjs-dist');pdf.GlobalWorkerOptions.workerSrc=workerUrl;
  for(const input of inputs){
   if(signal?.aborted)throw new BankPdfError('PREPARATION_CLOSED');
   if(input.file.size>MAX_PDF_BYTES){issues.push({fileId:input.fileId,code:'LOCAL_LIMIT'});continue;}
   let bytes:Uint8Array;
   try{bytes=new Uint8Array(await input.file.arrayBuffer());}catch{issues.push({fileId:input.fileId,code:'LOCAL_READ_FAILED'});continue;}
   try{
    try{files.push(await readLocalPdf(pdf as unknown as LocalPdfEngine,input.fileId,bytes,input.password,signal));}
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
