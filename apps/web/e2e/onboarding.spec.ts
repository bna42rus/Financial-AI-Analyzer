import {test,expect} from '@playwright/test';
import {createServer,type ViteDevServer} from 'vite';
import {fileURLToPath} from 'node:url';
let server:ViteDevServer,base:string;
test.beforeAll(async()=>{server=await createServer({root:fileURLToPath(new URL('..',import.meta.url)),cacheDir:fileURLToPath(new URL('../node_modules/.vite-onboarding-'+process.pid,import.meta.url)),server:{host:'127.0.0.1',port:0},define:{'import.meta.env.VITE_API_ORIGIN':JSON.stringify('http://127.0.0.1:3000')}});await server.listen();base=server.resolvedUrls!.local[0]!;});
test.afterAll(async()=>{await server?.close();});
test('registration verifies six digits before opening the new restricted account',async({page})=>{
 let registered=false;const posts:string[]=[];
 await page.route('http://127.0.0.1:3000/**',async route=>{const req=route.request(),path=new URL(req.url()).pathname;if(req.method()==='POST')posts.push(path);
 const headers={'access-control-allow-origin':new URL(base).origin,'access-control-allow-credentials':'true','access-control-allow-headers':'content-type'};
 if(req.method()==='OPTIONS')return route.fulfill({status:204,headers});
 if(path==='/session')return route.fulfill({status:registered?200:401,headers,json:registered?{name:'Проверка',email:'synthetic@example.test',scope:'restricted',capabilities:['account'],isNew:true,trialAvailable:true}: {code:'AUTH_REQUIRED'}});
 if(path==='/access/signup-start')return route.fulfill({headers,json:{id:'00000000-0000-4000-8000-000000000001',retryAfterSeconds:60}});
 if(path==='/access/signup-complete'){expect(req.postDataJSON().code).toBe('123456');registered=true;return route.fulfill({headers,json:{status:'registered'}});}
 return route.fulfill({headers,json:path==='/access/tariffs'?{tariffs:[]}:path==='/access/legal'?{termsAccepted:true,privacySeen:true,billingChanged:false}:{status:'ok'}});
 });
 await page.goto(base+'#access');await expect(page.getByRole('heading',{name:'Создайте аккаунт'})).toBeVisible();
 await page.locator('[name="email"]').fill('synthetic@example.test');await page.locator('[name="password"]').fill('SyntheticPassword123!');await page.locator('[name="passwordConfirmation"]').fill('SyntheticPassword123!');await page.locator('[name="name"]').fill('Проверка');await page.locator('#signup-consent').check();await page.getByRole('button',{name:'Продолжить',exact:true}).click();
 await expect(page.getByRole('heading',{name:'Подтвердите почту'})).toBeVisible();await expect(page.getByRole('button',{name:'Запросить снова',exact:true})).toBeDisabled();await expect(page.getByText(/Повторный запрос через/)).toBeVisible();const code=page.locator('[name="code"]');await expect(code).toHaveValue('');await expect(code).toHaveAttribute('maxlength','6');expect(posts).not.toContain('/auth/sign-in/email');await code.fill('123456');await page.getByRole('button',{name:'Зарегистрироваться',exact:true}).click();
 await expect(page.getByRole('heading',{name:'Начните пользоваться CashNeuro'})).toBeVisible();await expect(page.getByRole('button',{name:'Попробовать бесплатно',exact:true})).toBeVisible();expect(posts).toContain('/auth/sign-in/email');await page.getByRole('link',{name:'CashNeuro',exact:true}).click();await expect(page.getByRole('heading',{name:'Начните пользоваться CashNeuro'})).toBeVisible();
});
test('demo field values and select triggers use the same shared typography',async({page})=>{
 await page.goto(base+'demo');await expect(page.locator('[data-select-trigger]').first()).toBeVisible();
 const compare=async()=>page.evaluate(()=>{const selectors='input:not([type="checkbox"]):not([type="radio"]),textarea,[data-select-trigger]';return [...document.querySelectorAll<HTMLElement>(selectors)].filter(e=>e.getClientRects().length).map(e=>({tag:e.tagName,size:getComputedStyle(e).fontSize,weight:getComputedStyle(e).fontWeight,line:getComputedStyle(e).lineHeight}));});
 const values=await compare();expect(values.length).toBeGreaterThan(1);expect(new Set(values.map(v=>v.size)).size).toBe(1);expect(new Set(values.map(v=>v.weight))).toEqual(new Set(['400']));
 await page.locator('[data-select-trigger]').first().click();const search=page.getByRole('searchbox').last();if(await search.isVisible()){const sizes=await compare();expect(new Set(sizes.map(v=>v.size)).size).toBe(1);}
});
test('unknown addresses, offline mode and failed page loading show recovery screens',async({page,context})=>{
 await page.goto(base+'missing-page');await expect(page.getByRole('heading',{name:'Страница не найдена'})).toBeVisible();await expect(page.getByRole('link',{name:'На главную',exact:true})).toHaveAttribute('href','/');
 await context.setOffline(true);await expect(page.getByRole('heading',{name:'Нет соединения с интернетом'})).toBeVisible();await expect(page.getByRole('button',{name:'Повторить',exact:true})).toBeVisible();await context.setOffline(false);await expect(page.getByRole('heading',{name:'Страница не найдена'})).toBeVisible();
 await page.evaluate(()=>window.dispatchEvent(new Event('vite:preloadError',{cancelable:true})));await expect(page.getByRole('heading',{name:'Сервис временно недоступен'})).toBeVisible();
});
