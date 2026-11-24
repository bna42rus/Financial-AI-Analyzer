/** Normal authenticated Staging HTTP calls; uses the existing server cost cap.
 * No SQL, financial writes, arbitrary URLs, automatic retries or secret output. */
import {randomUUID} from 'node:crypto';
import {calculatorRublesMinor} from '../packages/analyzer/src/calculators.ts';
import {performance} from 'node:perf_hooks';
if(process.argv.slice(2).join(' ')!=='--live --within-server-cap-rub=100')throw Error('Use the authorized live wrapper');
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
let failed=0;
try{
 await post('/auth/sign-in/email',{email,password});
 const summary=await post('/finance/summary',{compact:true}),state=await post('/finance/analyzer-state',{});
 if(!state.assistantProtocol||!state.taskProtocol)throw Error('ASSISTANT_NOT_ACTIVE');
 const context=await post('/finance/analyzer-context',{generation:summary.generation});
 const create=async(title:string)=>{const id=randomUUID(),c=await post('/finance/analyzer-chat',{id,create:true});await post('/finance/analyzer-chat',{id,title});return {chatId:id,chatEpoch:c.chatEpoch};};
 const dates=await create('Автопроверка: расходы и контекст'),loan=await create('Автопроверка: кредит');
 const query=(month:string,group?:string)=>(a:any)=>a?.query?.metric==='expenses'&&a.query.filter.from===`2026-${month}-01`&&(!group||a.query.grouping===group);
 const calc=(payment:string,rate='22')=>(a:any)=>a?.calculation?.kind==='loan'&&calculatorRublesMinor(a.calculation.input.principalRubles)==='50000000'&&a.calculation.input.months===60&&a.calculation.input.payment===payment&&calculatorRublesMinor(a.calculation.input.annualRatePercent)===calculatorRublesMinor(rate);
 const cases:{name:string;chat:typeof dates;text:string;check:(answer:any)=>boolean}[]=[
  {name:'expenses-october',chat:dates,text:'Сколько я потратил за октябрь 2026 года?',check:query('10')},
  {name:'group-followup',chat:dates,text:'А по категориям?',check:query('10','category')},
  {name:'month-followup',chat:dates,text:'А за сентябрь?',check:query('09','category')},
  {name:'compare-followup',chat:dates,text:'Сравни эти два месяца. Где расходы выросли сильнее всего?',check:a=>query('10','category')(a)&&a.query.comparison==='custom'&&a.query.options.comparisonPeriod.from==='2026-09-01'},
  {name:'loan-question',chat:loan,text:'Кредит 500000 рублей на 5 лет под 22% годовых. Сколько платить в месяц?',check:a=>a?.mode==='clarification'||a?.report?.sections.filter((s:any)=>s.calculation?.kind==='loan').length>=2},
  {name:'explain-followup',chat:loan,text:'А в чем разница между аннуитетным и дифференцированным, как узнать какой у меня?',check:a=>a?.mode==='ai'&&/аннуитет/iu.test(a.text)&&/дифференц/iu.test(a.text)&&/договор|график|выписк|банк/iu.test(a.text)},
  {name:'choose-payment',chat:loan,text:'Дифференцированный',check:calc('differentiated')},
  {name:'switch-payment',chat:loan,text:'А ануитентный?',check:calc('annuity')},
  {name:'compare-loans',chat:loan,text:'Покажи аннуитетный и дифференцированный при ставке 25%, остальные условия сохрани',check:a=>a?.report?.sections.some((s:any)=>calc('annuity','25')({calculation:s.calculation}))&&a.report.sections.some((s:any)=>calc('differentiated','25')({calculation:s.calculation}))},
  {name:'which-cheaper',chat:loan,text:'Что выгоднее в итоге и на сколько рублей?',check:a=>a?.report?.sections.some((s:any)=>calc('annuity','25')({calculation:s.calculation}))&&a.report.sections.some((s:any)=>calc('differentiated','25')({calculation:s.calculation}))},
  {name:'payment-chart',chat:loan,text:'У дифференцированного покажи график платежей с основным долгом и процентами, условия сохрани',check:a=>calc('differentiated','25')(a)||a?.report?.sections.some((s:any)=>calc('differentiated','25')({calculation:s.calculation}))},
 ];
 for(const c of cases){
  const started=performance.now(),id=randomUUID(),r=await post('/finance/analyzer-task',{id,...c.chat,generation:summary.generation,globalRevision:context.revision,text:c.text});
  const ms=Math.round(performance.now()-started),ok=c.check(r.answer);failed+=Number(!ok);
  console.log(`${ok?'PASS':'FAIL'} ${c.name}: ${r.code??r.answer?.mode}, ${ms} ms`);
  if(!ok)console.log(JSON.stringify({case:c.name,requestId:id,mode:r.answer?.mode,code:r.code,query:r.answer?.query?{metric:r.answer.query.metric,grouping:r.answer.query.grouping,from:r.answer.query.filter.from,through:r.answer.query.filter.through,comparison:r.answer.query.comparison}:undefined,calculation:r.answer?.calculation?.input,sections:r.answer?.report?.sections.map((s:any)=>({label:s.label,input:s.calculation?.input,error:s.error?.code})),text:r.answer?.mode==='clarification'||r.answer?.mode==='unavailable'?r.answer.text:undefined}));
  if(/COST|QUOTA|DELIVERY|PROVIDER|AUTH|ACCESS|REQUEST_FAILED/.test(r.code??''))throw Error(r.code);
 }
 console.log(`RESULT: ${cases.length-failed}/${cases.length}; no financial data changed; two diagnostic chats retained.`);
 process.exitCode=failed?1:0;
}catch(e){console.error(e instanceof Error&&/^[A-Z0-9_]+$/.test(e.message)?e.message:'LIVE_CHECK_STOPPED');process.exitCode=1;}
finally{if(cookies.size)await post('/auth/sign-out',{}).catch(()=>{});cookies.clear();}
