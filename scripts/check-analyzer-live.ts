/** Normal authenticated Staging HTTP calls; uses the existing server cost cap.
 * No SQL, financial writes, arbitrary URLs, automatic retries or secret output. */
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {rubAmount} from '../packages/analyzer/src/cost.ts';
import {extendedCases,focusedCases,efficiencyCases} from './analyzer-live-cases.ts';
import type {LiveCase} from './analyzer-live-cases.ts';
import {calculatorRublesMinor} from '../packages/analyzer/src/calculators.ts';
import {performance} from 'node:perf_hooks';
const extended=process.argv.includes('--extended'),focused=process.argv.includes('--focused'),efficiency=process.argv.includes('--efficiency');
if([extended,focused,efficiency].filter(Boolean).length>1)throw Error('ONE_SUITE_REQUIRED');
if(process.argv.slice(2).filter(v=>!['--extended','--focused','--efficiency'].includes(v)).join(' ')!=='--live --within-server-cap-rub=100')throw Error('Use the authorized live wrapper');
const stopRub=process.env.CASHNEURO_SMOKE_STOP_RUB??'5',stopAtoms=rubAmount(stopRub);
if(stopAtoms<=0n||stopAtoms>rubAmount('100'))throw Error('RUN_STOP_INVALID');
const email=process.env.CASHNEURO_SMOKE_EMAIL,password=process.env.CASHNEURO_SMOKE_PASSWORD;
delete process.env.CASHNEURO_SMOKE_EMAIL;delete process.env.CASHNEURO_SMOKE_PASSWORD;
if(!email||!password)throw Error('LOGIN_REQUIRED');
const origin='https://test.cashneuro.ru',base='http://127.0.0.1:3000',cookies=new Map<string,string>();
async function post(path:string,body:unknown){
 const r=await fetch(base+path,{method:'POST',headers:{origin,'content-type':'application/json',cookie:[...cookies].map(([k,v])=>k+'='+v).join('; ')},body:JSON.stringify(body),signal:AbortSignal.timeout(180000),redirect:'error'});
 for(const raw of r.headers.getSetCookie()){const pair=raw.split(';')[0]!,i=pair.indexOf('=');if(i>0)cookies.set(pair.slice(0,i),pair.slice(i+1));}
 const data=await r.json() as any;
 if(!r.ok)throw Error(typeof data.code==='string'?data.code:'HTTP_'+r.status);
 return data;
}
const requestIds:string[]=[],measurements:{ms:number;calls:number}[]=[];
const rub=(atoms:string|bigint)=>{const n=BigInt(atoms);return (n/1000000000n)+'.'+(n%1000000000n).toString().padStart(9,'0');};
function cost(){
 const child=spawnSync('/usr/bin/python3',[fileURLToPath(new URL('./diagnose-analyzer-cost-staging.py',import.meta.url)),'--request-ids-stdin'],{input:JSON.stringify({ids:requestIds,email}),encoding:'utf8',timeout:25000,maxBuffer:1048576,env:{PATH:process.env.PATH??'/usr/bin:/bin',LANG:'C.UTF-8'}});
 if(child.status!==0)throw Error('COST_DIAGNOSTIC_FAILED');
 const report=JSON.parse(child.stdout);if(report.version!=='analyzer-cost-diagnostic/1'||!report.accountFound)throw Error('COST_ACCOUNT_NOT_FOUND');
 if(report.requests.some((r:any)=>!r.requestFound||r.modelCalls===null||Number(r.modelCalls)!==Number(r.calls)))throw Error('COST_RECEIPT_INCONSISTENT');return report;
}
const runSpent=(r:any)=>r.requests.reduce((sum:bigint,v:any)=>sum+BigInt(v.spentAtoms)+BigInt(v.heldAtoms),0n);
let failed=0,tested=0,total=0,stopped=false;

