import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import type {ChildProcess} from 'node:child_process';
import {randomBytes,createHmac} from 'node:crypto';
import {chromium,expect} from '@playwright/test';
import {postgresFixture} from './postgres.ts';
import {createServer} from '../src/server.ts';
import {hashPassword,token,envelope} from '../src/crypto.ts';
import type {Config} from '../src/types.ts';

let pg:Awaited<ReturnType<typeof postgresFixture>>,finance:Awaited<ReturnType<typeof createServer>>,control:Awaited<ReturnType<typeof createServer>>;
let fc:Config,cc:Config;const children:ChildProcess[]=[],pw='Synthetic browser password 123!';
const web='http://127.0.0.1:5175',admin='http://127.0.0.1:5176';
async function ready(url:string){for(let i=0;i<100;i++){try{if((await fetch(url)).ok)return;}catch{}await new Promise(resolve=>setTimeout(resolve,100));}throw new Error('Synthetic UI did not start');}
async function mail(kind:string,config=fc){const row=(await pg.owner.query('SELECT sealed_payload FROM access.outbox WHERE kind=$1 ORDER BY created_at DESC LIMIT 1',[kind])).rows[0];assert.ok(row);return JSON.parse(envelope(config.wrappingKey).open(row.sealed_payload));}
function otp(secret:string){const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';let bits='';for(const c of secret)bits+=alphabet.indexOf(c).toString(2).padStart(5,'0');const bytes=Buffer.from((bits.match(/.{8}/g)??[]).map(v=>parseInt(v,2))),counter=Buffer.alloc(8);counter.writeBigUInt64BE(BigInt(Math.floor(Date.now()/30000)));const h=createHmac('sha1',bytes).update(counter).digest(),offset=h.at(-1)!&15;return ((h.readUInt32BE(offset)&0x7fffffff)%1000000).toString().padStart(6,'0');}
before(async()=>{
  pg=await postgresFixture();
  fc={profile:'finance',pool:pg.finance,baseURL:'http://127.0.0.1:3000',origin:web,authSecret:token(),wrappingKey:randomBytes(32),environment:'test'};
  cc={profile:'control',pool:pg.control,baseURL:'http://127.0.0.1:3001',origin:admin,authSecret:token(),wrappingKey:randomBytes(32),environment:'test'};
  finance=await createServer(fc);control=await createServer(cc);await finance.app.listen(3000,'127.0.0.1');await control.app.listen(3001,'127.0.0.1');
  const root=new URL('../../../',import.meta.url);
  for(const [pkg,port,config] of [['@finance/web',5175,fc],['@finance/admin',5176,cc]] as const){const child=spawn('pnpm',['--filter',pkg,'dev','--port',String(port),'--strictPort'],{cwd:root,env:{...process.env,VITE_API_ORIGIN:config.baseURL,VITE_FINANCE_ORIGIN:web},stdio:'ignore'});children.push(child);}
  await Promise.all([ready(web),ready(admin)]);
});
after(async()=>{for(const c of children)c.kill('SIGTERM');await finance?.close();await control?.close();await pg?.close();});
for(const mobile of [false,true])test(`real HTTP/PostgreSQL application → TOTP review → independent email proof → registration (${mobile?'mobile':'desktop'})`,{timeout:60000},async()=>{
  await pg.owner.query('TRUNCATE access.request,access.tariff,commerce.action,identity.auth_user,control.auth_user,access.outbox,identity.outbox,control.outbox,identity.rate_limit,control.rate_limit CASCADE');
  const tariff={id:'development-month',name:'Тестовый месяц',duration:{kind:'calendar_months',count:1},priceMinor:'119000',aiQuota:150,active:true,publicVisible:true,availableForNew:true};
  await pg.owner.query('INSERT INTO access.tariff(id,snapshot) VALUES($1,$2)',[tariff.id,tariff]);
  await pg.owner.query("INSERT INTO control.auth_user(id,name,email,email_verified,created_at,updated_at) VALUES('owner','Synthetic owner','owner@example.test',true,now(),now())");
  await pg.owner.query("INSERT INTO control.auth_account(id,account_id,provider_id,user_id,password,created_at,updated_at) VALUES('owner-account','owner','credential','owner',$1,now(),now())",[await hashPassword(pw)]);
  await pg.owner.query("INSERT INTO control.security_state(user_id,bootstrap_pending) VALUES('owner',true)");
  const browser=await chromium.launch({...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH}:{}),args:['--disable-dev-shm-usage']});
  const context=await browser.newContext({viewport:mobile?{width:390,height:844}:{width:1440,height:1000},locale:'ru-RU',timezoneId:'Europe/Moscow'}),visitor=await context.newPage(),owner=await context.newPage();
  try{
    await visitor.goto(web);await visitor.getByLabel('Имя',{exact:true}).fill('Synthetic visitor');await visitor.getByLabel('Почта',{exact:true}).fill('visitor@example.test');await visitor.getByRole('button',{name:'Создать тестовую заявку'}).click();await expect(visitor.getByRole('status').filter({hasText:'письмо'})).toBeVisible();
    const verification=await mail('application_verification');await visitor.goto(web+'/#verify?token='+verification.token);await visitor.getByRole('button',{name:'Подтвердить почту'}).click();await expect(visitor.getByText('Почта подтверждена.',{exact:true})).toBeVisible();assert.equal(visitor.url().includes(verification.token),false);
    await visitor.getByLabel('Имя отправителя').fill('Synthetic sender');await visitor.getByLabel('Банк отправителя').fill('Synthetic bank');await visitor.getByRole('button',{name:'Отметить тестовую оплату'}).click();await expect(visitor.getByText('Отметка оплаты отправлена на ручную проверку.')).toBeVisible();
    await owner.goto(admin);await owner.getByLabel('Почта',{exact:true}).fill('owner@example.test');await owner.getByLabel('Пароль',{exact:true}).fill(pw);await owner.getByRole('button',{name:'Продолжить'}).click();await expect(owner.getByRole('heading',{name:'Настройка authenticator'})).toBeVisible();
    await owner.getByLabel('Текущий пароль').fill(pw);await owner.getByRole('button',{name:'Начать настройку'}).click();await expect(owner.getByLabel('Ключ для ручной настройки')).toBeVisible();const secret=await owner.getByLabel('Ключ для ручной настройки').inputValue();await owner.getByLabel('Код authenticator').fill(otp(secret));await owner.getByRole('button',{name:'Продолжить'}).click();await expect(owner.getByRole('heading',{name:'Сохраните резервные коды'})).toBeVisible();await owner.getByRole('button',{name:'Коды сохранены'}).click();
    await owner.getByRole('button',{name:/Synthetic visitor/}).click();await owner.getByRole('button',{name:'Показать последствия'}).click();await expect(owner.getByRole('heading',{name:'Последствия решения'})).toBeVisible();assert.equal((await pg.owner.query('SELECT * FROM commerce.purchase')).rowCount,0);
    await owner.getByRole('button',{name:'Подтвердить решение'}).click();await expect(owner.getByText('Оплачено — ожидает регистрации. Срок доступа ещё не начался.',{exact:true})).toBeVisible();
    await owner.getByRole('button',{name:'Приглашения',exact:true}).click();await owner.getByRole('button',{name:'Показать ссылку'}).click();const link=await owner.getByLabel('Ссылка приглашения').inputValue();const invitation=await mail('invitation',cc);assert.ok(link.includes(invitation.token));
    // A page without the application cookie can open the copied invite, but still needs an independent email proof.
    const independent=await browser.newContext({viewport:mobile?{width:390,height:844}:{width:1440,height:1000},timezoneId:'Europe/Moscow'}),registration=await independent.newPage();
    try{
      await registration.goto(link);await expect(registration.getByRole('heading',{name:'Регистрация по приглашению'})).toBeVisible();assert.equal(registration.url().includes(invitation.token),false);
      await registration.getByRole('button',{name:'Запросить подтверждение почты'}).click();await expect(registration.getByText('Письмо с отдельным подтверждением поставлено в очередь.')).toBeVisible();const proof=await mail('registration_verification');assert.equal(proof.email,'visitor@example.test');
      await registration.getByLabel('Код подтверждения из отдельного письма').fill(proof.proofToken);await registration.getByLabel('Имя',{exact:true}).fill('Registered example');await registration.getByLabel('Новый пароль').fill(pw);await registration.getByRole('button',{name:'Зарегистрироваться'}).click();await expect(registration.getByRole('heading',{name:'Вход в аккаунт'})).toBeVisible();
      await registration.getByLabel('Почта',{exact:true}).fill('visitor@example.test');await registration.getByLabel('Пароль',{exact:true}).fill(pw);await registration.getByRole('button',{name:'Продолжить'}).click();await expect(registration.getByText('Доступ активен.',{exact:true})).toBeVisible();
      await owner.getByRole('button',{name:'Обновить данные'}).click();await expect(owner.getByText(/Использовано · создано/)).toBeVisible();
      const purchase=(await pg.owner.query('SELECT * FROM commerce.purchase')).rows[0];assert.equal(purchase.state,'active');assert.equal((await pg.owner.query('SELECT * FROM identity.auth_session')).rowCount,1);
      for(const page of [visitor,owner,registration])assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth),false,'No horizontal mobile overflow');
      assert.deepEqual(await registration.evaluate(()=>Object.keys(localStorage)),[],'No identity/token storage in localStorage');
    }finally{await independent.close();}
  }finally{await context.close();await browser.close();}
});
