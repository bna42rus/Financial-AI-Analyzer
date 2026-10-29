import {test} from 'node:test';
import assert from 'node:assert/strict';
import {calculateFinancial,parseCalculatorInput,calculatorText} from '../src/calculators.ts';
import type {LoanInput,CalculatorResult} from '../src/calculators.ts';
const base:LoanInput={kind:'loan',principalRubles:'5 000 000',annualRatePercent:'12',months:60,payment:'annuity'};
const loan=(input:LoanInput)=>calculateFinancial(input) as Extract<CalculatorResult,{kind:'loan'}>;
test('published CBR example: exact annuity and differentiated first payments, no float money',()=>{
 const annuity=loan(base),diff=loan({...base,payment:'differentiated'});
 assert.equal(annuity.rows[0]!.paymentMinor,'11122224');assert.equal(annuity.rows[0]!.interestMinor,'5000000');
 assert.equal(diff.rows[0]!.paymentMinor,'13333333');assert.equal(diff.rows[1]!.interestMinor,'4916667');
 for(const r of [annuity,diff]){assert.equal(r.rows.at(-1)!.closingMinor,'0');assert.equal(r.months,60);assert.equal(BigInt(r.totalPaidMinor)-BigInt(r.interestMinor),500_000_000n);}
});
test('zero rate, single month and exact cent rounding preserve principal',()=>{
 for(const principalRubles of ['0,01','100.01','12 000'])for(const payment of ['annuity','differentiated'] as const){
  const r=loan({...base,principalRubles,annualRatePercent:'0',months:3,payment});
  assert.equal(r.interestMinor,'0');assert.equal(r.totalPaidMinor,r.principalMinor);
 }
 const one=loan({...base,principalRubles:'100',annualRatePercent:'12',months:1});assert.equal(one.totalPaidMinor,'10100');assert.equal(one.interestMinor,'100');
});
test('prepayments reduce term or payment, multiple events and rate changes retain exact row conservation',()=>{
 for(const payment of ['annuity','differentiated'] as const)for(const strategy of ['reduce_term','reduce_payment'] as const){
  const input:LoanInput={...base,payment,prepayments:[{month:3,amountRubles:'200000',strategy},{month:8,amountRubles:'100000',strategy}],rateChanges:[{month:10,annualRatePercent:'10'}]};
  const r=loan(input);assert.ok(BigInt(r.interestSavedMinor)>0n);if(strategy==='reduce_term')assert.ok(r.monthsSaved>0);else assert.equal(r.months,60);
  assert.equal(r.rows[9]!.annualRateBps,1000);
  for(const row of r.rows){assert.equal(BigInt(row.openingMinor)-BigInt(row.principalMinor)-BigInt(row.extraMinor),BigInt(row.closingMinor));assert.equal(BigInt(row.principalMinor)+BigInt(row.interestMinor),BigInt(row.paymentMinor));}
  assert.deepEqual(input.prepayments?.map(e=>e.month),[3,8]);
 }
 const reduced=loan({...base,prepayments:[{month:1,amountRubles:'1000000',strategy:'reduce_payment'}]});assert.ok(BigInt(reduced.rows[1]!.paymentMinor)<BigInt(reduced.rows[0]!.paymentMinor));
});
test('overpayment is capped to remaining debt, unused amounts and later events remain explicit',()=>{
 const r=loan({...base,principalRubles:'100',months:12,prepayments:[{month:1,amountRubles:'500',strategy:'reduce_term'},{month:2,amountRubles:'50',strategy:'reduce_payment'}]});
 assert.equal(r.months,1);assert.ok(BigInt(r.rows[0]!.unusedExtraMinor)>0n);assert.deepEqual(r.unappliedPrepayments,[2]);assert.equal(r.rows[0]!.closingMinor,'0');
});
test('deposit monthly model distinguishes capitalization and month-end additions',()=>{
 const input={kind:'deposit' as const,principalRubles:'1000',annualRatePercent:'12',months:2,capitalization:true,monthlyAdditionRubles:'100'};
 const a=calculateFinancial(input),b=calculateFinancial({...input,capitalization:false});assert.equal(a.kind,'deposit');assert.equal(b.kind,'deposit');if(a.kind!=='deposit'||b.kind!=='deposit')return;
 assert.equal(a.contributedMinor,'120000');assert.equal(a.interestMinor,'2110');assert.equal(a.endingMinor,'122110');assert.equal(b.interestMinor,'2100');assert.equal(b.endingMinor,'122100');
 assert.ok(a.assumptions.some(s=>s.includes('не официальный')));assert.match(calculatorText(a),/налогов/);
});
test('real return uses ratio, including equal, negative return, deflation and zero denominator rejection',()=>{
 for(const [net,inflation,expected]of [['10','10','0.00'],['20','10','9.09'],['5','10','-4.55'],['-5','10','-13.64'],['0','-10','11.11']]){
  const r=calculateFinancial({kind:'real_return',netReturnPercent:net,inflationPercent:inflation});assert.equal(r.kind,'real_return');if(r.kind==='real_return')assert.equal(r.realReturnPercent,expected);
 }
 assert.throws(()=>calculateFinancial({kind:'real_return',netReturnPercent:'5',inflationPercent:'-100'}),/CALCULATOR_INPUT_INVALID/);
});
test('closed bounded calculators reject missing, conflicting, foreign or unsupported inputs',()=>{
 for(const bad of [{...base,sql:'SELECT 1'},{...base,months:601},{...base,months:1.5},{...base,annualRatePercent:'current'},{...base,principalRubles:'12 34'},{...base,principalRubles:'1e6'},{...base,principalRubles:'0'},{...base,principalRubles:'-100'},{...base,prepayments:[{month:0,amountRubles:'1',strategy:'reduce_term'}]},{...base,rateChanges:[{month:2,annualRatePercent:'10'},{month:2,annualRatePercent:'11'}]}])assert.throws(()=>parseCalculatorInput(bad),/CALCULATOR_INPUT_INVALID/);
});
