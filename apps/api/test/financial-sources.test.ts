import {test,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {readFinancialSources,resetFinancialSourceCacheForTests} from '../src/financial-sources.ts';
import {parseFinancialSourceRequest} from '../../../packages/analyzer/src/financial-sources.ts';
const now=()=>new Date('2026-11-17T12:00:00Z');
beforeEach(()=>resetFinancialSourceCacheForTests());
test('CBR key rate reads only a fixed SOAP endpoint, takes the latest nonfuture official record',async()=>{
 let url='',sent:any;const result=await readFinancialSources({kind:'key_rate'},'2026-11-17',async(u,o)=>{url=String(u);sent=o;return new Response('<KeyRateXMLResult><KeyRate><KR><DT>2026-11-16T00:00:00</DT><Rate>14.25</Rate></KR><KR><DT>2026-11-18T00:00:00</DT><Rate>99</Rate></KR></KeyRate></KeyRateXMLResult>');},now);
 assert.equal(url,'https://www.cbr.ru/DailyInfoWebServ/DailyInfo.asmx');assert.equal(sent.method,'POST');assert.equal(sent.redirect,'error');assert.match(sent.body,/<fromDate>/);assert.equal(result.sources[0]!.facts[0]!.value,'14,25% годовых');assert.equal(result.sources[0]!.publishedDate,'2026-11-16');assert.match(result.sources[0]!.url,/cbr.ru/);
});
test('currency conversion preserves decimals and nominal, public cache never includes customer amount',async()=>{
 let calls=0;const fetcher:typeof fetch=async(u)=>{calls++;assert.equal(String(u).includes('123.45'),false);return new Response('<ValCurs Date="17.11.2026"><Valute><CharCode>JPY</CharCode><Nominal>100</Nominal><Value>53,4567</Value></Valute></ValCurs>');};
 const first=await readFinancialSources({kind:'currency',currency:'JPY',amount:'123.45'},'2026-11-17',fetcher,now),second=await readFinancialSources({kind:'currency',currency:'JPY',amount:'100'},'2026-11-17',fetcher,now);assert.equal(first.sources[0]!.facts.at(-1)!.minor,'6599');assert.equal(second.sources[0]!.facts.at(-1)!.minor,'5346');assert.equal(calls,1);
});
test('source unavailable, malformed XML, DTD, unknown currency and future dates never produce guessed facts',async()=>{
 await assert.rejects(readFinancialSources({kind:'key_rate',date:'2026-12-01'},'2026-11-17',async()=>{throw Error('no fetch');},now),/FUTURE_DATE/);
 await assert.rejects(readFinancialSources({kind:'key_rate'},'2026-11-17',async()=>new Response('bad XML'),now),/FORMAT_CHANGED/);
 resetFinancialSourceCacheForTests();await assert.rejects(readFinancialSources({kind:'currency',currency:'USD'},'2026-11-17',async()=>new Response('<!DOCTYPE doc>'),now),/FORMAT_CHANGED/);
 resetFinancialSourceCacheForTests();await assert.rejects(readFinancialSources({kind:'currency',currency:'USD'},'2026-11-17',async()=>new Response('<ValCurs Date="17.11.2026"></ValCurs>'),now),/CURRENCY_UNKNOWN/);
});
test('closed source registry forbids arbitrary URLs, personal searches, unsupported dates and oversized pages',async()=>{
 for(const q of [{kind:'key_rate',url:'http://127.0.0.1'},{kind:'currency',currency:'USD?x=secret'},{kind:'official_guidance',topic:'any query'},{kind:'key_rate',date:'2026-02-30'}])assert.throws(()=>parseFinancialSourceRequest(q));
 await assert.rejects(readFinancialSources({kind:'key_rate'},'2026-11-17',async()=>new Response('a'.repeat(512001)),now),/TOO_LARGE/);
});
test('official guidance verifies a fixed source but does not invent legal applicability or numerical tax rules',async()=>{
 const r=await readFinancialSources({kind:'official_guidance',topic:'tax_deductions'},'2026-11-17',async(u)=>{assert.match(String(u),/^https:\/\/www.nalog.gov.ru\//);return new Response('<html><title>Налоговые вычеты</title><script>bad</script></html>');},now);assert.equal(r.sources[0]!.facts[0]!.value,'Налоговые вычеты');assert.match(r.sources[0]!.notice!,/не подтверждает применимость/);
});
