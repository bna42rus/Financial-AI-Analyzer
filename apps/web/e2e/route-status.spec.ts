import {expect,test} from '@playwright/test';
import type {Page} from '@playwright/test';
import {createServer} from 'vite';
import type {ViteDevServer} from 'vite';
import {fileURLToPath} from 'node:url';

let server:ViteDevServer,base:string;
test.beforeAll(async()=>{
 server=await createServer({root:fileURLToPath(new URL('..',import.meta.url)),cacheDir:fileURLToPath(new URL('../node_modules/.vite-route-'+process.pid,import.meta.url)),server:{host:'127.0.0.1',port:0,strictPort:false},define:{'import.meta.env.VITE_API_ORIGIN':JSON.stringify('http://127.0.0.1:3000')}});
 await server.listen();base=server.resolvedUrls!.local[0]!;
});
test.afterAll(async()=>{await server?.close();});

async function mock(page:Page,session:Record<string,unknown>|null){
 await page.route('http://127.0.0.1:3000/**',async route=>{
  const request=route.request(),path=new URL(request.url()).pathname;
  const headers={'Access-Control-Allow-Origin':request.headers().origin??new URL(base).origin,'Access-Control-Allow-Credentials':'true','Access-Control-Allow-Headers':'content-type','Access-Control-Allow-Methods':'GET,POST,OPTIONS'};
  if(request.method()==='OPTIONS'){await route.fulfill({status:204,headers});return;}
  const oldRequest={id:'old-request',status:'awaiting_payment',email:'old@example.test',tariff:{id:'old-tariff',name:'1 месяц',duration:{kind:'calendar_months',count:1},priceMinor:39900},expiresAt:'2026-12-01T00:00:00.000Z'};
  const status=path==='/session'&&!session?401:path==='/access/request'||path==='/session'||path==='/access/tariffs'?200:404;
  const result=path==='/session'?session??{code:'AUTH_REQUIRED'}:path==='/access/request'?{request:oldRequest}:path==='/access/tariffs'?{tariffs:[]}:{code:'NOT_FOUND'};
  await route.fulfill({status,headers,contentType:'application/json',body:JSON.stringify(result)});
 });
}
test('a guest sees the public home and an old application cookie never reopens payment',async({page})=>{
 await mock(page,null);
 await page.goto(base);
 await expect(page.getByRole('heading',{name:'Поймите, куда уходят деньги'})).toBeVisible();
 await page.getByRole('link',{name:'Получить доступ'}).first().click();
 await expect(page.getByRole('heading',{name:'Получить доступ',exact:true})).toBeVisible();
 await expect(page.getByText('Оплатите доступ')).toHaveCount(0);
});
test('active sessions enter the finance workspace even from public hashes',async({page})=>{
 await mock(page,{name:'Пользователь',scope:'active',capabilities:['finance'],indefinite:true,timezone:'Europe/Moscow'});
 await page.goto(base+'#login');
 await expect(page.getByRole('navigation',{name:'Разделы сайта',exact:true})).toBeVisible();
 await expect(page.getByRole('link',{name:'CashNeuro — Финансовый анализатор'})).toBeVisible();
});
for(const [name,session,heading] of [
 ['suspended',{name:'Пользователь',scope:'restricted',blocked:true,indefinite:false,accessEnd:'2026-11-17T15:21:00.000Z'},'Доступ приостановлен'],
 ['expired',{name:'Пользователь',scope:'restricted',blocked:false,indefinite:false,accessEnd:'2026-11-01T15:21:00.000Z'},'Срок доступа закончился'],
] as const){
 test(name+' sessions retain the correct screen after the brand navigation',async({page})=>{
  await mock(page,session);
  await page.goto(base+'#access');
  await expect(page.getByRole('heading',{name:heading})).toBeVisible();
  await page.getByRole('link',{name:'CashNeuro',exact:true}).click();
  await expect(page.getByRole('heading',{name:heading})).toBeVisible();
 });
}
