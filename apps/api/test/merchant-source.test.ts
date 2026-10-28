import {test} from 'node:test';
import assert from 'node:assert/strict';
import {resolveSourceText} from '../src/import-source.ts';
import {classificationSignal} from '../src/classification-plan.ts';
import {extractSafeSource,sourceFields,merchantSourceSanitizer,descriptionSourceSanitizer,localSourceSanitizer} from '../../../packages/imports/src/safe-source.ts';
import {initialSemantics,facet} from '../../../packages/finance-core/src/model.ts';
import type {BankFact,Graph,Operation} from '../../../packages/finance-core/src/model.ts';
import {applyMerchantRecognition} from '../../../packages/finance-core/src/merchant-recognition.ts';

const old=extractSafeSource('Покупка PYATEROCHKA MOSCOW RUS','-100',descriptionSourceSanitizer)!;
const fresh=extractSafeSource('Покупка PYATEROCHKA MOSCOW RUS','-100',merchantSourceSanitizer)!;
const fact:BankFact={accountId:'a',operationDate:{precision:'day',date:'2026-10-01'},postedDate:null,amountMinor:'-100',currency:'RUB',...sourceFields(fresh,merchantSourceSanitizer),bankCategory:'',bankRefHmac:null,versions:{sourceSanitizer:merchantSourceSanitizer,sourceTextEvidence:'intact'}};
type Evidence=Parameters<typeof resolveSourceText>[3][number];
const row=(id:string,profile:string,source:typeof fresh):Evidence=>({id,transaction_id:'o',evidence_recorded:true,source_evidence:source,source_kind:source.event,merchant_text:sourceFields(source,profile).merchantText,description:sourceFields(source,profile).description,source_profile:profile});

test('source reconstruction respects each observation profile and cancellation restores only remaining evidence',()=>{
 const rows=[row('old',descriptionSourceSanitizer,old),row('new',merchantSourceSanitizer,fresh)],snapshot=structuredClone(rows);
 const selected=resolveSourceText(fact,'o','new',rows);assert.equal(selected.merchantText,'PYATEROCHKA MOSCOW RUS');assert.equal(selected.versions.sourceSanitizer,merchantSourceSanitizer);
 const cancelled=resolveSourceText(fact,'o','old',rows.slice(0,1));assert.equal(cancelled.merchantText,'Пятёрочка');assert.equal(cancelled.versions.sourceSanitizer,descriptionSourceSanitizer);assert.equal(cancelled.versions.sourceTextEvidence,undefined);
 assert.deepEqual(rows,snapshot);assert.equal(fact.merchantText,'PYATEROCHKA MOSCOW RUS');
 const foreign={...rows[1]!,transaction_id:'another-operation'};
 assert.equal(resolveSourceText(fact,'o','old',[rows[0]!,foreign]).merchantText,'Пятёрочка');
});

test('later finite evidence cannot retransliterate an inherited /5 source and removal does not preserve a ghost profile',()=>{
 const legacy=extractSafeSource('Покупка PYATEROCHKA MOSCOW RUS','-100',localSourceSanitizer)!;
 const rows=[row('new',merchantSourceSanitizer,fresh),row('finite',localSourceSanitizer,legacy)];
 const selected=resolveSourceText(fact,'o','finite',rows);assert.equal(selected.merchantText,'PYATEROCHKA MOSCOW RUS');assert.equal(selected.versions.sourceSanitizer,merchantSourceSanitizer);
 const cancelled=resolveSourceText(fact,'o','finite',[rows[1]!]);assert.equal(cancelled.merchantText,'Пятёрочка');assert.equal(cancelled.versions.sourceSanitizer,localSourceSanitizer);assert.equal(cancelled.versions.sourceTextEvidence,undefined);
});

test('rebuilding from sanitized evidence retains lost-boundary status, not a newly invented intact claim',()=>{
 const source=extractSafeSource('Покупка AP\u200bTEKA Ромашка','-100',merchantSourceSanitizer)!;
 const current=resolveSourceText(fact,'o','unsafe',[row('unsafe',merchantSourceSanitizer,source)]);
 assert.equal(current.versions.sourceTextEvidence,'unknown');
 const operation={id:'o',source:current,corrections:{},semantics:initialSemantics('purchase',current.merchantText),comment:'',analyticsOverride:'default',decomposition:false,reviewReasons:[]} as Operation;
 const graph:Graph={accounts:[{id:'a',bankId:'tbank',name:'Счёт',type:'bank_account',analyticsEnabled:true,defaultVisible:true,loanMode:null}],categories:[],operations:[operation],components:[],links:[],loanMode:'cashflow'};
 assert.equal(classificationSignal(operation,graph),null);assert.deepEqual(applyMerchantRecognition(operation,[]),operation);
});

test('new source script is available to classification but automatic recognition cannot write a display name over matching',()=>{
 const operation:Operation={id:'o',source:structuredClone(fact),corrections:{},semantics:initialSemantics('purchase',fact.merchantText),comment:'Моя заметка',analyticsOverride:'default',decomposition:false,reviewReasons:['possible_duplicate']};
 const graph:Graph={accounts:[{id:'a',bankId:'tbank',name:'Счёт',type:'bank_account',analyticsEnabled:true,defaultVisible:true,loanMode:null}],categories:[{id:'food',name:'Продукты',parentId:null,hidden:false,role:'expense'}],operations:[operation],components:[],links:[],loanMode:'cashflow'};
 assert.equal(classificationSignal(operation,graph)!.merchant,'PYATEROCHKA MOSCOW RUS');
 const before=structuredClone(operation),recognized=applyMerchantRecognition(operation,graph.categories);
 assert.deepEqual(operation,before);assert.deepEqual(recognized.source,before.source);assert.deepEqual(recognized.semantics.merchant,before.semantics.merchant);assert.equal(recognized.semantics.category.value,'food');
 operation.semantics.category=facet('my-private','user',true);operation.semantics.merchant=facet('Моё имя','user',true);
 assert.equal(classificationSignal(operation,graph),null);assert.deepEqual(applyMerchantRecognition(operation,graph.categories).semantics,operation.semantics);
});