try{
 let accounting=cost();const initialOccupied=BigInt(accounting.spentAtoms)+BigInt(accounting.heldAtoms);
 console.log(`MONTH: spent ${rub(accounting.spentAtoms)} RUB, held ${rub(accounting.heldAtoms)} RUB; configured price ${JSON.stringify(accounting.price)}`);
 console.log(`PREVIOUS_DIAGNOSTIC: ${accounting.previousDiagnostic.requests} requests, ${accounting.previousDiagnostic.calls} model calls, ${rub(accounting.previousDiagnostic.spentAtoms)} RUB; separate from the monthly total.`);
 console.log(`RUN_STOP: ${stopRub} RUB; checked before the next question. An in-flight question still settles under the existing 100 RUB server cap.`);
 await post('/auth/sign-in/email',{email,password});
 const summary=await post('/finance/summary',{compact:true}),state=await post('/finance/analyzer-state',{});
 if(!state.assistantProtocol||!state.taskProtocol)throw Error('ASSISTANT_NOT_ACTIVE');
 const context=await post('/finance/analyzer-context',{generation:summary.generation});
 const create=async(title:string)=>{const id=randomUUID(),c=await post('/finance/analyzer-chat',{id,create:true});await post('/finance/analyzer-chat',{id,title});return {chatId:id,chatEpoch:c.chatEpoch};};
 const dates=await create('Автопроверка: расходы и контекст'),loan=await create('Автопроверка: кредит');
 const query=(month:string,group?:string)=>(a:any)=>a?.query?.metric==='expenses'&&a.query.filter.from===`2026-${month}-01`&&(!group||a.query.grouping===group);
 const calc=(payment:string,rate='22')=>(a:any)=>a?.calculation?.kind==='loan'&&calculatorRublesMinor(a.calculation.input.principalRubles)==='50000000'&&a.calculation.input.months===60&&a.calculation.input.payment===payment&&calculatorRublesMinor(a.calculation.input.annualRatePercent)===calculatorRublesMinor(rate);
 const cases:LiveCase[]=[
  {name:'expenses-october',chat:dates,text:'Сколько я потратил за октябрь 2026 года?',check:query('10')},
  {name:'group-followup',chat:dates,text:'А по категориям?',check:query('10','category')},
  {name:'month-followup',chat:dates,text:'А за сентябрь?',check:query('09','category')},
  {name:'compare-followup',chat:dates,text:'Сравни эти два месяца. Где расходы выросли сильнее всего?',check:a=>query('10','category')(a)&&a.query.comparison==='custom'&&a.query.options.comparisonPeriod.from==='2026-09-01'},
  {name:'loan-question',chat:loan,text:'Кредит 500000 рублей на 5 лет под 22% годовых. Сколько платить в месяц?',check:a=>a?.mode==='clarification'||a?.report?.sections.some((s:any)=>calc('annuity')({calculation:s.calculation}))&&a.report.sections.some((s:any)=>calc('differentiated')({calculation:s.calculation}))},
  {name:'explain-followup',chat:loan,text:'А в чем разница между аннуитетным и дифференцированным, как узнать какой у меня?',check:a=>a?.mode==='ai'&&/аннуитет/iu.test(a.text)&&/дифференц/iu.test(a.text)&&/договор|график|выписк|банк/iu.test(a.text)},
  {name:'choose-payment',chat:loan,text:'Дифференцированный',check:calc('differentiated')},
  {name:'switch-payment',chat:loan,text:'А ануитентный?',check:calc('annuity')},
  {name:'compare-loans',chat:loan,text:'Покажи аннуитетный и дифференцированный при ставке 25%, остальные условия сохрани',check:a=>a?.report?.sections.some((s:any)=>calc('annuity','25')({calculation:s.calculation}))&&a.report.sections.some((s:any)=>calc('differentiated','25')({calculation:s.calculation}))},
  {name:'which-cheaper',chat:loan,text:'Что выгоднее в итоге и на сколько рублей?',check:a=>{const sections=a?.report?.sections??[],annuity=sections.find((s:any)=>calc('annuity','25')({calculation:s.calculation}))?.calculation,differentiated=sections.find((s:any)=>calc('differentiated','25')({calculation:s.calculation}))?.calculation;return !!annuity&&!!differentiated&&sections.some((s:any)=>s.derived?.unit==='money'&&s.derived.value===(BigInt(annuity.interestMinor)-BigInt(differentiated.interestMinor)).toString());}},
  {name:'payment-chart',chat:loan,text:'У дифференцированного покажи график платежей с основным долгом и процентами, условия сохрани',check:a=>calc('differentiated','25')(a)||a?.report?.sections.some((s:any)=>calc('differentiated','25')({calculation:s.calculation}))},
 ];
 const failedChats=new Set<string>();
 if(focused)cases.splice(0,cases.length,...await focusedCases(create));else if(efficiency)cases.splice(0,cases.length,...await efficiencyCases(create));else if(extended)cases.push(...await extendedCases(create));total=cases.length;
 for(const c of cases){
  if(failedChats.has(c.chat.chatId)&&!c.independent){console.log(`SKIP ${c.name}: prior dependent case failed; no request sent`);continue;}
  if(runSpent(accounting)>=stopAtoms||BigInt(accounting.spentAtoms)+BigInt(accounting.heldAtoms)-initialOccupied>=stopAtoms){stopped=true;console.log('STOP: RUN_COST_THRESHOLD; remaining questions were not sent.');break;}
  const id=randomUUID();requestIds.push(id);const started=performance.now(),r=await post('/finance/analyzer-task',{id,...c.chat,generation:summary.generation,globalRevision:context.revision,text:c.text});
  const ms=Math.round(performance.now()-started);accounting=cost();
  const receipt=accounting.requests.find((v:any)=>v.id===id);if(!receipt)throw Error('COST_RECEIPT_MISSING');
  const ok=c.check(r.answer)&&(!focused||Number(receipt.calls)===0);failed+=Number(!ok);if(!ok)failedChats.add(c.chat.chatId);tested++;measurements.push({ms,calls:Number(receipt.calls)});
  console.log(`${ok?'PASS':'FAIL'} ${c.name}: ${r.code??r.answer?.mode}, ${ms} ms, ${rub(receipt.spentAtoms)} RUB, ${receipt.calls} model calls, ${receipt.inputTokens}/${receipt.outputTokens} tokens`);
  if(focused&&Number(receipt.calls)>0)throw Error('FOCUSED_UNEXPECTED_MODEL_CALL');
  if(!ok)console.log(JSON.stringify({case:c.name,requestId:id,mode:r.answer?.mode,code:r.code,query:r.answer?.query?{metric:r.answer.query.metric,grouping:r.answer.query.grouping,from:r.answer.query.filter.from,through:r.answer.query.filter.through,comparison:r.answer.query.comparison}:undefined,calculation:r.answer?.calculation?.input,sections:r.answer?.report?.sections.map((s:any)=>({label:s.label,input:s.calculation?.input,error:s.error?.code}))}));
  if(/COST|QUOTA|DELIVERY|PROVIDER|AUTH|ACCESS|REQUEST_FAILED/.test(r.code??''))throw Error(r.code);
 }
 console.log(`RESULT: ${tested-failed}/${total}; tested ${tested}, failures ${failed}, not run ${total-tested}; no financial data changed; diagnostic chats retained.`);
 const sum=runSpent(accounting);console.log(`RUN_COST: ${rub(sum)} RUB; MONTH_SPENT: ${rub(accounting.spentAtoms)} RUB; MONTH_HELD: ${rub(accounting.heldAtoms)} RUB`);
 for(const kind of ['local','model'] as const){const values=measurements.filter(v=>(v.calls>0)===(kind==='model')).map(v=>v.ms).sort((a,b)=>a-b);if(values.length)console.log(`LATENCY ${kind}: n=${values.length}, p50=${values[Math.floor((values.length-1)*.5)]} ms, p95=${values[Math.ceil((values.length-1)*.95)]} ms`);}
 process.exitCode=failed||stopped?1:0;
}catch(e){console.error(e instanceof Error&&/^[A-Z0-9_]+$/.test(e.message)?e.message:'LIVE_CHECK_STOPPED');process.exitCode=1;}
finally{if(requestIds.length){try{const r=cost();console.log(`ACCOUNTING: run ${rub(runSpent(r))} RUB, monthly available ${rub(BigInt(r.limitAtoms)-BigInt(r.spentAtoms)-BigInt(r.heldAtoms)>0n?BigInt(r.limitAtoms)-BigInt(r.spentAtoms)-BigInt(r.heldAtoms):0n)} RUB`);}catch{console.error('COST_DIAGNOSTIC_FAILED');process.exitCode=1;}}if(cookies.size)await post('/auth/sign-out',{}).catch(()=>{});cookies.clear();}
