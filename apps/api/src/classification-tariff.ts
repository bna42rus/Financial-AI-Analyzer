import {createHash} from 'node:crypto';
import {assistantTariffSource} from './analyzer-assistant-settings.ts';

/** Official PDF version 261029, verified 2026-10-29: rows 271/272 retain
 * 15.86/61 RUB per million tokens. A changed document requires review, while
 * merely waiting several days does not require a new source-code timestamp. */
export const classificationTariffDocumentSha256='49fd90cfba86bd31dd13dcb1d3750792530303823645265a3f11248e4e2980ce';
export type ClassificationTariffVerification={readonly checkedAt:string;readonly documentSha256:string};

export async function verifyClassificationTariff(fetcher:typeof fetch,now=()=>new Date()):Promise<ClassificationTariffVerification>{
 let response:Response;
 try{response=await fetcher(assistantTariffSource,{method:'GET',headers:{accept:'application/pdf','cache-control':'no-cache'},redirect:'error',signal:AbortSignal.timeout(15000)});}
 catch{throw Error('CLASSIFICATION_TARIFF_UNAVAILABLE');}
 if(!response.ok){void response.body?.cancel().catch(()=>{});throw Error('CLASSIFICATION_TARIFF_UNAVAILABLE');}
 const reader=response.body?.getReader();
 if(!reader)throw Error('CLASSIFICATION_TARIFF_DOCUMENT_INVALID');
 const hash=createHash('sha256');let size=0,header=Buffer.alloc(0);
 try{
  while(true){
   const part=await reader.read();if(part.done)break;size+=part.value.byteLength;
   if(size>2097152)throw Error('CLASSIFICATION_TARIFF_DOCUMENT_INVALID');
   if(header.length<5)header=Buffer.concat([header,part.value.subarray(0,5-header.length)]);
   hash.update(part.value);
  }
  if(header.toString('ascii')!=='%PDF-'||hash.digest('hex')!==classificationTariffDocumentSha256)throw Error('CLASSIFICATION_TARIFF_DOCUMENT_CHANGED');
  return Object.freeze({checkedAt:now().toISOString(),documentSha256:classificationTariffDocumentSha256});
 }catch(error){
  if(error instanceof Error&&['CLASSIFICATION_TARIFF_DOCUMENT_INVALID','CLASSIFICATION_TARIFF_DOCUMENT_CHANGED'].includes(error.message))throw error;
  throw Error('CLASSIFICATION_TARIFF_UNAVAILABLE');
 }finally{void reader.cancel().catch(()=>{});reader.releaseLock();}
}
