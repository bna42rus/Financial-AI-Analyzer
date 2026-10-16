import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createYandexTransport, yandexSettings, yandexEndpoint, YandexFailure } from '../src/yandex-transport.ts';
import { modelInput, parseGate, parseModelPlan, gateSchema, gatePrompt } from '../../../packages/analyzer/src/yandex-contract.ts';
const settings = { realm: 'staging/finance' as const, apiKey: 'synthetic-api-key-for-tests-only', modelUri: 'gpt://b1g00000000000000000/yandexgpt-5.1', allowedEmails: ['owner@example.test'], maxDailyCalls: 5, maxTokens: 512, timeoutMs: 1000 };
const response = (value: unknown, change: Record<string, unknown> = {}) => new Response(JSON.stringify({ result: { alternatives: [{ message: { role: 'assistant', text: JSON.stringify(value) }, status: 'ALTERNATIVE_STATUS_FINAL' }], usage: { inputTextTokens: '20', completionTokens: '10', totalTokens: '30' }, modelVersion: 'synthetic-1', ...change } }), { headers: { 'content-type': 'application/json' } });
test('configuration pins realm, model URI, recipient allowlist and bounded trial calls', () => {
  assert.equal(yandexSettings(settings).modelUri, settings.modelUri);
  for (const change of [{ realm: 'production/finance' }, { realm: 'staging/control' }, { endpoint: 'https://other.example.test' }, { apiKey: 'secret\r\nHeader: injection' }, { modelUri: settings.modelUri + '/latest' }, { modelUri: 'gpt://b1g00000000000000000/retired-model' }, { allowedEmails: [] }, { allowedEmails: Array(6).fill('owner@example.test') }, { maxDailyCalls: 31 }, { maxTokens: 2049 }, { timeoutMs: 10001 }]) assert.throws(() => yandexSettings({ ...settings, ...change }), /AI_CONFIGURATION_DENIED/);
});
test('native REST uses fixed HTTPS host, private authorization, disabled logging and structured JSON without tool calls', async () => {
  let calls = 0;
  const client = createYandexTransport(settings, (async (url, options) => {
    calls++; assert.equal(url, yandexEndpoint); assert.equal(options?.redirect, 'error');
    const headers = new Headers(options?.headers); assert.equal(headers.get('x-data-logging-enabled'), 'false'); assert.equal(headers.get('authorization'), 'Api-Key ' + settings.apiKey);
    const body = JSON.parse(String(options?.body)); assert.equal(body.completionOptions.maxTokens, '512'); assert.equal(body.completionOptions.stream, false); assert.deepEqual(body.jsonSchema.schema, gateSchema);
    assert.ok(!('tools' in body)); assert.ok(!String(options?.body).includes(settings.apiKey));
    return response({ relevance: 'financial', followUp: false });
  }) as typeof fetch);
  const result = await client.complete(gatePrompt, { question: 'В какую сумму обошлись покупки?', hasFinancialContext: false }, gateSchema);
  assert.equal(calls, 1); assert.equal(result.inputTokens, 20); assert.equal(result.outputTokens, 10); assert.equal(result.modelVersion, 'synthetic-1');
  assert.equal(client.allowed('OWNER@example.test'), true); assert.equal(client.allowed('other@example.test'), false);
});
test('transport never retries redirects, provider refusals, timeouts or ambiguous network failures and reflects no body/secret', async () => {
  for (const status of [302, 401, 403, 429, 500]) {
    let calls = 0; const client = createYandexTransport(settings, (async () => { calls++; return new Response('reflected ' + settings.apiKey, { status }); }) as typeof fetch);
    await assert.rejects(client.complete(gatePrompt, {}, gateSchema), (e: unknown) => e instanceof YandexFailure && !e.message.includes(settings.apiKey)); assert.equal(calls, 1);
  }
  let calls = 0; const client = createYandexTransport(settings, (async () => { calls++; throw new Error(settings.apiKey); }) as typeof fetch);
  await assert.rejects(client.complete(gatePrompt, {}, gateSchema), /AI_DELIVERY_UNKNOWN/); assert.equal(calls, 1);
});
test('completion accepts only final JSON with bounded, consistent integer usage and a model version', async () => {
  for (const change of [ { usage: { inputTextTokens: '20', completionTokens: '10', totalTokens: '31' } }, { usage: { inputTextTokens: '2.0', completionTokens: '10', totalTokens: '12' } }, { modelVersion: 'private\ntext' }, { alternatives: [{ message: { role: 'assistant', text: '{}' }, status: 'ALTERNATIVE_STATUS_TRUNCATED_FINAL' }] }, { alternatives: [{ message: { role: 'assistant', text: '{not json' }, status: 'ALTERNATIVE_STATUS_FINAL' }] } ]) {
    const client = createYandexTransport(settings, (async () => response({}, change)) as typeof fetch);
    await assert.rejects(client.complete(gatePrompt, {}, gateSchema), /AI_RESPONSE_INVALID/);
  }
  const client = createYandexTransport(settings, (async () => new Response('x'.repeat(70000))) as typeof fetch);
  await assert.rejects(client.complete(gatePrompt, {}, gateSchema), /AI_DELIVERY_UNKNOWN/);
});
test('relevance gate and read plans are closed and retain global scope while explicit periods override dates', () => {
  assert.deepEqual(parseGate({ relevance: 'adjacent', followUp: false }), { relevance: 'adjacent', followUp: false });
  assert.throws(() => parseGate({ relevance: 'financial', followUp: false, sql: 'SELECT 1' }));
  const accountId = randomUUID(), plan = { status: 'query', query: { name: 'query_finances', metric: 'expenses', grouping: 'category', comparison: 'none', filter: { from: '2026-09-01', through: '2026-09-30' } } };
  const parsed = parseModelPlan(plan, { accountIds: [accountId], from: '2026-10-01', through: '2026-10-31' });
  assert.deepEqual(parsed.query?.filter, { accountIds: [accountId], from: '2026-09-01', through: '2026-09-30' });
  for (const query of [{ ...plan.query, name: 'sql' }, { ...plan.query, filter: { operationIds: [randomUUID()] } }, { ...plan.query, filter: { search: 'raw dump' } }, { ...plan.query, filter: { from: '2026-02-30' } }, { ...plan.query, filter: { amountFrom: 10.5 } }]) assert.throws(() => parseModelPlan({ ...plan, query }, {}));
  assert.deepEqual(parseModelPlan({ status: 'unsupported', query: null }, {}), { status: 'unsupported', query: null });
});
test('outbound context contains only the question and period, never catalogs, reference IDs or private filters', () => {
  const id = randomUUID();
  const input = modelInput('Покупки за сентябрь?', { operationIds: [id], accountIds: [id], categoryIds: [id], merchant: 'Private merchant', comment: 'Private saved comment', search: 'Private history search' }, '2026-10-13');
  const wire = JSON.stringify(input); assert.ok(!wire.includes('Private saved comment')); assert.ok(!wire.includes('Private history search')); assert.ok(!wire.includes('operationIds'));
  assert.ok(!wire.includes(id)); assert.ok(!wire.includes('Private merchant')); assert.ok(!('catalog' in input));
  for (const value of ['Карта 4111 1111 1111 1111', 'Почта owner@example.test', 'Паспорт 4510 123456']) assert.throws(() => modelInput(value, {}, '2026-10-13'));
});

