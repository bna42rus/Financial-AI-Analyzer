import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createCloudAssistantModel} from '../src/assistant-transport.ts';
import {pilotModelCall} from '../src/analyzer-next-pilot-call.ts';
import type {AssistantJournal,AssistantModel,CompletionInput} from '../src/assistant-workflow.ts';
import {pilotSchema,pilotPrompt,pilotCases,pilotPreparationMatches} from '../../../packages/analyzer/src/next/pilot.ts';
import {assistantVersion} from '../../../packages/analyzer/src/assistant-plan.ts';
import {intentSchema,intentVersion} from '../../../packages/analyzer/src/next/intent.ts';
import {prepareTask,emptyState} from '../../../packages/analyzer/src/next/tasks.ts';
import {scope,catalog,account,id} from '../../../packages/analyzer/test/fixtures/next-finances.ts';
import {createPilotSuite,pilotIntentDiagnostic} from '../src/analyzer-next-pilot-suite.ts';
const usage={modelVersion:'synthetic-pilot-model',inputTokens:100,outputTokens:50};
const input:CompletionInput={phase:'understand',prompt:'Synthetic prompt',input:{question:'Синтетический кредит'},schema:{type:'object'}};
function harness(){
 const events:string[]=[],journal:AssistantJournal={receipt:{fingerprint:'f'.repeat(64),calls:[]},async reserve(){events.push('reserve');},async settle(_index,value){events.push(value?'settle':'hold');},async persist(){events.push('persist');}};
 const model:AssistantModel={bound:{modelVersion:usage.modelVersion,inputTokens:1000,outputTokens:500},async complete(_input,before){await before();events.push('http');return {value:{synthetic:true},usage};}};return {journal,model,events};
}
test('paid adapter reserves and persists before dispatch, settles reported usage, then replays without another call',async()=>{
 const h=harness();const first=await pilotModelCall(h.model,h.journal,input);assert.equal(first.replayed,false);assert.deepEqual(h.events,['reserve','persist','http','settle','persist']);
 h.events.length=0;const second=await pilotModelCall(h.model,h.journal,input);assert.equal(second.replayed,true);assert.deepEqual(h.events,[]);assert.deepEqual(second.value,first.value);
 await assert.rejects(pilotModelCall(h.model,h.journal,{...input,prompt:'changed'}),/ASSISTANT_REQUEST_CHANGED/);
});
test('unknown delivery retains its reservation and cannot retry on rerun',async()=>{
 const h=harness();h.model.complete=async(_input,before)=>{await before();throw Error('private transport detail');};
 await assert.rejects(pilotModelCall(h.model,h.journal,input),/ASSISTANT_DELIVERY_UNKNOWN/);assert.equal(h.journal.receipt.calls[0]?.state,'unknown');assert.ok(h.events.includes('hold'));h.events.length=0;
 await assert.rejects(pilotModelCall(h.model,h.journal,input),/ASSISTANT_DELIVERY_UNKNOWN/);assert.deepEqual(h.events,[]);
});
test('replay-only permits a saved response but never calls the model or reserves money for a missing response',async()=>{
 const missing=harness();let calls=0;missing.model.complete=async()=>{calls++;throw Error('must not call');};
 await assert.rejects(pilotModelCall(missing.model,missing.journal,input,'replay_only'),/PILOT_REPLAY_MISSING/);assert.equal(calls,0);assert.deepEqual(missing.events,[]);assert.deepEqual(missing.journal.receipt.calls,[]);
 const saved=harness();await pilotModelCall(saved.model,saved.journal,input);saved.events.length=0;saved.model.complete=missing.model.complete;
 assert.equal((await pilotModelCall(saved.model,saved.journal,input,'replay_only')).replayed,true);assert.equal(calls,0);assert.deepEqual(saved.events,[]);
 saved.journal.receipt.calls[0]!.state='unknown';await assert.rejects(pilotModelCall(saved.model,saved.journal,input,'replay_only'),/ASSISTANT_DELIVERY_UNKNOWN/);assert.equal(calls,0);
});
test('invalid JSON with known usage is billed once and marked failed instead of releasing the hold for free',async()=>{
 const h=harness();h.model.complete=async(_input,before)=>{await before();throw Object.assign(Error('private response text'),{usage,responsePhase:'JSON'});};
 await assert.rejects(pilotModelCall(h.model,h.journal,input));assert.equal(h.journal.receipt.calls[0]?.state,'failed');assert.ok(h.events.includes('settle'));assert.ok(!h.events.includes('hold'));h.events.length=0;
 await assert.rejects(pilotModelCall(h.model,h.journal,input));assert.deepEqual(h.events,[]);
});
test('reservation denial prevents HTTP; changed provider usage is settled before rejection',async()=>{
 const h=harness();h.journal.reserve=async()=>{throw Error('PILOT_RUN_COST_LIMIT');};await assert.rejects(pilotModelCall(h.model,h.journal,input),/PILOT_RUN_COST_LIMIT/);assert.ok(!h.events.includes('http'));
 const changed=harness();changed.model.complete=async(_input,before)=>{await before();return {value:{},usage:{...usage,outputTokens:501}};};
 await assert.rejects(pilotModelCall(changed.model,changed.journal,input),/ASSISTANT_PROVIDER_CHANGED/);assert.equal(changed.journal.receipt.calls[0]?.state,'failed');assert.ok(changed.events.includes('settle'));
});
test('pilot schema contains only four tool families and loan calculation; source contract stays unchanged',()=>{
 const variants=(pilotSchema.anyOf[0]!.properties.intent as any).anyOf;
 assert.deepEqual(variants.map((s:any)=>s.properties.action.enum[0]),['read','calculate','compare','explain']);
 const calculators=variants.find((s:any)=>s.properties.action.enum[0]==='calculate').properties.parameters.anyOf;assert.equal(calculators.length,1);assert.equal(calculators[0].properties.calculator.enum[0],'loan');
 assert.ok((intentSchema as any).anyOf.some((s:any)=>s.properties.action.enum[0]==='propose'));assert.equal(pilotCases.length,8);assert.ok(!pilotPrompt.includes('300000'));assert.ok(!pilotPrompt.includes('16800'));
});
test('semantic oracle accepts equivalent money formats but rejects invented prepayments and wrong terms',()=>{
 const env={scope,requestId:id(700),question:'300000.00 19,00% 36 месяцев',date:'2026-11-25',global:{revision:0,filter:{accountIds:[account]},touched:{}},dataRevision:'synthetic/1',accessRevision:'synthetic/1',catalog};
 const edits=[{field:'principalRubles',op:'set',value:'300000.00',quote:'300000.00'},{field:'annualRatePercent',op:'set',value:'19,00',quote:'19,00%'},{field:'months',op:'set',value:36,quote:'36 месяцев'}];
 const intent={version:intentVersion,action:'calculate',binding:{mode:'new'},parameters:{calculator:'loan',edits},presentation:{format:'auto',detail:'normal'}};
 assert.equal(pilotPreparationMatches('loan-new',prepareTask(emptyState(scope),env,intent)),true);
 const extra=structuredClone(intent);extra.parameters.edits.push({field:'prepayments',op:'set',value:[{month:6,amountRubles:'1000',strategy:'reduce_term'}],quote:'300000.00'} as any);
 assert.equal(pilotPreparationMatches('loan-new',prepareTask(emptyState(scope),env,extra)),false);
});

