import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {parseIntent,intentVersion} from '../src/next/intent.ts';
import {calculateFinancial} from '../src/calculators.ts';
import {validateCoverage,coverageUrl,sourceUrl} from '../../../scripts/analyzer-v2-coverage.mjs';

const shell=(action:string,parameters:unknown,binding:unknown={mode:'new'})=>({version:intentVersion,action,binding,parameters,presentation:{format:'auto',detail:'normal'}});
const loan=(edits:unknown[]=[])=>shell('calculate',{calculator:'loan',edits});
const set=(field:string,value:unknown)=>({field,op:'set',value,quote:'синтетическое условие'});
const read=()=>shell('read',{metric:'expenses',grouping:null,comparison:null,conditions:[{field:'period',op:'set',expression:'октябрь 2025'}],options:{}});
const step=(key:string,intent:unknown,after:string[]=[],bindings:unknown[]=[])=>({key,after,intent,bindings});
const report=(steps:unknown[])=>shell('report',{steps});

test('all 240 tasks and 12 original four-turn dialogs have honest evidence and individual acceptance criteria',async()=>{
 const source=await readFile(sourceUrl,'utf8'),matrix=JSON.parse(await readFile(coverageUrl,'utf8'));
 assert.deepEqual(await validateCoverage(matrix,source),{tasks:240,dialogs:12,candidates:15,missing:2});
 const missing=structuredClone(matrix);missing.tasks.pop();await assert.rejects(validateCoverage(missing,source));
 const duplicate=structuredClone(matrix);duplicate.tasks[1]=duplicate.tasks[0];await assert.rejects(validateCoverage(duplicate,source));
 const drift=structuredClone(matrix);drift.tasks[0].question='Потерян исходный вопрос';await assert.rejects(validateCoverage(drift,source));
 const accepted=structuredClone(matrix);accepted.tasks[0].status='accepted';await assert.rejects(validateCoverage(accepted,source));
 const evidence=structuredClone(matrix);evidence.tools.read.symbol='nonexistentExport';await assert.rejects(validateCoverage(evidence,source));
});
test('read, calculator and explanation all accept the same explicit conversation binding',()=>{
 const binding={mode:'continue',conditions:'pin'};
 for(const intent of [read(),loan([set('payment','differentiated')]),shell('explain',{subject:{kind:'concept',question:'В чём разница типов платежа?'}})])
  assert.deepEqual(parseIntent({...intent,binding}).binding,binding);
});
test('follow-up calculator carries only explicit changes; missing values are not defaulted by structural parsing',()=>{
 const intent=parseIntent({...loan([set('payment','annuity')]),binding:{mode:'continue',conditions:'merge_ui'}});
 assert.equal(intent.action,'calculate');if(intent.action!=='calculate')return;
 assert.deepEqual(intent.parameters,{calculator:'loan',edits:[set('payment','annuity')]});
 assert.deepEqual(parseIntent(loan()).parameters,{calculator:'loan',edits:[]});
});
test('closed variants reject foreign fields, model-assigned authority and incompatible calculator arguments',()=>{
 for(const intent of [
  {...read(),ownerId:'another-owner'}, {...read(),action:'calculate'}, {...loan(),version:'assistant-workflow/7'},
  loan([set('ownerId','forged')]),loan([set('capitalization',true)]),loan([set('months','12')]),
  {...read(),binding:{mode:'new',handle:'r1'}},
  {...read(),binding:{mode:'reference',handle:'r1',conditions:'merge_ui'}},
  {...read(),parameters:{...read().parameters as object,filter:{accountIds:['forged']}}},
 ]) assert.throws(()=>parseIntent(intent),/INTENT_PROTOTYPE_INVALID/);
});
test('duplicate field edits fail; zero, empty schedule and clear remain distinct',()=>{
 assert.throws(()=>parseIntent(loan([set('months',12),set('months',24)])));
 assert.throws(()=>parseIntent(shell('read',{metric:null,grouping:null,comparison:null,conditions:[{field:'period',op:'clear'},{field:'period',op:'use_current'}],options:{}})));
 for(const edits of [[set('annualRatePercent','0')],[set('prepayments',[])],[{field:'months',op:'clear'}]])
  assert.deepEqual(parseIntent(loan(edits)).parameters,{calculator:'loan',edits});
});
test('all initial action families have separate closed arguments',()=>{
 for(const intent of [
  shell('advise',{goal:'Снизить расходы',constraints:['Кафе не трогать'],evidence:['r1']}),
  shell('propose',{kind:'create_category',name:'Кафе',role:'expense'}),
  shell('compare',{scenarios:['r1','r2'],criterion:'interest',objective:'min'}),
  shell('source',{kind:'key_rate'}),shell('interface',{command:'открой операции'}),
  shell('clarify',{question:'Какая ставка?',missing:['annualRatePercent']}),shell('unrelated',{message:'Задайте вопрос о финансах.'}),
  shell('explain',{subject:{kind:'result',handle:'r1'}}),
 ]) assert.equal(parseIntent(intent).action,intent.action);
 assert.throws(()=>parseIntent(shell('clarify',{question:'Что уточнить?',missing:[]})));
});
test('report DAG accepts forward dependencies and requires explicit fact prerequisites',()=>{
 const valid=report([step('s2',loan([set('payment','annuity')]),['s1'],[{field:'principalRubles',step:'s1',fact:'total'}]),step('s1',read())]);
 assert.equal(parseIntent(valid).action,'report');
 for(const steps of [
  [step('s1',read()),step('s1',read())],
  [step('s1',read(),['absent'])],
  [step('s1',read(),['s2']),step('s2',read(),['s1'])],
  [step('s1',loan(),[],[{field:'principalRubles',step:'s2',fact:'total'}]),step('s2',read())],
  [step('s1',report([step('nested',read())]))],
 ]) assert.throws(()=>parseIntent(report(steps)),/INTENT_PROTOTYPE_INVALID/);
});
test('a full compound request retains nested prepayments and tax bands without weakening the legacy validator',()=>{
 const value=report([
  step('credit',loan([set('prepayments',[{month:6,amountRubles:'10000',strategy:'reduce_term'}])])),
  step('tax',shell('calculate',{calculator:'tax_by_rules',edits:[set('bands',[{upToRubles:null,ratePercent:'13'}])]})),
 ]);
 assert.deepEqual(parseIntent(value),value);
});
test('parsed intent is a copy and does not rewrite the supplied evidence or literal',()=>{
 const original=loan([set('principalRubles','120 000,00')]),parsed=parseIntent(original);
 assert.deepEqual(parsed,original);assert.notEqual(parsed,original);
 if(parsed.action==='calculate')parsed.parameters.edits.length=0;
 assert.equal((original.parameters as {edits:unknown[]}).edits.length,1);
});
test('independent differentiated-loan oracle: principal, interest, monthly payments and closing balance',()=>{
 const result=calculateFinancial({kind:'loan',principalRubles:'120000',annualRatePercent:'12',months:12,payment:'differentiated'});
 assert.equal(result.kind,'loan');if(result.kind!=='loan')return;
 assert.equal(result.interestMinor,'780000');assert.equal(result.totalPaidMinor,'12780000');assert.equal(result.rows.length,12);
 result.rows.forEach((r,i)=>{
  assert.equal(r.principalMinor,'1000000');assert.equal(r.interestMinor,String((12-i)*10000));
  assert.equal(r.paymentMinor,String(1000000+(12-i)*10000));assert.equal(r.closingMinor,String((11-i)*1000000));
 });
});
test('zero-interest oracle and both payment types conserve all principal without negative debt',()=>{
 for(const payment of ['annuity','differentiated']){
  const result=calculateFinancial({kind:'loan',principalRubles:'120000',annualRatePercent:'0',months:12,payment});
  assert.equal(result.kind,'loan');if(result.kind!=='loan')return;
  assert.equal(result.interestMinor,'0');assert.equal(result.totalPaidMinor,'12000000');
  assert.ok(result.rows.every(r=>r.paymentMinor==='1000000'&&BigInt(r.closingMinor)>=0n));
  assert.equal(result.rows.at(-1)?.closingMinor,'0');
 }
});
