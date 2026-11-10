import {expect,test} from '@playwright/test';
import {fileURLToPath} from 'node:url';
import {createServer} from 'vite';
import type {ViteDevServer} from 'vite';

const api='http://127.0.0.1:3001',financeOrigin='https://finance.example.test';
let server:ViteDevServer,base:string;
test.beforeAll(async()=>{
 server=await createServer({root:fileURLToPath(new URL('..',import.meta.url)),cacheDir:'node_modules/.vite-connected-'+process.pid,
  server:{host:'127.0.0.1',port:0},define:{'import.meta.env.VITE_API_ORIGIN':JSON.stringify(api),'import.meta.env.VITE_FINANCE_ORIGIN':JSON.stringify(financeOrigin)}});
 await server.listen();base=server.resolvedUrls!.local[0]!;
});
test.afterAll(async()=>{await server?.close();});

test('tariff dialogs preserve the workspace edges and invitation link has one visible title',async({page})=>{
 const now=new Date().toISOString(),invitation='invite-fixture',url=financeOrigin+'/#invite?token=synthetic';
 await page.route(api+'/**',async route=>{
  const path=new URL(route.request().url()).pathname;
  const headers={'Access-Control-Allow-Origin':new URL(base).origin,'Access-Control-Allow-Credentials':'true',
   'Access-Control-Allow-Headers':'content-type','Access-Control-Allow-Methods':'GET,POST,OPTIONS'};
  if(route.request().method()==='OPTIONS')return route.fulfill({status:204,headers});
  const json=path==='/session'?{scope:'admin',name:'Тест'}:path==='/control/admin-preferences'?{timezone:'device'}:
   path==='/control/commerce-catalog'?{packs:[],plans:Array.from({length:12},(_,i)=>({id:'tariff-'+i,name:'Тест',duration:{kind:'days',count:i+1},priceMinor:'11900',aiQuota:2500,active:true,publicVisible:true}))}:
   path==='/control/workspace-invitations'?{invitations:[{id:invitation,email:'invitation@example.test',createdAt:now,expiresAt:now,state:'active',delivery:'sent',origin:'manual'}]}:
   {token:'synthetic'};
  await route.fulfill({headers,json});
 });
 await page.goto(base+'#tariffs');
 await page.addStyleTag({content:'html::-webkit-scrollbar{width:16px}'});
 const main=page.locator('main'),header=page.locator('[data-admin-shell] > header');
 const edges=async()=>Promise.all([main,header].map(l=>l.evaluate(e=>({left:e.getBoundingClientRect().left,right:e.getBoundingClientRect().right}))));
 await expect(main.getByRole('button',{name:'Изменить',exact:true}).first()).toBeVisible();
 const initial=await edges();
 for(const action of ['Добавить тариф','Изменить','Удалить']){
  await main.getByRole('button',{name:action,exact:true}).first().click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.locator('body')).toHaveAttribute('data-scroll-locked','1');
  await expect.poll(edges).toEqual(initial);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect.poll(edges).toEqual(initial);
 }
 await page.getByRole('link',{name:'Приглашения',exact:true}).click();
 await page.getByText('Подробнее',{exact:true}).click();
 await page.getByRole('button',{name:'Показать ссылку'}).click();
 const dialog=page.getByRole('dialog',{name:'Ссылка приглашения'});
 await expect(dialog.getByText('Ссылка приглашения',{exact:true})).toHaveCount(1);
 await expect(dialog.getByRole('textbox',{name:'Ссылка приглашения'})).toHaveValue(url);
 await expect(dialog.getByRole('button',{name:'Скопировать ссылку'})).toBeVisible();
});
