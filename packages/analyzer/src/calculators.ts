import {assertClosedSchema} from './closed-schema.ts';

export const calculatorVersion='cashneuro-calculator/1';
const closed=(properties:Record<string,unknown>,required=Object.keys(properties))=>({type:'object',additionalProperties:false,properties,required});
const enumeration=(values:readonly string[])=>({type:'string',enum:values});
const decimal={type:'string',minLength:1,maxLength:40,pattern:'^[0-9][0-9 \\u00a0\\u202f]*(?:[.,][0-9]{1,2})?$'};
const month={type:'integer',minimum:1,maximum:600};
export const calculatorSchema={anyOf:[
 closed({kind:enumeration(['loan']),principalRubles:decimal,annualRatePercent:decimal,months:month,payment:enumeration(['annuity','differentiated']),
  prepayments:{type:'array',maxItems:120,items:closed({month,amountRubles:decimal,strategy:enumeration(['reduce_term','reduce_payment'])})},
  rateChanges:{type:'array',maxItems:60,items:closed({month,annualRatePercent:decimal})}},['kind','principalRubles','annualRatePercent','months','payment']),
 closed({kind:enumeration(['deposit']),principalRubles:decimal,annualRatePercent:decimal,months:month,capitalization:{type:'boolean'},monthlyAdditionRubles:decimal},['kind','principalRubles','annualRatePercent','months','capitalization']),
 closed({kind:enumeration(['real_return']),netReturnPercent:{...decimal,pattern:'^-?[0-9][0-9 \\u00a0\\u202f]*(?:[.,][0-9]{1,2})?$'},inflationPercent:{...decimal,pattern:'^-?[0-9][0-9 \\u00a0\\u202f]*(?:[.,][0-9]{1,2})?$'}}),
]};
export type LoanInput={kind:'loan';principalRubles:string;annualRatePercent:string;months:number;payment:'annuity'|'differentiated';prepayments?:{month:number;amountRubles:string;strategy:'reduce_term'|'reduce_payment'}[];rateChanges?:{month:number;annualRatePercent:string}[]};
export type CalculatorInput=LoanInput|{kind:'deposit';principalRubles:string;annualRatePercent:string;months:number;capitalization:boolean;monthlyAdditionRubles?:string}|{kind:'real_return';netReturnPercent:string;inflationPercent:string};
export type LoanRow={month:number;openingMinor:string;annualRateBps:number;interestMinor:string;principalMinor:string;paymentMinor:string;extraMinor:string;unusedExtraMinor:string;closingMinor:string};
export type DepositRow={month:number;openingMinor:string;interestMinor:string;additionMinor:string;closingMinor:string};
export type CalculatorResult={version:typeof calculatorVersion;kind:'loan';input:LoanInput;principalMinor:string;regularPaymentMinor:string;totalPaidMinor:string;interestMinor:string;months:number;interestSavedMinor:string;monthsSaved:number;unappliedPrepayments:number[];rows:LoanRow[];assumptions:string[]}
 |{version:typeof calculatorVersion;kind:'deposit';input:Extract<CalculatorInput,{kind:'deposit'}>;contributedMinor:string;interestMinor:string;endingMinor:string;rows:DepositRow[];assumptions:string[]}
 |{version:typeof calculatorVersion;kind:'real_return';input:Extract<CalculatorInput,{kind:'real_return'}>;realReturnPercent:string;assumptions:string[]};

