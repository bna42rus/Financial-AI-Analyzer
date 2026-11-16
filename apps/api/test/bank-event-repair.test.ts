import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {bankEventRepairs} from '../src/bank-event-repair.ts';
import {initialBankSemantics} from '../../../packages/finance-core/src/financial-evidence.ts';
import {initialSemantics,facet} from '../../../packages/finance-core/src/model.ts';
import type {Graph,Operation,BankFact} from '../../../packages/finance-core/src/model.ts';
import {applyMerchantRecognition} from '../../../packages/finance-core/src/merchant-recognition.ts';
import {operationDisplayName} from '../../../packages/finance-core/src/operation-name.ts';
import {aggregate,reconcile} from '../../../packages/finance-core/src/graph.ts';
import {extractSafeSource,sourceFields,merchantSourceSanitizer} from '../../../packages/imports/src/safe-source.ts';
import {createLocalPreparation} from '../../../packages/imports/src/local.ts';
import {localBankAdapter} from '../../../packages/imports/src/bank-table.ts';
import {parseBankPdf,pdfParserVersions} from '../../../packages/imports/src/bank-pdf.ts';
import {syntheticLayout} from '../../../packages/imports/test/synthetic-layout.ts';

const categories:Graph['categories']=[{id:'food',name:'Продукты',role:'expense',parentId:null,hidden:false}];
const graph=(operations:Operation[]):Graph=>({accounts:[{id:'account',bankId:'synthetic',name:'Synthetic',type:'bank_account',analyticsEnabled:true,defaultVisible:true,loanMode:null}],categories,operations,components:[],links:[],loanMode:'cashflow'});
function operation(description:string,amountMinor='-32100',old=false):Operation{
 const fields=sourceFields(extractSafeSource(description,amountMinor,merchantSourceSanitizer),merchantSourceSanitizer);
 const source:BankFact={...fields,accountId:'account',operationDate:{precision:'day',date:'2026-01-01'},postedDate:null,amountMinor,currency:'RUB',bankCategory:fields.bankCategory??'',bankRefHmac:null,versions:{sourceSanitizer:merchantSourceSanitizer,sourceTextEvidence:'intact'}};
 if(old){source.sourceKind='other';source.merchantText='';}
 return {id:randomUUID(),source,semantics:old?initialSemantics('other'):initialBankSemantics(source),corrections:{},comment:'',analyticsOverride:'default',decomposition:false,reviewReasons:[]};
}
const purchase='Оплата товаров по кредитной карте 0000 сумма 321.00 в VKUSVILL_1234_KCO_1 MOSCOW RU дата 2026- 01-01 время 10:00:00';
test('all three PDF layouts cross local preparation and classify using the complete bank wording',async()=>{
 for(const bank of ['ozon','sber','tbank'] as const){
  const text=bank==='ozon'?purchase:bank==='sber'?'Супермаркеты MOSCOW BRISTOL 1234. Операция по карте ****0000':'Оплата в VKUSVILL_1234_KCO_1 MOSCOW RUS';
  const layout=syntheticLayout(bank),x=bank==='ozon'?225:bank==='sber'?150:390;
  for(const item of layout[0]!)if(item.x===x&&(item.y===650||item.y===600))item.text=text;
  const parsed=parseBankPdf(randomUUID(),new TextEncoder().encode('synthetic only'),layout);
  parsed.rows=parsed.rows.slice(0,1).map(row=>({...row,parser:pdfParserVersions[bank]}));
  const local=await createLocalPreparation({contextId:randomUUID(),generation:randomUUID(),keyVersion:randomUUID(),key:Buffer.alloc(32,2).toString('base64url'),expiresAt:new Date(Date.now()+60000).toISOString()},undefined,localBankAdapter,merchantSourceSanitizer);
  try{
   const batch=await local.prepare(randomUUID(),[parsed]),row=batch.files[0]!.rows[0]!;
   assert.equal(row.safeSource?.event,'purchase',bank);assert.ok(row.safeSource?.details?.merchantText,bank);
   const op=applyMerchantRecognition(operation(row.safeSource!.details!.description,row.amountMinor),categories);
   assert.equal(op.semantics.role.value,'expense');assert.equal(op.semantics.category.value,'food');
   assert.equal(operationDisplayName(op).title,bank==='sber'?'BRISTOL':'VKUSVILL');
  }finally{local.dispose();}
 }
});
test('already imported rows repair without a reimport and without changing amounts, sources or identity',()=>{
 const op=operation(purchase,'-32100',true),before=structuredClone(op),g=graph([op]);
 const [next]=bankEventRepairs(g,[]);assert.ok(next);assert.deepEqual(op,before);assert.deepEqual(next.source,before.source);assert.equal(next.id,op.id);assert.deepEqual(next.corrections,op.corrections);
 assert.equal(next.semantics.kind.value,'purchase');assert.equal(next.semantics.category.value,'food');assert.equal(operationDisplayName(next).title,'VKUSVILL');
 assert.equal(aggregate(reconcile(graph([next])).operations).netExpensesMinor,'32100');
 assert.deepEqual(bankEventRepairs(graph([next]),[]),[]);
});
test('transfers stay unresolved and repayments never become purchase income',()=>{
 for(const amount of ['-50000','50000']){
  const transfer=operation('Перевод на карту С карты ****0000. Операция по карте ****0000',amount);
  assert.equal(transfer.semantics.kind.value,amount[0]==='-'?'transfer_out':'transfer_in');assert.equal(transfer.semantics.role.value,'unresolved');
 }
 const repayment=operation('Погашение кредита по **** КК-****','50000');assert.equal(repayment.semantics.kind.value,'credit_card_repayment');assert.equal(repayment.semantics.role.value,'neutral');
 assert.equal(aggregate(reconcile(graph([repayment])).operations).incomeMinor,'0');
 assert.equal(operation('Погашение процентов').semantics.role.value,'expense');
});
test('Bristol is a short merchant without inferring the actual purchased products',()=>{
 const op=applyMerchantRecognition(operation(purchase.replace('VKUSVILL_1234_KCO_1','BRISTOL 1234')),categories);
 assert.equal(operationDisplayName(op).title,'BRISTOL');assert.equal(op.semantics.category.value,'food');assert.equal(op.semantics.subcategory.value,null);
 const cafe=applyMerchantRecognition(operation('Оплата в Кафе Бристоль MOSCOW RUS'),categories);assert.equal(cafe.semantics.category.value,null);assert.equal(operationDisplayName(cafe).title,'Кафе Бристоль');
 assert.equal(operationDisplayName(operation('Оплата в Магазин 24 MOSCOW RUS')).title,'Магазин 24');
});
test('manual, verified and rule decisions plus components survive the repair',()=>{
 for(const source of ['user','personal_rule','global_rule','ai'] as const){
  const op=operation(purchase,'-32100',true);op.semantics.kind=facet('transfer_out',source,true);op.semantics.role=facet('neutral',source,true);op.semantics.merchant=facet('Моё название',source,true);op.semantics.category=facet('food',source,true);
  const [next]=bankEventRepairs(graph([op]),[]);if(next)assert.deepEqual(next.semantics,op.semantics);
 }
 const op=operation(purchase,'-32100',true);op.decomposition=true;assert.deepEqual(bankEventRepairs(graph([op]),[]),[]);
 const g=graph([operation(purchase,'-32100',true)]);g.components.push({id:'part',transactionId:g.operations[0]!.id,type:'other',amountMinor:'-32100',role:facet('expense'),category:facet(null),subcategory:facet(null)});assert.deepEqual(bankEventRepairs(g,[]),[]);
});
test('unknown, sign-conflicting, hidden-boundary and legacy descriptions do not gain authority',()=>{
 for(const text of ['BRISTOL','Не покупка BRISTOL','Ожидается оплата в BRISTOL'])assert.equal(operation(text).semantics.kind.value,'other');
 assert.equal(operation(purchase,'32100').semantics.kind.value,'other');
 const op=operation(purchase,'-32100',true);op.source.versions.sourceTextEvidence='unknown';assert.deepEqual(bankEventRepairs(graph([op]),[]),[]);op.source.versions={sourceSanitizer:'bank-source/4'};assert.deepEqual(bankEventRepairs(graph([op]),[]),[]);
 assert.equal(operation('Оплата услуг бюро переводов Север').semantics.kind.value,'purchase');
 assert.equal(operation('Доплата за продление рассрочки в текущем периоде').semantics.kind.value,'fee');
 assert.equal(operation('Компенсация покупки','32100').semantics.role.value,'unresolved');
});
