import {bankDescription} from './bank-description.ts';
import {localBankAdapter} from './bank-table.ts';
import {extractSafeSource,parseSafeSource,descriptionSourceSanitizer,sourceSanitizer,localSourceSanitizer,sourceProfiles,normalizeSourceDescription} from './safe-source.ts';
import {dateFact,uuid} from '../../finance-core/src/model.ts';
import {parsePersistedMinor} from '../../finance-core/src/money.ts';
import {aliasKinds,banks,MAX_FILES,MAX_ROWS,parseContext,validatePreparedBatch,versions} from './contract.ts';
import type {AliasKind,Bank,Context,IssueCode,PreparedBatch,PreparedFile,PreparedRow,ProcessingVersions} from './contract.ts';
import {adapterVersions} from './contract.ts';

export type LocalContext=Context&{key:string;expiresAt:string};
/** Adapter extraction only. Raw text, names and extra columns are never copied. Structured codes need an explicit sanitizer profile. */
export type ExtractedRow={operationDate:unknown;postedDate?:unknown;amountMinor:unknown;currency:unknown;direction:unknown;account:{kind:AliasKind;value:unknown};bankReference?:unknown;[localOnly:string]:unknown};
export type ExtractedFile={fileId:string;bank:Bank;bytes:Uint8Array;rows:ExtractedRow[];error?:'LOCAL_READ_FAILED';[localOnly:string]:unknown};
export class LocalPreparationError extends Error{readonly code:string;constructor(code:string){super(code);this.code=code;}}
class RowFailure extends Error{readonly code:IssueCode;constructor(code:IssueCode){super(code);this.code=code;}}
function canonicalIdentifier(kind:AliasKind|'bank_reference',input:unknown):string{
 if(typeof input!=='string'||input.length>256||/[\p{Cc}\p{Cf}]/u.test(input))throw new RowFailure(kind==='bank_reference'?'INVALID_BANK_REFERENCE':'INVALID_ACCOUNT');
 const s=input.normalize('NFKC').trim();
 if(kind==='bank_account'||kind==='card'){
  // Only explicitly supported full Russian numeric identifiers; masked/partial identifiers are ambiguous.
  if(!/^[0-9 -]+$/.test(s))throw new RowFailure('INVALID_ACCOUNT');
  const n=s.replace(/[ -]/g,'');if(!(kind==='bank_account'?/^\d{20}$/:/^\d{16,19}$/).test(n))throw new RowFailure('INVALID_ACCOUNT');return n;
 }
 // Opaque IDs remain case/punctuation sensitive. Do not collapse distinct document IDs.
 if(!/^[A-Za-z0-9][A-Za-z0-9 ._:/-]{0,127}$/.test(s))throw new RowFailure(kind==='bank_reference'?'INVALID_BANK_REFERENCE':'INVALID_ACCOUNT');return s;
}
function bytesFromKey(input:unknown){
 if(typeof input!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(input))throw new LocalPreparationError('INVALID_PREPARATION_KEY');
 const bytes=Uint8Array.from(atob(input.replace(/-/g,'+').replace(/_/g,'/')+'='),c=>c.charCodeAt(0));
 if(bytes.length!==32||btoa(String.fromCharCode(...bytes)).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_')!==input){bytes.fill(0);throw new LocalPreparationError('INVALID_PREPARATION_KEY');}return bytes;
}
const encoder=new TextEncoder();
/** Browser WebCrypto only. No network, storage, telemetry, AI or raw-file upload dependency. */
export async function createLocalPreparation(input:LocalContext,signal?:AbortSignal,adapter:ProcessingVersions['adapter']='source-adapter/1',sanitizer:ProcessingVersions['sanitizer']='text-free/1'){
 if(!['text-free/1',...sourceProfiles].includes(sanitizer)||sanitizer!=='text-free/1'&&!((sanitizer===localSourceSanitizer||sanitizer===descriptionSourceSanitizer)?adapter===localBankAdapter:sanitizer===sourceSanitizer?adapter==='bank-pdf/2':adapter==='bank-pdf/1'))throw new LocalPreparationError('INVALID_SANITIZER');
 if(!adapterVersions.includes(adapter))throw new LocalPreparationError('INVALID_ADAPTER');
 if(signal?.aborted)throw new LocalPreparationError('PREPARATION_CLOSED');
 if(!globalThis.crypto?.subtle)throw new LocalPreparationError('LOCAL_CRYPTO_UNAVAILABLE');
 const context=parseContext({contextId:input.contextId,generation:input.generation,keyVersion:input.keyVersion}),expiresAt=Date.parse(input.expiresAt);
 if(!Number.isFinite(expiresAt)||expiresAt<=Date.now())throw new LocalPreparationError('PREPARATION_EXPIRED');
 const decoded=bytesFromKey(input.key);let key:CryptoKey|null;
 try{key=await crypto.subtle.importKey('raw',decoded,{name:'HMAC',hash:'SHA-256'},false,['sign']);}
 finally{decoded.fill(0);}
 // The key is non-extractable and only retained in this session's closure.
 let active=true;
 function dispose(){active=false;key=null;signal?.removeEventListener('abort',dispose);}
 signal?.addEventListener('abort',dispose,{once:true});
 if(signal?.aborted){dispose();throw new LocalPreparationError('PREPARATION_CLOSED');}
 function check(){if(!active||!key||signal?.aborted)throw new LocalPreparationError('PREPARATION_CLOSED');if(Date.now()>=expiresAt){dispose();throw new LocalPreparationError('PREPARATION_EXPIRED');}}
 async function sign(bytes:Uint8Array){check();const signature=await crypto.subtle.sign('HMAC',key!,new Uint8Array(bytes));check();return Array.from(new Uint8Array(signature),n=>n.toString(16).padStart(2,'0')).join('');}
 async function identifier(bank:Bank,kind:AliasKind|'bank_reference',value:unknown){return sign(encoder.encode(JSON.stringify([versions.hmac,bank,kind,canonicalIdentifier(kind,value)])));}
 async function fileFingerprint(bytes:Uint8Array){const prefix=encoder.encode(JSON.stringify([versions.hmac,'file'])+'\n'),data=new Uint8Array(prefix.length+bytes.length);data.set(prefix);data.set(bytes,prefix.length);try{return await sign(data);}finally{data.fill(0);}}
 async function prepare(batchId:string,files:ExtractedFile[]):Promise<PreparedBatch>{
  check();uuid(batchId);
  if(!Array.isArray(files)||!files.length||files.length>MAX_FILES||files.reduce((n,f)=>n+(Array.isArray(f.rows)?f.rows.length:MAX_ROWS+1),0)>MAX_ROWS)throw new LocalPreparationError('PREPARATION_LIMIT');
  const prepared:PreparedFile[]=[],ids=new Set<string>();
  for(const file of files){
   check();const fileId=uuid(file.fileId);if(ids.has(fileId)||!banks.includes(file.bank)||!(file.bytes instanceof Uint8Array)||!Array.isArray(file.rows)||file.error!==undefined&&file.error!=='LOCAL_READ_FAILED')throw new LocalPreparationError('INVALID_LOCAL_FILE');ids.add(fileId);
   const result:PreparedFile={fileId,fileHmac:await fileFingerprint(file.bytes),bank:file.bank,rowsFound:file.rows.length,status:file.error?'blocked':'prepared',error:file.error??null,rows:[],issues:[]};
   if(!file.error)for(let index=0;index<file.rows.length;index++){
    const row=file.rows[index]!,ordinal=index+1;
    try{
     if(!row||typeof row!=='object'||!row.account||!aliasKinds.includes(row.account.kind))throw new RowFailure('INVALID_ACCOUNT');
     let operationDate:PreparedRow['operationDate'],postedDate:PreparedRow['postedDate'];
     try{operationDate=dateFact(row.operationDate);postedDate=row.postedDate===undefined||row.postedDate===null?null:dateFact(row.postedDate);}catch{throw new RowFailure('INVALID_DATE');}
     try{if(typeof row.amountMinor!=='string'||row.amountMinor.length>20)throw new Error();parsePersistedMinor(row.amountMinor);}catch{throw new RowFailure('INVALID_AMOUNT');}
     if(row.currency!=='RUB')throw new RowFailure('INVALID_CURRENCY');
     const amountMinor=row.amountMinor as string,direction=row.direction;
     if(!['debit','credit','unknown'].includes(direction as string)||direction==='debit'&&BigInt(amountMinor)>=0n||direction==='credit'&&BigInt(amountMinor)<=0n)throw new RowFailure('INVALID_DIRECTION');
     const account={kind:row.account.kind,hmac:await identifier(file.bank,row.account.kind,row.account.value)},bankRefHmac=row.bankReference===null||row.bankReference===undefined?null:await identifier(file.bank,'bank_reference',row.bankReference);
     const description=(sanitizer===sourceSanitizer||sanitizer===localSourceSanitizer||sanitizer===descriptionSourceSanitizer)?normalizeSourceDescription(row.localDescription):null;
     const descriptionHmac=description===null?null:await sign(encoder.encode(JSON.stringify(['source-description/1',file.bank,row.account.kind,account.hmac,description])));
     let source=row.safeSource??null;
     if(sanitizer===descriptionSourceSanitizer){const enriched=extractSafeSource(row.localDescription,amountMinor,descriptionSourceSanitizer);if(enriched){enriched.details=bankDescription(row.localDescription,row.localMerchant,row.localBankCategory,row.localMcc);if(enriched.event==='other'&&enriched.details.mcc&&BigInt(amountMinor)<0n&&!/перевод|transfer|\bSBP\b|СБП|комисси|fee/iu.test(enriched.details.description)){enriched.event='purchase';enriched.details.merchantText ||= enriched.details.description.slice(0,160);}}source=enriched;}
     result.rows.push({ordinal,operationDate,postedDate,amountMinor,currency:'RUB',direction:direction as PreparedRow['direction'],account,bankRefHmac,...(sanitizer!=='text-free/1'?{safeSource:parseSafeSource(source,amountMinor,sanitizer)}:{}),...((sanitizer===sourceSanitizer||sanitizer===localSourceSanitizer||sanitizer===descriptionSourceSanitizer)?{descriptionHmac}:{}),...(adapter===localBankAdapter?{parser:row.parser as PreparedRow['parser']}:{})});
    }catch(error){if(!(error instanceof RowFailure))throw error;result.issues.push({ordinal,code:error.code});}
   }
   prepared.push(result);
  }
  check();return validatePreparedBatch({schemaVersion:1,versions:{...versions,adapter,sanitizer},context:{...context},batchId,files:prepared}).batch;
 }
 check();return {prepare,dispose};
}