const fail=():never=>{throw new TypeError('CALCULATOR_INPUT_INVALID');};
/** Decimal rubles/percent to hundredths. Grouping is accepted only in triples. */
function hundredths(text:string):bigint{
 const m=/^((?:0|[1-9][0-9]*|[1-9][0-9]{0,2}(?:[ \u00a0\u202f][0-9]{3})+))(?:[.,]([0-9]{1,2}))?$/.exec(text);
 if(!m)return fail();return BigInt(m[1]!.replace(/[ \u00a0\u202f]/g,''))*100n+BigInt((m[2]??'').padEnd(2,'0'));
}
const amount=(s:string,positive=false)=>{const n=hundredths(s);if(n>1_000_000_000_000_000n||positive&&n===0n)fail();return n;};
const rate=(s:string)=>{const n=hundredths(s);if(n>100_000n)fail();return n;};
const round=(a:bigint,b:bigint)=>(a+b/2n)/b;
const min=(a:bigint,b:bigint)=>a<b?a:b;
const monthlyDenominator=120_000n;
const signedPercent=(s:string)=>{const n=(s.startsWith('-')?-1n:1n)*hundredths(s.replace(/^-/u,''));if(n< -10_000n||n>100_000n)fail();return n;};
export function parseCalculatorInput(raw:unknown):CalculatorInput{
 try{assertClosedSchema(raw,calculatorSchema);}catch{fail();}
 const v=structuredClone(raw) as CalculatorInput;
 if(v.kind==='real_return'){signedPercent(v.netReturnPercent);if(signedPercent(v.inflationPercent)<=-10_000n)fail();return v;}
 amount(v.principalRubles,true);rate(v.annualRatePercent);
 if(v.kind==='deposit'){if(v.monthlyAdditionRubles!==undefined)amount(v.monthlyAdditionRubles);return v;}
 const months=new Set<number>();
 for(const event of v.prepayments??[]){amount(event.amountRubles,true);if(event.month>v.months||months.has(event.month))fail();months.add(event.month);}
 months.clear();for(const event of v.rateChanges??[]){rate(event.annualRatePercent);if(event.month>v.months||months.has(event.month))fail();months.add(event.month);}
 v.prepayments?.sort((a,b)=>a.month-b.month);v.rateChanges?.sort((a,b)=>a.month-b.month);return v;
}
function annuity(balance:bigint,bps:bigint,months:number){
 if(!bps)return round(balance,BigInt(months))||1n;
 const power=(monthlyDenominator+bps)**BigInt(months),denPower=monthlyDenominator**BigInt(months);
 return round(balance*bps*power,monthlyDenominator*(power-denPower))||1n;
}
function remainingTerm(balance:bigint,bps:bigint,payment:bigint,max:number){
 for(let n=1;n<=max;n++){
  const interest=round(balance*bps,monthlyDenominator);
  if(payment<=interest)fail();
  balance-=min(balance,payment-interest);if(!balance)return n;
 }
 return max;
}
function loan(input:LoanInput){
 const principal=amount(input.principalRubles,true);let balance=principal,bps=rate(input.annualRatePercent),end=input.months;
 let payment=annuity(balance,bps,end),principalPayment=round(balance,BigInt(end))||1n,interestTotal=0n,total=0n;
 const regular= input.payment==='annuity'?payment:min(balance,principalPayment)+round(balance*bps,monthlyDenominator),rows:LoanRow[]=[];
 for(let m=1;m<=end&&balance>0n;m++){
  const change=input.rateChanges?.find(e=>e.month===m);
  if(change){bps=rate(change.annualRatePercent);payment=annuity(balance,bps,end-m+1);}
  const opening=balance,interest=round(balance*bps,monthlyDenominator);
  let paidPrincipal=m===end?balance:input.payment==='differentiated'?min(balance,principalPayment):min(balance,payment-interest);
  if(paidPrincipal<=0n)fail();
  balance-=paidPrincipal;const ordinary=paidPrincipal+interest,event=input.prepayments?.find(e=>e.month===m),requested=event?amount(event.amountRubles):0n,extra=min(balance,requested);
  balance-=extra;interestTotal+=interest;total+=ordinary+extra;
  rows.push({month:m,openingMinor:opening.toString(),annualRateBps:Number(bps),interestMinor:interest.toString(),principalMinor:paidPrincipal.toString(),paymentMinor:ordinary.toString(),extraMinor:extra.toString(),unusedExtraMinor:(requested-extra).toString(),closingMinor:balance.toString()});
  if(event&&balance>0n){
   if(event.strategy==='reduce_payment'){
    payment=annuity(balance,bps,end-m);principalPayment=round(balance,BigInt(end-m))||1n;
   }else{
    const left=input.payment==='annuity'?remainingTerm(balance,bps,payment,end-m):Number((balance+principalPayment-1n)/principalPayment);
    end=Math.min(end,m+left);
   }
  }
 }
 if(balance!==0n)fail();return {rows,regular,principal,total,interestTotal};
}
export function calculateFinancial(raw:unknown):CalculatorResult{
 const input=parseCalculatorInput(raw);
 if(input.kind==='real_return'){
  const net=signedPercent(input.netReturnPercent),inflation=signedPercent(input.inflationPercent),difference=net-inflation,absolute=round((difference<0n?-difference:difference)*10_000n,10_000n+inflation);
  return {version:calculatorVersion,kind:input.kind,input,realReturnPercent:(difference<0n&&absolute?'-':'')+(absolute/100n)+'.'+(absolute%100n).toString().padStart(2,'0'),assumptions:['Реальная доходность = (1 + чистая номинальная доходность) / (1 + инфляция) − 1.','Чистая доходность уже учитывает комиссии и налоги; оба процента относятся к одному периоду. Это введённые условия, не текущие рыночные данные.']};
 }
 if(input.kind==='deposit'){
  let balance=amount(input.principalRubles,true),contributed=balance,totalInterest=0n;const bps=rate(input.annualRatePercent),addition=amount(input.monthlyAdditionRubles??'0'),rows:DepositRow[]=[];
  for(let m=1;m<=input.months;m++){
   const opening=balance,interest=round(balance*bps,monthlyDenominator);totalInterest+=interest;contributed+=addition;
   balance+=addition+(input.capitalization?interest:0n);
   rows.push({month:m,openingMinor:opening.toString(),interestMinor:interest.toString(),additionMinor:addition.toString(),closingMinor:balance.toString()});
  }
  return {version:calculatorVersion,kind:input.kind,input,contributedMinor:contributed.toString(),interestMinor:totalInterest.toString(),endingMinor:(balance+(input.capitalization?0n:totalInterest)).toString(),rows,assumptions:['Расчётная модель: годовая ставка / 12, равные месяцы; проценты округляются до копейки каждый месяц.','Пополнение поступает в конце месяца после начисления процентов. Без капитализации проценты выплачиваются отдельно и включены в общий итог.','Налоги, комиссии, ежедневный календарь и условия конкретного банка не включены. Это не официальный график банка.']};
 }
 const result=loan(input),baseline=loan({...input,prepayments:[]});
 return {version:calculatorVersion,kind:input.kind,input,principalMinor:result.principal.toString(),regularPaymentMinor:result.rows[0]!.paymentMinor,totalPaidMinor:result.total.toString(),interestMinor:result.interestTotal.toString(),months:result.rows.length,interestSavedMinor:(baseline.interestTotal-result.interestTotal).toString(),monthsSaved:baseline.rows.length-result.rows.length,unappliedPrepayments:(input.prepayments??[]).filter(e=>e.month>result.rows.length).map(e=>e.month),rows:result.rows,assumptions:['Расчётная модель: проценты на остаток долга по годовой ставке / 12, равные месяцы, округление до копейки; последний платёж выравнивает остаток.','Изменение ставки действует перед указанным ежемесячным платежом; платёж пересчитывается до текущего планового срока.','Досрочное погашение — после обычного платежа в указанном месяце. Уменьшение срока сохраняет платёж (у дифференцированного — основной долг в платеже); уменьшение платежа сохраняет текущий плановый срок.','Экономия сравнивается с той же последовательностью ставок без досрочных платежей. Неиспользованные досрочные суммы показаны отдельно.','Комиссии, страховки, налоги, переносы дат и банковский ежедневный метод не включены. Это не официальный график банка; реальные операции и обязательства не изменяются.']};
}
function rubles(s:string){const n=BigInt(s),a=n<0n?-n:n;return (n<0n?'-':'')+(a/100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g,' ')+','+(a%100n).toString().padStart(2,'0')+' ₽';}
export function calculatorText(r:CalculatorResult){
 if(r.kind==='real_return')return `Реальная доходность по введённым условиям: ${r.realReturnPercent.replace('.',',')}%. Это расчётная модель, а не прогноз.`;
 if(r.kind==='deposit')return `По введённым условиям за ${r.input.months} мес.: внесено ${rubles(r.contributedMinor)}, проценты ${rubles(r.interestMinor)}, всего ${rubles(r.endingMinor)}. Расчётная модель без налогов и комиссий.`;
 return `Расчётная модель кредита: первый платёж ${rubles(r.regularPaymentMinor)}, срок ${r.months} мес., проценты ${rubles(r.interestMinor)}, всего ${rubles(r.totalPaidMinor)}. Экономия процентов относительно варианта без досрочных платежей: ${rubles(r.interestSavedMinor)}. Это не официальный график банка.`;
}

export function calculatorRublesMinor(value:string){return amount(value).toString();}
