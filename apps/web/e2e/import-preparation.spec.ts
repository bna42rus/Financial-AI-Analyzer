import {expect,test} from '@playwright/test';
import {fileURLToPath} from 'node:url';
const moduleURL='/@fs'+fileURLToPath(new URL('../../../packages/imports/src/local.ts',import.meta.url));
test('browser WebCrypto preparation sends only the closed sanitized contract and does not persist a key or raw file',async({page})=>{
 const posts:string[]=[];page.on('request',r=>{if(r.method()==='POST')posts.push(r.postData()??'');});
 await page.route('**/finance/import-validation',route=>route.fulfill({status:200,contentType:'application/json',body:'{"stage":"validation_only"}'}));await page.goto('/');
 const result=await page.evaluate(async moduleURL=>{
  const {createLocalPreparation}=await import(/* @vite-ignore */ moduleURL),bytes=crypto.getRandomValues(new Uint8Array(32)),key=btoa(String.fromCharCode(...bytes)).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
  const c={contextId:crypto.randomUUID(),generation:crypto.randomUUID(),keyVersion:crypto.randomUUID(),key,expiresAt:new Date(Date.now()+60_000).toISOString()},session=await createLocalPreparation(c);
  try{
   const raw={operationDate:{precision:'day',date:'2026-09-01'},amountMinor:'-101',currency:'RUB',direction:'debit',account:{kind:'bank_account',value:'00000000000000000001'},bankReference:'Private-Bank-Ref',description:'Private recipient name and phone',merchantText:'Private merchant text'};
   const prepared=await session.prepare(crypto.randomUUID(),[{fileId:crypto.randomUUID(),bank:'tbank',bytes:new TextEncoder().encode('Private raw file content'),filename:'Private filename.pdf',password:'Private PDF password',rows:[raw,raw]}]);
   const body=JSON.stringify(prepared);await fetch('/finance/import-validation',{method:'POST',headers:{'content-type':'application/json'},body});
   return {body,containsKey:body.includes(key),rows:prepared.files[0].rows.length,ordinals:prepared.files[0].rows.map((r:{ordinal:number})=>r.ordinal),storage:Object.keys(localStorage).length+Object.keys(sessionStorage).length,databases:(await indexedDB.databases()).length};
  }finally{session.dispose();}
 },moduleURL);
 expect(result.containsKey).toBe(false);expect(result.rows).toBe(2);expect(result.ordinals).toEqual([1,2]);expect(result.storage).toBe(0);expect(result.databases).toBe(0);expect(posts).toEqual([result.body]);
 for(const secret of ['00000000000000000001','Private-Bank-Ref','Private recipient','Private merchant','Private raw','Private filename','Private PDF'])expect(result.body).not.toContain(secret);
});
test('browser cancellation blocks an in-flight preparation without sending a payload',async({page})=>{
 const posts:string[]=[];page.on('request',r=>{if(r.method()==='POST')posts.push(r.url());});await page.goto('/');
 const result=await page.evaluate(async moduleURL=>{
  const {createLocalPreparation}=await import(/* @vite-ignore */ moduleURL),bytes=crypto.getRandomValues(new Uint8Array(32)),key=btoa(String.fromCharCode(...bytes)).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_'),session=await createLocalPreparation({contextId:crypto.randomUUID(),generation:crypto.randomUUID(),keyVersion:crypto.randomUUID(),key,expiresAt:new Date(Date.now()+60_000).toISOString()});
  const pending=session.prepare(crypto.randomUUID(),[{fileId:crypto.randomUUID(),bank:'other',bytes:new Uint8Array([1,2]),rows:[]}]);session.dispose();try{await pending;return 'unexpected_success';}catch(error){return (error as Error).message;}
 },moduleURL);expect(result).toBe('PREPARATION_CLOSED');expect(posts).toEqual([]);
});
