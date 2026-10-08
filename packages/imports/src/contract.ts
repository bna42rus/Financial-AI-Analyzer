import {dateFact,object,uuid} from '../../finance-core/src/model.ts';
import type {BankDate} from '../../finance-core/src/model.ts';
import {parsePersistedMinor} from '../../finance-core/src/money.ts';

/** A deliberately text-free first preparation profile, not a bank parser. */
export const versions=Object.freeze({pipeline:'local-prepare/1',normalizer:'strict-source/1',sanitizer:'text-free/1',hmac:'namespaced-hmac/1',adapter:'source-adapter/1'} as const);
export const adapterVersions=['source-adapter/1','bank-pdf/1'] as const;
export type ProcessingVersions=Omit<typeof versions,'adapter'>&{adapter:typeof adapterVersions[number]};
export const banks=['tbank','ozon','sber','other'] as const;
export type Bank=typeof banks[number];
export const aliasKinds=['bank_account','card','loan_contract','bank_contract'] as const;
export type AliasKind=typeof aliasKinds[number];
export const issueCodes=['INVALID_DATE','INVALID_AMOUNT','INVALID_CURRENCY','INVALID_ACCOUNT','INVALID_DIRECTION','INVALID_BANK_REFERENCE','INVALID_PSEUDONYM'] as const;
export type IssueCode=typeof issueCodes[number];
export type RowIssue={ordinal:number;code:IssueCode};
export type Context={contextId:string;generation:string;keyVersion:string};
export type PreparedRow={ordinal:number;operationDate:BankDate;postedDate:BankDate|null;amountMinor:string;currency:'RUB';direction:'debit'|'credit'|'unknown';account:{kind:AliasKind;hmac:string};bankRefHmac:string|null};
export type PreparedFile={fileId:string;fileHmac:string;bank:Bank;rowsFound:number;status:'prepared'|'blocked';error:'LOCAL_READ_FAILED'|null;rows:PreparedRow[];issues:RowIssue[]};
export type PreparedBatch={schemaVersion:1;versions:ProcessingVersions;context:Context;batchId:string;files:PreparedFile[]};
// Development contract guards; these do not promise supported bank file/device limits.
export const MAX_FILES=10,MAX_ROWS=1000;
export class ImportContractError extends Error {constructor(){super('INVALID_IMPORT_PAYLOAD');}}
function allowed(value:unknown,keys:string[]){try{return object(value,keys);}catch{throw new ImportContractError();}}
function closed(value:unknown,keys:string[]){const r=allowed(value,keys);if(Object.keys(r).length!==keys.length||keys.some(k=>!Object.hasOwn(r,k)))throw new ImportContractError();return r;}
function id(value:unknown){try{return uuid(value);}catch{throw new ImportContractError();}}
function count(value:unknown,min=0,max=MAX_ROWS):number{if(typeof value!=='number'||!Number.isSafeInteger(value)||value<min||value>max)throw new ImportContractError();return value;}
export function hmacValue(value:unknown):value is string{return typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);}
export function parseContext(value:unknown):Context{const r=closed(value,['contextId','generation','keyVersion']);return {contextId:id(r.contextId),generation:id(r.generation),keyVersion:id(r.keyVersion)};}
class InvalidRow extends Error {readonly code:IssueCode;constructor(code:IssueCode){super(code);this.code=code;}}
function rowDate(value:unknown){try{return dateFact(value);}catch{throw new InvalidRow('INVALID_DATE');}}
function rowAmount(value:unknown):string{try{if(typeof value!=='string'||value.length>20)throw new Error();parsePersistedMinor(value);return value;}catch{throw new InvalidRow('INVALID_AMOUNT');}}
function parseRow(value:unknown):PreparedRow{
 const r=allowed(value,['ordinal','operationDate','postedDate','amountMinor','currency','direction','account','bankRefHmac']);
 const ordinal=count(r.ordinal,1),operationDate=rowDate(r.operationDate),postedDate=r.postedDate===null||r.postedDate===undefined?null:rowDate(r.postedDate),amountMinor=rowAmount(r.amountMinor);
 if(!r.account||typeof r.account!=='object'||Array.isArray(r.account))throw new InvalidRow('INVALID_ACCOUNT');
 const account=allowed(r.account,['kind','hmac']);
 if(r.currency!=='RUB')throw new InvalidRow('INVALID_CURRENCY');
 if(!aliasKinds.includes(account.kind as AliasKind))throw new InvalidRow('INVALID_ACCOUNT');
 if(!hmacValue(account.hmac)||r.bankRefHmac!==null&&r.bankRefHmac!==undefined&&!hmacValue(r.bankRefHmac))throw new InvalidRow('INVALID_PSEUDONYM');
 if(!['debit','credit','unknown'].includes(r.direction as string)||r.direction==='debit'&&BigInt(amountMinor)>=0n||r.direction==='credit'&&BigInt(amountMinor)<=0n)throw new InvalidRow('INVALID_DIRECTION');
 return {ordinal,operationDate,postedDate,amountMinor,currency:'RUB',direction:r.direction as PreparedRow['direction'],account:{kind:account.kind as AliasKind,hmac:account.hmac},bankRefHmac:(r.bankRefHmac??null) as string|null};
}

