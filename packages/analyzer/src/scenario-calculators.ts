import {assertClosedSchema} from './closed-schema.ts';
import type {BasicCalculatorInput,BasicCalculatorResult} from './calculators.ts';
const closed=(properties:Record<string,unknown>)=>({type:'object',additionalProperties:false,properties,required:Object.keys(properties)});
const k=(v:string)=>({type:'string',enum:[v]}),decimal={type:'string',minLength:1,maxLength:40,pattern:'^[0-9][0-9 \\u00a0\\u202f]*(?:[.,][0-9]{1,2})?$'},months={type:'integer',minimum:1,maximum:600};
export const scenarioSchemas=[
 closed({kind:k('loan_capacity'),monthlyPaymentRubles:decimal,annualRatePercent:decimal,months}),
 closed({kind:k('loan_term'),principalRubles:decimal,annualRatePercent:decimal,monthlyPaymentRubles:decimal}),
 closed({kind:k('savings_goal'),targetRubles:decimal,initialRubles:decimal,annualRatePercent:decimal,months}),
 closed({kind:k('goal_term'),targetRubles:decimal,initialRubles:decimal,annualRatePercent:decimal,monthlyAdditionRubles:decimal}),
 closed({kind:k('refinance'),principalRubles:decimal,currentRatePercent:decimal,currentMonths:months,newRatePercent:decimal,newMonths:months,upfrontFeesRubles:decimal}),
 closed({kind:k('affordability'),priceRubles:decimal,availableRubles:decimal,monthlyIncomeRubles:decimal,monthlyExpensesRubles:decimal,reserveRubles:decimal,months}),
 closed({kind:k('reserve'),monthlyExpensesRubles:decimal,reserveMonths:months,availableRubles:decimal}),
 closed({kind:k('percentage'),baseRubles:decimal,percent:decimal}),
];
export type ScenarioInput=
 |{kind:'loan_capacity';monthlyPaymentRubles:string;annualRatePercent:string;months:number}
 |{kind:'loan_term';principalRubles:string;annualRatePercent:string;monthlyPaymentRubles:string}
 |{kind:'savings_goal';targetRubles:string;initialRubles:string;annualRatePercent:string;months:number}
 |{kind:'goal_term';targetRubles:string;initialRubles:string;annualRatePercent:string;monthlyAdditionRubles:string}
 |{kind:'refinance';principalRubles:string;currentRatePercent:string;currentMonths:number;newRatePercent:string;newMonths:number;upfrontFeesRubles:string}
 |{kind:'affordability';priceRubles:string;availableRubles:string;monthlyIncomeRubles:string;monthlyExpensesRubles:string;reserveRubles:string;months:number}
 |{kind:'reserve';monthlyExpensesRubles:string;reserveMonths:number;availableRubles:string}
 |{kind:'percentage';baseRubles:string;percent:string};