test('experimental protocol is explicit and cannot change the normal assistant protocol',async()=>{
 for(const experimental of [undefined,'cashneuro-intent-prototype/1'] as const){
  let body:any;
  const fetcher:typeof fetch=async(_url,options)=>{body=JSON.parse(String(options?.body));throw Error('synthetic offline stop');};
  const model=createCloudAssistantModel({apiKey:'synthetic-pilot-key-never-live'},fetcher,'assistant',experimental);
  await assert.rejects(model.complete(input,async()=>{}));
  assert.ok(body.messages[0].content.startsWith('Protocol '+(experimental??assistantVersion)+'\n'));
 }
 assert.throws(()=>createCloudAssistantModel({apiKey:'synthetic-pilot-key-never-live'},fetch,'classification','cashneuro-intent-prototype/1'));
});
test('suite selection preserves the legacy replay manifest and isolates the additional cases and budget',()=>{
 const basic=createPilotSuite(undefined,catalog),extra=createPilotSuite('additional',catalog);
 assert.equal(basic.version,'analyzer-next-pilot/1');assert.equal(basic.cases.length,8);assert.equal(basic.limitRub,'10');assert.equal(basic.caseSignature,undefined);
 assert.equal(extra.version,'analyzer-next-additional/1');assert.equal(extra.cases.length,25);assert.equal(extra.limitRub,'5');assert.match(extra.caseSignature!,/^[a-f0-9]{64}$/);assert.equal(extra.caseSignature,createPilotSuite('additional',catalog).caseSignature);
 assert.equal(new Set(extra.cases.map(v=>v.id)).size,25);assert.throws(()=>createPilotSuite('anything',catalog),/PILOT_SUITE_INVALID/);
 const ui=extra.global(extra.cases.find(c=>c.id==='months-current-ui')!);assert.equal(ui.revision,1);assert.equal(ui.filter.from,'2025-09-01');assert.deepEqual(ui.touched,{period:1,categories:1});assert.equal(ui.filter.categoryIds?.length,1);
 assert.equal(extra.global(extra.cases.find(c=>c.id==='loan-two-variants')!).filter.amountFrom,'99999999');
});
test('invalid reply diagnostics identify family/presentation confusion without echoing arbitrary keys or values',()=>{
 const raw={version:intentVersion,action:'read',binding:{mode:'continue',conditions:'merge_ui'},parameters:{metric:'loan_payments',grouping:'time',comparison:'none',conditions:[],options:{chart:'line',format:'chart',detail:'normal'}},presentation:{format:'chart',detail:'normal'}};
 const d:any=pilotIntentDiagnostic(raw);assert.equal(d.invalid,true);assert.equal(d.metric,'loan_payments');assert.equal(d.grouping,'time');assert.deepEqual(d.invalidPresentationOptionNames,['format','detail']);assert.equal(d.unknownOptionCount,2);
 const malicious:any=structuredClone(raw);malicious['private-key-name']='private-value';malicious.parameters.metric='private-value';malicious.parameters.options['private-option']='private-value';const text=JSON.stringify(pilotIntentDiagnostic(malicious));assert.ok(!text.includes('private-'));assert.ok(text.includes('unknownCommonCount'));
 const calc:any=pilotIntentDiagnostic({version:intentVersion,action:'calculate',binding:{mode:'continue',conditions:'merge_ui'},parameters:{calculator:'loan',edits:[{field:'payment',op:'set',value:'both',quote:'private-quote'}]},presentation:{format:'chart',detail:'normal'}});
 assert.equal(calc.calculator,'loan');assert.equal(calc.edits[0].field,'payment');assert.equal(calc.edits[0].valueChoice,'both');assert.ok(!JSON.stringify(calc).includes('private-'));
 const clear:any=pilotIntentDiagnostic({version:intentVersion,action:'calculate',binding:{mode:'continue',conditions:'merge_ui'},parameters:{calculator:'loan',edits:[{field:'payment',op:'clear',quote:'private-quote'}]},presentation:{format:'chart',detail:'normal'}});assert.equal(clear.edits[0].op,'clear');assert.equal(clear.edits[0].hasQuote,true);assert.ok(!JSON.stringify(clear).includes('private-'));
});