/** The server independently validates; invalid facts become technical issues, never zero/date guesses. */
export function validatePreparedBatch(input:unknown){
 const r=closed(input,['schemaVersion','versions','context','batchId','files']),v=closed(r.versions,Object.keys(versions));
 if(r.schemaVersion!==1||Object.entries(versions).some(([k,value])=>k==='adapter'?!adapterVersions.includes(v[k] as ProcessingVersions['adapter']):v[k]!==value))throw new ImportContractError();
 const context=parseContext(r.context),batchId=id(r.batchId);
 if(!Array.isArray(r.files)||r.files.length<1||r.files.length>MAX_FILES)throw new ImportContractError();
 const fileIds=new Set<string>();let totalRows=0;
 const files=r.files.map(value=>{
  const f=closed(value,['fileId','fileHmac','bank','rowsFound','status','error','rows','issues']),fileId=id(f.fileId),rowsFound=count(f.rowsFound);
  if(fileIds.has(fileId)||!hmacValue(f.fileHmac)||!banks.includes(f.bank as Bank)||!Array.isArray(f.rows)||!Array.isArray(f.issues))throw new ImportContractError();
  fileIds.add(fileId);totalRows+=rowsFound;if(totalRows>MAX_ROWS)throw new ImportContractError();
  if(f.status==='blocked'){
   if(f.error!=='LOCAL_READ_FAILED'||f.rows.length||f.issues.length)throw new ImportContractError();
   return {fileId,fileHmac:f.fileHmac,bank:f.bank as Bank,rowsFound,status:'blocked' as const,error:'LOCAL_READ_FAILED' as const,rows:[],issues:[]};
  }
  if(f.status!=='prepared'||f.error!==null||rowsFound!==f.rows.length+f.issues.length)throw new ImportContractError();
  const seen=new Set<number>(),issues:RowIssue[]=[],rows:PreparedRow[]=[];
  const ordinal=(value:unknown)=>{const n=count(value,1,rowsFound);if(seen.has(n))throw new ImportContractError();seen.add(n);return n;};
  for(const value of f.issues){const i=closed(value,['ordinal','code']);if(!issueCodes.includes(i.code as IssueCode))throw new ImportContractError();issues.push({ordinal:ordinal(i.ordinal),code:i.code as IssueCode});}
  for(const value of f.rows){
   // Inspect field names even on an invalid row: never silently ignore a raw identifier/text field.
   const item=allowed(value,['ordinal','operationDate','postedDate','amountMinor','currency','direction','account','bankRefHmac']),n=ordinal(item.ordinal);
   if(item.account&&typeof item.account==='object'&&!Array.isArray(item.account))allowed(item.account,['kind','hmac']);
   // Nested date fields also have a closed schema, including rows with a different invalid fact.
   for(const d of [item.operationDate,item.postedDate])if(d!==null&&typeof d==='object'&&!Array.isArray(d)){
    const date=d as Record<string,unknown>;if(Object.keys(date).some(k=>!['precision','date','instant'].includes(k)))throw new ImportContractError();
   }
   try{rows.push(parseRow(item));}catch(error){if(!(error instanceof InvalidRow))throw error;issues.push({ordinal:n,code:error.code});}
  }
  rows.sort((a,b)=>a.ordinal-b.ordinal);issues.sort((a,b)=>a.ordinal-b.ordinal);
  return {fileId,fileHmac:f.fileHmac,bank:f.bank as Bank,rowsFound,status:'prepared' as const,error:null,rows,issues};
 });
 const reportFiles=files.map(f=>({fileId:f.fileId,status:f.status,error:f.error,rowsFound:f.rowsFound,validRows:f.rows.length,rowsNotPrepared:f.rowsFound-f.rows.length,issues:f.issues}));
 const report={schemaVersion:1 as const,batchId,stage:'validation_only' as const,files:reportFiles,counts:{files:files.length,blockedFiles:files.filter(f=>f.status==='blocked').length,rowsFound:totalRows,validRows:files.reduce((n,f)=>n+f.rows.length,0),rowsNotPrepared:files.reduce((n,f)=>n+f.rowsFound-f.rows.length,0)}};
 return {batch:{schemaVersion:1 as const,versions:{...versions,adapter:v.adapter as ProcessingVersions['adapter']},context,batchId,files},report};
}
