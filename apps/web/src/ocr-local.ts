import {createWorker} from 'tesseract.js';
import type {Block} from 'tesseract.js';
import {BankPdfError} from '../../../packages/imports/src/bank-pdf.ts';
import type {TextItem} from '../../../packages/imports/src/bank-pdf.ts';

/** OCR words are ephemeral local data. No logging, cache, URL input or external model hosts. */
export function ocrLayout(blocks:Block[]|null,width:number,height:number,scale:number):TextItem[]{
 const words=(blocks??[]).flatMap(b=>b.paragraphs.flatMap(p=>p.lines.flatMap(l=>l.words.map(w=>({word:w,baseline:l.bbox.y1})))));
 if(words.length>10000)throw new BankPdfError('LOCAL_LIMIT');
 const out:TextItem[]=[];
 for(const {word:w,baseline} of words){
  if(!w.text.trim())continue;
  if(!Number.isFinite(w.confidence)||w.confidence<85)throw new BankPdfError('OCR_UNCERTAIN');
  const b=w.bbox;if(![b.x0,b.x1,b.y0,b.y1].every(Number.isFinite)||b.x0<0||b.x1>width||b.y0<0||b.y1>height||b.x1<=b.x0||b.y1<=b.y0)throw new BankPdfError('OCR_UNCERTAIN');
  if(!Number.isFinite(baseline))throw new BankPdfError('OCR_UNCERTAIN');
  out.push({text:w.text,x:b.x0/scale,y:(height-baseline)/scale,width:(b.x1-b.x0)/scale});
 }
 // Join nearby glyph words into original cell phrases, while retaining wide column gaps.
 const merged:TextItem[]=[];
 for(const w of out.sort((a,b)=>b.y-a.y||a.x-b.x)){
  const prev=merged.at(-1);
  if(prev&&Math.abs(prev.y-w.y)<3&&w.x-prev.x-prev.width>=-1&&w.x-prev.x-prev.width<12){prev.text+=' '+w.text;prev.width=w.x+w.width-prev.x;}
  else merged.push({...w});
 }
 return merged;
}
export async function recognizeLocalPage(canvas:HTMLCanvasElement,scale:number,signal?:AbortSignal):Promise<TextItem[]>{
 if(signal?.aborted)throw new BankPdfError('PREPARATION_CLOSED');
 let worker:Awaited<ReturnType<typeof createWorker>>|undefined,stopped=false;
 let cancel!:()=>void;
 const cancelled=new Promise<never>((_,reject)=>{cancel=()=>{stopped=true;void worker?.terminate().catch(()=>{});reject(new BankPdfError(signal?.aborted?'PREPARATION_CLOSED':'LOCAL_LIMIT'));};});
 signal?.addEventListener('abort',cancel,{once:true});
 const timeout=setTimeout(cancel,90000);
 try{
  const base=new URL(`${import.meta.env.BASE_URL}ocr-v1/`,location.origin).href;
  const pending=createWorker(['rus','eng'],1,{workerPath:base+'worker.min.js',corePath:base,langPath:base,workerBlobURL:false,cacheMethod:'none',gzip:true,logger:()=>{},errorHandler:()=>{}});
  void pending.then(w=>{if(stopped||signal?.aborted)void w.terminate().catch(()=>{});}).catch(()=>{});
  worker=await Promise.race([pending,cancelled]);
  if(signal?.aborted)throw new BankPdfError('PREPARATION_CLOSED');
  const result=await Promise.race([worker.recognize(canvas,{}, {text:false,blocks:true}),cancelled]);
  return ocrLayout(result.data.blocks,canvas.width,canvas.height,scale);
 }catch(error){if(error instanceof BankPdfError)throw error;throw new BankPdfError('LOCAL_READ_FAILED');}
 finally{clearTimeout(timeout);signal?.removeEventListener('abort',cancel);await worker?.terminate().catch(()=>{});}
}