test('named references resolve only uniquely owned objects; ambiguity and unknown names clarify without widening scope', () => {
  const account = randomUUID(), category = randomUUID(), leaf = randomUUID(), other = randomUUID();
  const catalog = { accounts: [{id:account,name:'Моя карта'}], categories: [{id:category,name:'Мои поездки',parentId:null,role:'expense'},{id:leaf,name:'Такси',parentId:category,role:'expense'}], counterparties: [] };
  const plan = (filter:unknown) => ({status:'query',query:{name:'query_finances',metric:'expenses',grouping:'category',comparison:'none',filter}});
  const base = {from:'2026-09-01',through:'2026-09-30',operationIds:[other],includeExcluded:true};
  assert.deepEqual(parseModelPlan(plan({accountNames:[' моя КАРТА '],categoryNames:['Мои поездки'],subcategoryNames:['Мои поездки / Такси']}),base,catalog).query?.filter,
    {...base,accountIds:[account],categoryIds:[category],subcategoryIds:[leaf]});
  assert.equal(parseModelPlan(plan({categoryNames:['Неизвестная категория']}),base,catalog).status,'clarification');
  const ambiguous = {...catalog,accounts:[...catalog.accounts,{id:other,name:'Моя карта'}]};
  assert.equal(parseModelPlan(plan({accountNames:['Моя карта']}),base,ambiguous).status,'clarification');
  for (const filter of [{accountIds:[account]},{categoryNames:[]},{categoryNames:['Мои поездки','МОИ ПОЕЗДКИ']},{categoryNames:[null]},{amountFrom:1.5},{attention:null}]) assert.throws(() => parseModelPlan(plan(filter),base,catalog));
});

