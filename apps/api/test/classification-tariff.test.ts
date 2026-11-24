import {test} from 'node:test';
import assert from 'node:assert/strict';
import {classificationTariffPrice,classificationTariffVerifier,isClassificationTariffVerification} from '../src/classification-tariff.ts';
import {tokenCost} from '../../../packages/analyzer/src/cost.ts';

const text=(input='15,86',output='61,00')=>`Evolution Foundation Models
Цена с НДС*, руб. НДС* (22%), руб.
193. БЯМ (партнерская модель) OpenAI: gpt-oss-120b входные токены млн шт месяц 6,27786885 1,38113115 7,659
271. БЯМ gpt-oss-120b входные токены млн шт месяц ${input==='15,86'?'13,00':'20,00'} ${input==='15,86'?'2,86':'4,40'} ${input}
272. БЯМ gpt-oss-120b генерируемые токены млн шт месяц ${output==='61,00'?'50,00':'100,00'} ${output==='61,00'?'11,00':'22,00'} ${output}
273. БЯМ другая-модель входные токены млн шт месяц 1,00 0,22 1,22`;

test('model price is independent of document version, row number, unrelated and partner prices',()=>{
 const normal=classificationTariffPrice(text(),'a'.repeat(64));
 assert.equal(normal.inputRubPerMillion,'15.86');assert.equal(normal.outputRubPerMillion,'61');
 const next=classificationTariffPrice(text().replace('271.','901.').replace('272.','902.').replace('7,659','999,00'),'b'.repeat(64));
 assert.equal(next.inputRubPerMillion,normal.inputRubPerMillion);assert.equal(next.outputRubPerMillion,normal.outputRubPerMillion);
 assert.notEqual(next.version,normal.version);
});

test('new supported token rates are exact and future reservations change without repricing an earlier quote',()=>{
 const old=classificationTariffPrice(text(),'a'.repeat(64));
 const current=classificationTariffPrice(text('24,40','122,00'),'b'.repeat(64));
 assert.equal(tokenCost(current,1_000_000,1_000_000),146_400_000_000n);
 assert.equal(tokenCost(old,1_000_000,1_000_000),76_860_000_000n);
 assert.ok(Object.isFrozen(current));
});

test('ambiguous prices, wrong units/currency, absent output and invalid totals fail closed',()=>{
 for(const broken of [text()+'\n271. БЯМ gpt-oss-120b входные токены млн шт месяц 13,00 2,86 15,86',
  text().replace('272. БЯМ gpt-oss-120b','272. БЯМ другая-модель'),text().replaceAll('млн шт','тыс шт'),
  text().replaceAll('руб.','USD'),text().replace('13,00 2,86 15,86','13,00 2,86 14,00')]){
  assert.throws(()=>classificationTariffPrice(broken,'a'.repeat(64)));
 }
});

test('changed PDF bytes with unchanged model rows are verified; a 304 reuses only validated rates',async()=>{
 const requests:RequestInit[]=[];let reads=0,at=new Date('2026-11-24T00:00:00Z');
 const verifier=classificationTariffVerifier(async(url,options)=>{
  assert.equal(String(url),'https://cdn.cloud.ru/docs/legal/tariffs/evolution/current-version/foundation-models.pdf');
  assert.equal(options?.method,'GET');assert.equal(options?.redirect,'error');requests.push(options!);
  assert.equal(new Headers(options?.headers).get('authorization'),null);
  return requests.length===1?new Response('%PDF-synthetic-v1',{headers:{etag:'"one"'}}):new Response(null,{status:304});
 },()=>at,async()=>{reads++;return text();});
 const first=await verifier();assert.ok(isClassificationTariffVerification(first));
 at=new Date('2026-11-24T00:01:00Z');const second=await verifier();
 assert.equal(second.price?.inputRubPerMillion,'15.86');assert.equal(second.checkedAt,at.toISOString());
 assert.equal(new Headers(requests[1]!.headers).get('if-none-match'),'"one"');assert.equal(reads,1);
 assert.ok(!isClassificationTariffVerification({...second}));
});

test('a new price is fetched and validated after ETag change, while invalid changes cannot use stale cached prices',async()=>{
 let calls=0,parsed=0;
 const verifier=classificationTariffVerifier(async()=>new Response('%PDF-synthetic-'+(++calls),{headers:{etag:'"'+calls+'"'}}),
  ()=>new Date('2026-11-24T00:00:00Z'),async()=>++parsed===1?text():parsed===2?text('24,40','122,00'):'invalid layout');
 assert.equal((await verifier()).price?.inputRubPerMillion,'15.86');
 assert.equal((await verifier()).price?.inputRubPerMillion,'24.4');
 await assert.rejects(verifier(),/TARIFF_DOCUMENT_INVALID/);
});
