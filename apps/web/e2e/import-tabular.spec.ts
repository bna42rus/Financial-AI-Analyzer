import {test,expect} from '@playwright/test';
import {fileURLToPath} from 'node:url';
const imageFixtureUrl='/@fs'+fileURLToPath(new URL('../../../packages/imports/test/synthetic-image-pdf.ts',import.meta.url));
import {syntheticCsv,syntheticXlsx} from '../../../packages/imports/test/tabular-fixtures.ts';

test('real CSV/XLSX local preparation preserves only exact closed facts and parser metadata',async({page})=>{
 const external:string[]=[],writes:string[]=[];page.on('request',r=>{if(!r.url().startsWith('http://127.0.0.1:5173/')&&!r.url().startsWith('ws://127.0.0.1:5173/'))external.push(r.url());if(r.method()!=='GET')writes.push(r.url());});await page.goto('/');
 const result=await page.evaluate(async fixture=>{
  const path='/src/import-local.ts',module=await import(/* @vite-ignore */ path),context={contextId:crypto.randomUUID(),generation:crypto.randomUUID(),keyVersion:crypto.randomUUID(),key:btoa(String.fromCharCode(...new Uint8Array(32).fill(17))).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_'),expiresAt:new Date(Date.now()+60000).toISOString()};
  const files=[new File([fixture.csv],'Private.csv'),new File([new Uint8Array(fixture.xlsx)],'Private.xlsx')];
  return module.prepareLocalBankFiles(context,crypto.randomUUID(),files.map(file=>({fileId:crypto.randomUUID(),file})));
 },{csv:syntheticCsv,xlsx:[...syntheticXlsx()]});
 expect(result.localIssues).toEqual([]);expect(result.batch.versions.adapter).toBe('bank-local/1');expect(result.batch.versions.sanitizer).toBe('bank-source/3');
 expect(result.batch.files.map((f:any)=>f.rows.map((r:any)=>r.amountMinor))).toEqual([['-1001','2000'],['-1001','2000']]);expect(result.batch.files.every((f:any)=>f.rows.every((r:any)=>r.parser==='tbank-table/1'&&r.descriptionHmac?.length===64))).toBe(true);
 for(const secret of ['Private','00000000000000000001'])expect(JSON.stringify(result)).not.toContain(secret);
 expect(external).toEqual([]);expect(writes).toEqual([]);expect(await page.evaluate(()=>localStorage.length+sessionStorage.length)).toBe(0);expect(await page.evaluate(()=>indexedDB.databases())).toEqual([]);
});
test('XLSX dates, formulas, external relationships, extra worksheets and malformed XML fail conservatively',async({page})=>{
 await page.goto('/');const fixtures=[syntheticXlsx({numericDate:true}),syntheticXlsx({formula:true}),syntheticXlsx({external:true}),syntheticXlsx({corrupt:true}),syntheticXlsx({extraSheet:true})].map(b=>[...b]);
 const result=await page.evaluate(async fixtures=>{
  const path='/src/import-local.ts',module=await import(/* @vite-ignore */ path),context={contextId:crypto.randomUUID(),generation:crypto.randomUUID(),keyVersion:crypto.randomUUID(),key:btoa(String.fromCharCode(...new Uint8Array(32).fill(17))).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_'),expiresAt:new Date(Date.now()+60000).toISOString()};
  return module.prepareLocalBankFiles(context,crypto.randomUUID(),fixtures.map(bytes=>({fileId:crypto.randomUUID(),file:new File([new Uint8Array(bytes)],'Private.xlsx')})));
 },fixtures);
 expect(result.batch.files[0].rows[0].operationDate).toEqual({precision:'day',date:'2026-09-01'});expect(result.batch.files[1].issues).toEqual([{ordinal:1,code:'INVALID_AMOUNT'}]);expect(result.batch.files[1].rows).toHaveLength(1);expect(result.batch.files.slice(2).every((f:any)=>f.status==='blocked')).toBe(true);expect(JSON.stringify(result)).not.toContain('Private');
});
test('real local OCR loads only same-site models and retains no text, image or persistent storage',async({page})=>{
 test.setTimeout(90000);const external:string[]=[],writes:string[]=[];page.on('request',r=>{if(!r.url().startsWith('http://127.0.0.1:5173/')&&!r.url().startsWith('ws://127.0.0.1:5173/'))external.push(r.url());if(r.method()!=='GET')writes.push(r.url());});await page.goto('/');
 const result=await page.evaluate(async()=>{
  const path='/src/ocr-local.ts',module=await import(/* @vite-ignore */ path),canvas=document.createElement('canvas');canvas.width=1400;canvas.height=300;const ctx=canvas.getContext('2d')!;ctx.fillStyle='white';ctx.fillRect(0,0,1400,300);ctx.fillStyle='black';ctx.font='48px Arial';ctx.fillText('OZON 2026 100.01',50,100);
  try{const layout=await module.recognizeLocalPage(canvas,2);return layout.map((i:any)=>i.text).join(' ');}finally{canvas.width=0;canvas.height=0;}
 });
 expect(result).toContain('OZON');expect(result).toContain('100.01');expect(external).toEqual([]);expect(writes).toEqual([]);expect(await page.evaluate(()=>localStorage.length+sessionStorage.length)).toBe(0);expect(await page.evaluate(()=>indexedDB.databases())).toEqual([]);
});

test('a real scanned bank PDF passes through local rendering OCR and the closed unresolved import profile',async({page})=>{
 test.setTimeout(90000);const external:string[]=[],writes:string[]=[];page.on('request',r=>{if(!r.url().startsWith('http://127.0.0.1:5173/')&&!r.url().startsWith('ws://127.0.0.1:5173/'))external.push(r.url());if(r.method()!=='GET')writes.push(r.url());});await page.goto('/');
 const result=await page.evaluate(async fixturePath=>{
  const path='/src/import-local.ts',module=await import(/* @vite-ignore */ path);
  const canvas=document.createElement('canvas');canvas.width=2000;canvas.height=1400;const ctx=canvas.getContext('2d')!;ctx.fillStyle='white';ctx.fillRect(0,0,2000,1400);ctx.fillStyle='black';ctx.font='32px Arial';
  const layout:[string,number,number][]=[['Т-Банк Справка о движении средств',50,650],['Номер лицевого счета: 00000000000000000001',50,600],['Дата и время',50,500],['Дата',230,500],['Сумма в валюте',370,500],['Сумма операции',550,500],['Описание',740,500],['Номер',920,500],['01.09.2026',50,400],['02.09.2026',230,400],['-10.01 RUB',550,400],['Покупка OZON',740,400],['0000',920,400]];
  for(const [text,x,y] of layout)ctx.fillText(text,x*2,(700-y)*2);
  const jpeg=Uint8Array.from(atob(canvas.toDataURL('image/jpeg',1).split(',')[1]!),c=>c.charCodeAt(0));canvas.width=0;canvas.height=0;
  const fixture=await import(/* @vite-ignore */ fixturePath);
  const file=new File([fixture.syntheticImagePdf(jpeg)],'Private scanned statement.pdf'),context={contextId:crypto.randomUUID(),generation:crypto.randomUUID(),keyVersion:crypto.randomUUID(),key:btoa(String.fromCharCode(...new Uint8Array(32).fill(17))).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_'),expiresAt:new Date(Date.now()+120000).toISOString()};
  return module.prepareLocalBankFiles(context,crypto.randomUUID(),[{fileId:crypto.randomUUID(),file}]);
 },imageFixtureUrl);
 expect(result.localIssues).toEqual([]);const row=result.batch.files[0].rows[0];expect(row.amountMinor).toBe('-1001');expect(row.operationDate).toEqual({precision:'day',date:'2026-09-01'});expect(row.postedDate).toEqual({precision:'day',date:'2026-09-02'});expect(row.parser).toBe('tbank-ocr/1');expect(row.safeSource).toBeNull();expect(row.descriptionHmac).toBeNull();expect(row.bankRefHmac).toBeNull();expect(JSON.stringify(result)).not.toContain('Private');expect(JSON.stringify(result)).not.toContain('00000000000000000001');expect(external).toEqual([]);expect(writes).toEqual([]);expect(await page.evaluate(()=>indexedDB.databases())).toEqual([]);
});
