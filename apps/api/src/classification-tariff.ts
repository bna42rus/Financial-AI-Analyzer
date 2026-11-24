import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {assistantTariffSource} from './analyzer-assistant-settings.ts';
import {rubAmount,tokenPrice} from '../../../packages/analyzer/src/cost.ts';
import type {TokenPrice} from '../../../packages/analyzer/src/cost.ts';

/** Historical reviewed proof retained for old private trial evidence only.
 * Live verification reads the current model's rows; the whole PDF is not pinned. */
export const classificationTariffDocumentSha256='49fd90cfba86bd31dd13dcb1d3750792530303823645265a3f11248e4e2980ce';
export type ClassificationTariffVerification={readonly checkedAt:string;readonly documentSha256:string;readonly price?:TokenPrice};
const verified=new WeakSet<object>();
export function isClassificationTariffVerification(value:ClassificationTariffVerification){
 return !!value&&typeof value.documentSha256==='string'&&/^[a-f0-9]{64}$/.test(value.documentSha256)&&
  (verified.has(value)||value.documentSha256===classificationTariffDocumentSha256&&value.price===undefined);
}

/** Fixed public PDF only, no inherited application secrets, files or network.
 * A bounded native parser handles PDF fonts/compression instead of guessing text. */
export function extractClassificationTariffText(bytes:Uint8Array):Promise<string>{
 return new Promise((resolve,reject)=>{
  const child=execFile('/usr/bin/prlimit',['--as=536870912','--cpu=5','--','/usr/bin/pdftotext','-layout','-enc','UTF-8','-','-'],
   {encoding:'utf8',timeout:10000,killSignal:'SIGKILL',maxBuffer:2097152,env:{LANG:'C.UTF-8',LC_ALL:'C.UTF-8'}},
   (error,stdout)=>error?reject(Error('CLASSIFICATION_TARIFF_EXTRACTION_FAILED')):resolve(stdout));
  child.stdin?.on('error',()=>{});child.stdin?.end(bytes);
 });
}

/** Select only Cloud.ru's own model SKU, not the separate partner/OpenAI SKU.
 * Preserve exact decimal money and require one input/output row per document. */
export function classificationTariffPrice(text:string,documentSha256:string):TokenPrice{
 if(text.length>2097152||!text.includes('Evolution Foundation Models')||
    !/Цена\s+с\s+НДС\*?\s*,?/u.test(text)||!/НДС[^\n]*руб\./u.test(text))throw Error('CLASSIFICATION_TARIFF_DOCUMENT_INVALID');
 const lines=text.normalize('NFKC').replace(/[\u00a0\u202f]/gu,' ').split(/\r?\n/u);
 const start=/^\s*\d{1,5}\.\s*БЯМ\s+gpt-oss-120b\b/iu;
 const decimal='([0-9]{1,7}(?:[.,][0-9]{1,9})?)';
 const row=new RegExp('^\\s*\\d{1,5}\\.\\s*БЯМ\\s+gpt-oss-120b\\s+(входные|генерируемые)\\s+токены\\s+млн\\s+шт\\.?\\s+месяц\\s+'+decimal+'\\s+'+decimal+'\\s+'+decimal+'\\s*$','iu');
 const found:Partial<Record<'input'|'output',string>>={};let candidates=0;
 for(let i=0;i<lines.length;i++){
  if(!start.test(lines[i]!))continue;
  candidates++;let block=lines[i]!,match=row.exec(block.trim());
  for(let j=i+1;!match&&j<Math.min(lines.length,i+4)&&!/^\s*\d{1,5}\./u.test(lines[j]!);j++){block+=' '+lines[j];match=row.exec(block.trim());}
  if(!match)throw Error('CLASSIFICATION_TARIFF_DOCUMENT_INVALID');
  const kind=match[1]!.toLowerCase()==='входные'?'input':'output';
  const values=match.slice(2).map(n=>n.replace(',','.'));
  if(found[kind]!==undefined||rubAmount(values[0]!)+rubAmount(values[1]!)!==rubAmount(values[2]!))throw Error('CLASSIFICATION_TARIFF_DOCUMENT_INVALID');
  const [whole,fraction='']=values[2]!.split('.');
  const tail=fraction.replace(/0+$/u,'');found[kind]=BigInt(whole!).toString()+(tail?'.'+tail:'');
 }
 if(candidates!==2||!found.input||!found.output)throw Error('CLASSIFICATION_TARIFF_DOCUMENT_INVALID');
 return Object.freeze(tokenPrice({version:'cloud-pdf-'+documentSha256.slice(0,54),currency:'RUB',inputRubPerMillion:found.input,outputRubPerMillion:found.output}));
}

/** Conditional GET before each paid dispatch. Concurrent dispatches share the
 * caller's guard. A 304 reuses only an already parsed, verified document. */
export function classificationTariffVerifier(fetcher:typeof fetch,now=()=>new Date(),extract=extractClassificationTariffText){
 let cached:ClassificationTariffVerification|undefined,etag:string|undefined;
 return async():Promise<ClassificationTariffVerification>=>{

 let response:Response;
 try{response=await fetcher(assistantTariffSource,{method:'GET',headers:{accept:'application/pdf','cache-control':'no-cache',...(etag?{'if-none-match':etag}:{})},redirect:'error',signal:AbortSignal.timeout(15000)});}
 catch{throw Error('CLASSIFICATION_TARIFF_UNAVAILABLE');}
 if(response.status===304&&cached&&etag){
  const result=Object.freeze({...cached,checkedAt:now().toISOString()});verified.add(result);return result;
 }
 if(!response.ok){void response.body?.cancel().catch(()=>{});throw Error('CLASSIFICATION_TARIFF_UNAVAILABLE');}
 const reader=response.body?.getReader();
 if(!reader)throw Error('CLASSIFICATION_TARIFF_DOCUMENT_INVALID');
 const hash=createHash('sha256');let size=0,header=Buffer.alloc(0);const chunks:Uint8Array[]=[];
 try{
  while(true){
   const part=await reader.read();if(part.done)break;size+=part.value.byteLength;
   if(size>2097152)throw Error('CLASSIFICATION_TARIFF_DOCUMENT_INVALID');
   if(header.length<5)header=Buffer.concat([header,part.value.subarray(0,5-header.length)]);
   hash.update(part.value);
   chunks.push(part.value);
  }
  if(header.toString('ascii')!=='%PDF-')throw Error('CLASSIFICATION_TARIFF_DOCUMENT_CHANGED');
  const documentSha256=hash.digest('hex');
  const price=classificationTariffPrice(await extract(Buffer.concat(chunks)),documentSha256);
  const result=Object.freeze({checkedAt:now().toISOString(),documentSha256,price});verified.add(result);
  const candidate=response.headers.get('etag');etag=candidate&&/^(?:W\/)?"[\x21\x23-\x7e]{1,200}"$/u.test(candidate)?candidate:undefined;
  cached=result;return result;
 }catch(error){
  if(error instanceof Error&&['CLASSIFICATION_TARIFF_DOCUMENT_INVALID','CLASSIFICATION_TARIFF_DOCUMENT_CHANGED','CLASSIFICATION_TARIFF_EXTRACTION_FAILED'].includes(error.message))throw error;
  throw Error('CLASSIFICATION_TARIFF_UNAVAILABLE');
 }finally{void reader.cancel().catch(()=>{});reader.releaseLock();}
 };
}
export function verifyClassificationTariff(fetcher:typeof fetch,now=()=>new Date(),extract=extractClassificationTariffText){return classificationTariffVerifier(fetcher,now,extract)();}
