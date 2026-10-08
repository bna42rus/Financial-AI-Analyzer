import {test,expect} from '@playwright/test';
import {syntheticLayout} from '../../../packages/imports/test/synthetic-layout.ts';
import {syntheticPdf} from '../../../packages/imports/test/synthetic-pdf.ts';

test('real PDF worker prepares three bank formats locally without uploading files or retaining storage',async({page})=>{
 const external:string[]=[],writes:string[]=[];
 page.on('request',r=>{if(!r.url().startsWith('http://127.0.0.1:5173/')&&!r.url().startsWith('ws://127.0.0.1:5173/'))external.push(r.url());if(r.method()!=='GET')writes.push(r.url());});
 await page.goto('/');
 const fixtures=(['tbank','ozon','sber'] as const).map(bank=>{const layout=syntheticLayout(bank),x=bank==='tbank'?390:bank==='sber'?150:225;layout[0]!.find(i=>i.x===x&&i.y===650)!.text='Покупка OZON Private-ID';return {bank,bytes:[...syntheticPdf(layout)]};});
 const output=await page.evaluate(async fixtures=>{
  const path='/src/import-local.ts',module=await import(/* @vite-ignore */ path);
  const context={contextId:crypto.randomUUID(),generation:crypto.randomUUID(),keyVersion:crypto.randomUUID(),key:btoa(String.fromCharCode(...new Uint8Array(32).fill(17))).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_'),expiresAt:new Date(Date.now()+60000).toISOString()};
  const inputs=fixtures.map(f=>({fileId:crypto.randomUUID(),file:new File([new Uint8Array(f.bytes)],'Private recipient statement.pdf',{type:'application/pdf'})}));
  const result=await module.prepareLocalBankPdfs(context,crypto.randomUUID(),inputs);
  return {result,local:localStorage.length,session:sessionStorage.length};
 },fixtures);
 expect(output.result.localIssues).toEqual([]);expect(output.result.batch.files.map((f:{bank:string})=>f.bank)).toEqual(['tbank','ozon','sber']);
 expect(output.result.batch.versions.sanitizer).toBe('bank-source/1');
 expect(output.result.batch.files.every((f:any)=>f.rows[0].safeSource?.event==='purchase'&&f.rows[0].safeSource?.merchant==='ozon')).toBe(true);
 expect(output.result.batch.files.every((f:{rows:unknown[]})=>f.rows.length===2)).toBe(true);
 const json=JSON.stringify(output.result);for(const secret of ['Sensitive','Private','Synthetic-Account-A','00000000000000000001','123456'])expect(json.includes(secret)).toBe(false);
 expect(output.local).toBe(0);expect(output.session).toBe(0);expect(external).toEqual([]);expect(writes).toEqual([]);
});

test('an unknown PDF is blocked independently while valid PDF rows remain prepared',async({page})=>{
 await page.goto('/');const bytes=[...syntheticPdf(syntheticLayout('sber'))];
 const result=await page.evaluate(async bytes=>{
  const path='/src/import-local.ts',module=await import(/* @vite-ignore */ path),context={contextId:crypto.randomUUID(),generation:crypto.randomUUID(),keyVersion:crypto.randomUUID(),key:btoa(String.fromCharCode(...new Uint8Array(32).fill(17))).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_'),expiresAt:new Date(Date.now()+60000).toISOString()};
  return module.prepareLocalBankPdfs(context,crypto.randomUUID(),[{fileId:crypto.randomUUID(),file:new File([new Uint8Array(bytes)],'Synthetic.pdf')},{fileId:crypto.randomUUID(),file:new File(['Private invalid PDF'],'Private.pdf')}]);
 },bytes);
 expect(result.batch.files[0].rows).toHaveLength(2);expect(result.batch.files[1].status).toBe('blocked');expect(result.localIssues[0].code).toBe('LOCAL_READ_FAILED');expect(JSON.stringify(result).includes('Private')).toBe(false);
});

test('oversized and unreadable local files preserve other files without inventing fingerprints',async({page})=>{
 await page.goto('/');const bytes=[...syntheticPdf(syntheticLayout('sber'))];
 const result=await page.evaluate(async bytes=>{
  const path='/src/import-local.ts',module=await import(/* @vite-ignore */ path),context={contextId:crypto.randomUUID(),generation:crypto.randomUUID(),keyVersion:crypto.randomUUID(),key:btoa(String.fromCharCode(...new Uint8Array(32).fill(17))).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_'),expiresAt:new Date(Date.now()+60000).toISOString()};
  const failed=[{fileId:crypto.randomUUID(),file:{size:21*1024*1024,arrayBuffer:async()=>{throw new Error('Private oversized file');}}},{fileId:crypto.randomUUID(),file:{size:100,arrayBuffer:async()=>{throw new Error('Private read failure');}}}];
  const partial=await module.prepareLocalBankPdfs(context,crypto.randomUUID(),[{fileId:crypto.randomUUID(),file:new File([new Uint8Array(bytes)],'Synthetic.pdf')},...failed]);
  const blocked=await module.prepareLocalBankPdfs(context,crypto.randomUUID(),failed);return {partial,blocked};
 },bytes);
 expect(result.partial.batch.files).toHaveLength(1);expect(result.partial.batch.files[0].rows).toHaveLength(2);expect(result.partial.localIssues.map((i:{code:string})=>i.code)).toEqual(['LOCAL_LIMIT','LOCAL_READ_FAILED']);expect(result.blocked.batch).toBeNull();expect(JSON.stringify(result).includes('Private')).toBe(false);
});
