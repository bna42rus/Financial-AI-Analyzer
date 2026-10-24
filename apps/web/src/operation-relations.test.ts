import {test,expect} from 'vitest';
import {facet} from '../../../packages/finance-core/src/model';
import {syntheticDetail} from '../test/synthetic-finance';
import {componentDrafts,componentsIntent,endpoints,linkIntent,newComponent} from './operation-relations';

test('signed parts must exactly replace the effective amount; cents and overflow are checked',()=>{
 const d=syntheticDetail(),a={...newComponent(),amount:'-80,01'},b={...newComponent(),amount:'-19,99'};
 expect(componentsIntent(d,[a,b])).toMatchObject({parts:[{amountMinor:'-8001'},{amountMinor:'-1999'}]});
 expect(()=>componentsIntent(d,[a,{...b,amount:'-19,98'}])).toThrow('точно совпадать');
 expect(()=>componentsIntent(d,[{...a,amount:'-92233720368547758,09'}])).toThrow('диапазон');
 expect(componentsIntent(d,[])).toEqual({kind:'components',id:d.id,parts:[]});
});
test('existing component IDs and automatic decisions remain distinct from explicit verification',()=>{
 const d=syntheticDetail(),id=crypto.randomUUID();d.components=[{id,transactionId:d.id,type:'principal',amountMinor:'-10000',role:facet('neutral'),category:facet(null,'bank'),subcategory:facet(null)}];
 const drafts=componentDrafts(d);expect(drafts[0]?.role).toBe('auto');
 expect(componentsIntent(d,drafts)).toEqual({kind:'components',id:d.id,parts:[{id,type:'principal',amountMinor:'-10000'}]});
 drafts[0]!.role='expense';drafts[0]!.categoryConfirmed=true;
 expect(componentsIntent(d,drafts)).toMatchObject({parts:[{id,role:'expense',categoryId:null}]});
});
test('endpoints use opaque persisted selectors, preferring allocation over component provenance',()=>{
 const d=syntheticDetail(),componentId=crypto.randomUUID(),allocationId=crypto.randomUUID();
 d.projection.parts=[{...d.projection.parts[0]!,id:'opaque:unrelated',componentId,allocationId},{...d.projection.parts[0]!,id:'do not parse this',componentId,allocationId:null}];
 const es=endpoints(d.projection);expect(es.map(e=>[e.componentId,e.allocationId])).toEqual([[null,allocationId],[componentId,null]]);
 const missing=crypto.randomUUID();expect(endpoints(d.projection,{componentId:null,allocationId:missing}).at(-1)).toMatchObject({allocationId:missing,componentId:null,current:true});
});
test('link amounts are positive and references cannot bind an operation to itself',()=>{
 const a=syntheticDetail(),b=syntheticDetail(),se=endpoints(a.projection)[0]!,te=endpoints(b.projection)[0]!;
 expect(()=>linkIntent(crypto.randomUUID(),'refund','confirmed','-10',a.projection,b.projection,se,te)).toThrow('положительной');
 expect(()=>linkIntent(crypto.randomUUID(),'refund','confirmed','0',a.projection,b.projection,se,te)).toThrow('положительной');
 expect(()=>linkIntent(crypto.randomUUID(),'refund','confirmed','10',a.projection,a.projection,se,se)).toThrow('разные');
 expect(linkIntent(crypto.randomUUID(),'refund','candidate','10,01',a.projection,b.projection,se,te)).toMatchObject({link:{amountMinor:'1001',status:'candidate',sourceAllocationId:null,targetComponentId:null}});
});

test('purchase splitting accepts positive amounts, tracks the exact remainder and writes only signed analytic parts',async()=>{
 const {purchaseDrafts,newPurchasePart,purchaseBalance,purchaseRemainder,purchaseSplitIntent}=await import('./operation-relations');
 const detail=syntheticDetail(),before=structuredClone(detail),drafts=purchaseDrafts(detail);
 expect(drafts[0]!.amount).toBe('100,00');drafts[0]!.amount='60,01';drafts[0]!.categoryId='food';drafts.push({...newPurchasePart(),categoryId:'clothes'});
 expect(purchaseBalance(detail,drafts)).toMatchObject({total:'10000',assigned:'6001',remaining:'3999',invalid:false});
 drafts[1]!.amount=purchaseRemainder(detail,drafts,drafts[1]!.id);expect(drafts[1]!.amount).toBe('39,99');
 const intent=purchaseSplitIntent(detail,drafts);expect(intent).toMatchObject({kind:'components',id:detail.id,parts:[{amountMinor:'-6001',role:'expense',type:'other',categoryId:'food'},{amountMinor:'-3999',role:'expense',categoryId:'clothes'}]});expect(detail).toEqual(before);
 expect(()=>purchaseSplitIntent(detail,[{...drafts[0]!,amount:'-100'}])).toThrow('без знака минус');expect(()=>purchaseSplitIntent(detail,[{...drafts[0]!,amount:'0'}])).toThrow('больше нуля');expect(()=>purchaseSplitIntent(detail,[{...drafts[0]!,amount:'99,99'}])).toThrow('точно совпадать');
 expect(purchaseSplitIntent(detail,[])).toMatchObject({parts:[]});
});