export type ScenarioResult={version:'cashneuro-scenario/1';kind:ScenarioInput['kind'];input:ScenarioInput;title:string;metrics:{label:string;value:string;unit:'money'|'count'}[];rows:{month:number;amountMinor:string;closingMinor:string}[];assumptions:string[];scenarios?:BasicCalculatorResult[]};
export function parseScenarioInput(raw:unknown):ScenarioInput{assertClosedSchema(raw,{anyOf:scenarioSchemas});return structuredClone(raw) as ScenarioInput;}
const round=(a:bigint,b:bigint)=>(a+b/2n)/b,decimalRubles=(n:bigint)=>(n/100n)+'.'+(n%100n).toString().padStart(2,'0');
const fail=(code:string):never=>{throw new TypeError(code);};
export function calculateScenario(input:ScenarioInput,tools:{money:(v:string)=>string;payment:(principal:bigint,rate:bigint,months:number)=>bigint;calculate:(input:BasicCalculatorInput)=>BasicCalculatorResult}):ScenarioResult{
 const amount=(s:string)=>BigInt(tools.money(s)),rate=(s:string)=>{const n=amount(s);if(n>100000n)fail('CALCULATOR_INPUT_INVALID');return n;};
 for(const [key,v]of Object.entries(input))if(typeof v==='string'&&key!=='kind'){amount(v);if(/RatePercent$|^percent$/u.test(key))rate(v);}
 const r:ScenarioResult={version:'cashneuro-scenario/1',kind:input.kind,input,title:'Расчётный сценарий',metrics:[],rows:[],assumptions:['Сценарий по введённым условиям не меняет операции и обязательства. Равные месяцы, годовая ставка / 12, округление до копейки.']};
 const metric=(label:string,value:bigint,unit:'money'|'count'='money')=>r.metrics.push({label,value:value.toString(),unit});
 const loan=(p:bigint,rate:string,n:number)=>tools.calculate({kind:'loan',principalRubles:decimalRubles(p),annualRatePercent:rate,months:n,payment:'annuity'}) as Extract<BasicCalculatorResult,{kind:'loan'}>;
 if(input.kind==='loan_capacity'){
  const payment=amount(input.monthlyPaymentRubles),bps=rate(input.annualRatePercent);if(!payment)fail('CALCULATOR_POSITIVE_PAYMENT_REQUIRED');
  let lo=0n,hi=1_000_000_000_000_000n;while(lo<hi){const mid=(lo+hi+1n)/2n;if(tools.payment(mid,bps,input.months)<=payment)lo=mid;else hi=mid-1n;}
  if(!lo)fail('CALCULATOR_PAYMENT_TOO_SMALL');let schedule=loan(lo,input.annualRatePercent,input.months);while(schedule.rows.some(r=>BigInt(r.paymentMinor)>payment)){lo--;if(!lo)fail('CALCULATOR_PAYMENT_TOO_SMALL');schedule=loan(lo,input.annualRatePercent,input.months);}r.title='Сумма кредита под заданный платёж';metric('Расчётная сумма кредита',lo);metric('Обычный платёж',BigInt(schedule.regularPaymentMinor));metric('Проценты',BigInt(schedule.interestMinor));r.scenarios=[schedule];r.assumptions.push('Это не одобрение банка. Страховки, комиссии и долговая нагрузка не включены.');
 }else if(input.kind==='loan_term'){
  let balance=amount(input.principalRubles);const payment=amount(input.monthlyPaymentRubles),bps=rate(input.annualRatePercent);if(!balance||!payment)fail('CALCULATOR_POSITIVE_PAYMENT_REQUIRED');let interestTotal=0n;
  for(let m=1;m<=600&&balance;m++){const interest=round(balance*bps,120000n);if(payment<=interest)fail('CALCULATOR_PAYMENT_BELOW_INTEREST');const paid=payment<balance+interest?payment:balance+interest;balance+=interest-paid;interestTotal+=interest;r.rows.push({month:m,amountMinor:paid.toString(),closingMinor:balance.toString()});}
  if(balance)fail('CALCULATOR_TERM_EXCEEDS_600_MONTHS');r.title='Срок погашения при заданном платеже';metric('Срок, месяцев',BigInt(r.rows.length),'count');metric('Проценты',interestTotal);metric('Всего выплат',amount(input.principalRubles)+interestTotal);
 }else if(input.kind==='savings_goal'||input.kind==='goal_term'){
  const target=amount(input.targetRubles),initial=amount(input.initialRubles),bps=rate(input.annualRatePercent);let months=input.kind==='savings_goal'?input.months:0,addition=input.kind==='goal_term'?amount(input.monthlyAdditionRubles):0n;
  const accumulated=(addition:bigint)=>{let b=initial;for(let m=1;m<=months;m++)b+=round(b*bps,120000n)+addition;return b;};
  if(input.kind==='savings_goal'){let lo=0n,hi=target;while(lo<hi){const mid=(lo+hi)/2n;if(accumulated(mid)>=target)hi=mid;else lo=mid+1n;}addition=lo;}
  else{let b=initial;while(b<target&&months<600){b+=round(b*bps,120000n)+addition;months++;}if(b<target)fail('CALCULATOR_GOAL_NOT_REACHED');}
  let balance=initial;for(let m=1;m<=months;m++){balance+=round(balance*bps,120000n)+addition;r.rows.push({month:m,amountMinor:addition.toString(),closingMinor:balance.toString()});}
  r.title='План накопления на цель';metric('Цель',target);metric('Пополнение в конце месяца',addition);metric('Срок, месяцев',BigInt(months),'count');metric('Итог накоплений',balance);r.assumptions.push('Ставка — условие сценария, не гарантированная доходность. Налоги, комиссии и изменение цены цели не включены.');
 }else if(input.kind==='refinance'){
  const principal=amount(input.principalRubles);if(!principal)fail('CALCULATOR_INPUT_INVALID');const old=loan(principal,input.currentRatePercent,input.currentMonths),next=loan(principal,input.newRatePercent,input.newMonths),fees=amount(input.upfrontFeesRubles);
  r.title='Сравнение рефинансирования';metric('Текущий платёж',BigInt(old.regularPaymentMinor));metric('Новый платёж',BigInt(next.regularPaymentMinor));metric('Снижение платежа',BigInt(old.regularPaymentMinor)-BigInt(next.regularPaymentMinor));metric('Экономия процентов за вычетом разовых расходов',BigInt(old.interestMinor)-BigInt(next.interestMinor)-fees);metric('Разовые расходы',fees);r.scenarios=[old,next];r.assumptions.push('Сравниваются полные оставшиеся сроки. Это не официальная ПСК; дополнительные страховки и комиссии следует включить в разовые расходы. Уменьшение платежа само по себе не означает экономию.');
 }else if(input.kind==='affordability'){
  const reserve=amount(input.reserveRubles),flow=amount(input.monthlyIncomeRubles)-amount(input.monthlyExpensesRubles);let balance=amount(input.availableRubles)-amount(input.priceRubles);const sufficient=balance>=reserve;
  r.title='Влияние покупки на запас денег';metric('После покупки',balance);metric('Ежемесячный денежный поток',flow);metric('Требуемый резерв',reserve);for(let m=1;m<=input.months;m++){balance+=flow;r.rows.push({month:m,amountMinor:flow.toString(),closingMinor:balance.toString()});}metric('В конце сценария',balance);r.assumptions.push(sufficient&&r.rows.every(p=>BigInt(p.closingMinor)>=reserve)?'В заданном сценарии резерв сохраняется.':'В заданном сценарии резерв нарушается.');r.assumptions.push('Доходы и расходы заданы явно. Неизвестные обязательства и изменения не предсказываются.');
 }else if(input.kind==='reserve'){
  const target=amount(input.monthlyExpensesRubles)*BigInt(input.reserveMonths),current=amount(input.availableRubles);r.title='Расчёт финансового резерва';metric('Целевой резерв',target);metric('Уже доступно',current);metric('Осталось накопить',target>current?target-current:0n);r.assumptions.push('Число месяцев резерва задано пользователем, а не считается универсально достаточным.');
 }else{r.title='Расчёт процента от суммы';metric('Исходная сумма',amount(input.baseRubles));metric('Доля от суммы',round(amount(input.baseRubles)*rate(input.percent),10000n));}
 return r;
}