test('planner budget stops oversized input before dispatch and selected scope adds no catalog overhead', async () => {
  const input = modelInput('Разложи расходы по категориям', {from:'2026-09-01',through:'2026-09-30',categoryIds:Array.from({length:100},()=>randomUUID())}, '2026-10-13');
  assert.ok(Buffer.byteLength(JSON.stringify(input))<512);
  let calls=0;
  const client=createYandexTransport(settings,(async()=>{calls++;return response({});}) as typeof fetch);
  await assert.rejects(client.complete(gatePrompt,{question:'x'.repeat(8193)},gateSchema),/AI_CONTEXT_LIMIT/);
  assert.equal(calls,0);
});

test('explicit category replaces stale subcategory; explicit leaf resolves its parent locally',()=>{
  const root=randomUUID(),other=randomUUID(),leaf=randomUUID();
  const catalog={accounts:[],counterparties:[],categories:[{id:root,name:'Поездки',parentId:null,role:'expense'},{id:other,name:'Продукты',parentId:null,role:'expense'},{id:leaf,name:'Такси',parentId:root,role:'expense'}]};
  const plan=(filter:unknown)=>({status:'query',query:{name:'query_finances',metric:'expenses',grouping:'category',comparison:'none',filter}});
  const selected=parseModelPlan(plan({subcategoryNames:['Такси']}),{categoryIds:[other]},catalog).query!.filter;assert.deepEqual(selected.categoryIds,[root]);assert.deepEqual(selected.subcategoryIds,[leaf]);
  const changed=parseModelPlan(plan({categoryNames:['Продукты']}),{categoryIds:[root],subcategoryIds:[leaf]},catalog).query!.filter;assert.deepEqual(changed.categoryIds,[other]);assert.equal(changed.subcategoryIds,undefined);
});

test('bad JSON and truncated text retain reported usage without retaining provider content', async () => {
  for (const change of [{ alternatives: [{message:{role:'assistant',text:'private-invalid-json'},status:'ALTERNATIVE_STATUS_FINAL'}] }, { alternatives: [{message:{role:'assistant',text:'{}'},status:'ALTERNATIVE_STATUS_TRUNCATED_FINAL'}] }]) {
    const client=createYandexTransport(settings,(async()=>response({},change)) as typeof fetch);
    await assert.rejects(client.complete(gatePrompt,{},gateSchema),(e:unknown)=>{
      assert.ok(e instanceof YandexFailure); assert.equal(e.code,'AI_RESPONSE_INVALID');
      assert.deepEqual(e.usage,{inputTokens:20,outputTokens:10,modelVersion:'synthetic-1'});
      assert.ok(!JSON.stringify(e).includes('private-invalid-json')); return true;
    });
  }
});
test('missing usage stays unknown instead of becoming a zero-cost receipt', async () => {
  const client=createYandexTransport(settings,(async()=>response({}, {usage:null})) as typeof fetch);
  await assert.rejects(client.complete(gatePrompt,{},gateSchema),(e:unknown)=>e instanceof YandexFailure&&e.usage===undefined);
});
const tokenized=()=>new Response(JSON.stringify({tokens:Array.from({length:20},(_,i)=>({id:String(i),text:'synthetic',special:false})),modelVersion:'synthetic-1'}));
test('tokenizer sees identical schema/body; durable reservation precedes the only paid dispatch', async () => {
  let reserved=false,wire='',count=0;
  const client=createYandexTransport(settings,(async(url,opts)=>{
    count++;
    if(String(url).endsWith('/tokenizeCompletion')){wire=String(opts?.body);assert.equal(reserved,false);return tokenized();}
    assert.equal(reserved,true);assert.equal(String(opts?.body),wire);assert.equal(url,yandexEndpoint);return response({});
  }) as typeof fetch);
  await client.complete(gatePrompt,{},gateSchema,async bound=>{assert.deepEqual(bound,{inputTokens:20,outputTokens:512,modelVersion:'synthetic-1'});reserved=true;});
  assert.equal(count,2);
});
test('failed tokenization or denied reservation causes no paid dispatch', async () => {
  for(const mode of ['tokenizer-fails','reserve-denied']){
    let paid=0;
    const client=createYandexTransport(settings,(async url=>{
      if(String(url).endsWith('/tokenizeCompletion'))return mode==='tokenizer-fails'?new Response('{}',{status:500}):tokenized();
      paid++;return response({});
    }) as typeof fetch);
    await assert.rejects(client.complete(gatePrompt,{},gateSchema,async()=>{throw new YandexFailure('AI_USER_COST_EXHAUSTED',false,undefined,undefined,false);}));
    assert.equal(paid,0);
  }
});
