import {test} from 'node:test';
import assert from 'node:assert/strict';
import {initialSemantics,facet,dateFact,operationDay} from '../src/model.ts';
import type {Graph,Operation,Kind,Link,Component,Role} from '../src/model.ts';
import {reconcile,aggregate} from '../src/graph.ts';
import {applyRules,validateRule} from '../src/rules.ts';
import type {Rule} from '../src/rules.ts';
import {sanitizeText,safeText} from '../../privacy/src/text.ts';
const graph=():Graph=>({accounts:[{id:'bank',bankId:'synthetic',name:'Synthetic',type:'bank_account',analyticsEnabled:true,defaultVisible:true,loanMode:null}],categories:[{id:'food',name:'Food',parentId:null,role:'expense',hidden:false},{id:'clothes',name:'Clothes',parentId:null,role:'expense',hidden:false},{id:'salary',name:'Salary',parentId:null,role:'income',hidden:false}],operations:[],components:[],links:[],loanMode:'cashflow'});
test('account matching assignments preserve bank facts and independent correction priority',()=>{
 const g=graph(),a=op('assigned','-1000');g.accounts.push({...g.accounts[0]!,id:'destination',analyticsEnabled:false});a.accountAssignmentId='destination';g.operations=[a];
 assert.equal(reconcile(g).operations[0]!.accountId,'destination');assert.equal(aggregate(reconcile(g).operations).netExpensesMinor,'0');assert.equal(a.source.accountId,'bank');
 a.corrections.accountId='bank';assert.equal(reconcile(g).operations[0]!.accountId,'bank');assert.equal(aggregate(reconcile(g).operations).netExpensesMinor,'1000');assert.equal(a.accountAssignmentId,'destination');
});
test('future rule matching uses assigned account while the original source remains unchanged',()=>{
 const a=op('assigned','-1000');a.accountAssignmentId='destination';const account={...graph().accounts[0]!,id:'destination'};
 const rule:Rule={id:'scope',name:'Scoped',enabled:true,priority:0,conditions:{accountId:'destination'},assignments:{role:'neutral'}};
 const classified=applyRules(a,account,[rule]);assert.equal(classified.semantics.role.value,'neutral');assert.equal(classified.source.accountId,'bank');assert.equal(classified.accountAssignmentId,'destination');
});
function op(id:string,amount:string,kind:Kind='purchase',category:string|null='food',day='2026-09-01'):Operation{const semantics=initialSemantics(kind,'Synthetic shop');semantics.category=facet(category);return {id,source:{accountId:'bank',operationDate:{precision:'day',date:day},postedDate:null,amountMinor:amount,currency:'RUB',merchantText:'Synthetic shop',description:'Safe example',bankCategory:'',bankRefHmac:null,versions:{parser:'test',normalizer:'test',sanitizer:'test'}},corrections:{},semantics,comment:'',analyticsOverride:'default',decomposition:false,reviewReasons:[]};}
function link(id:string,sourceId:string,targetId:string,amount:string,kind:Link['kind']='refund'):Link{return {id,sourceId,targetId,amountMinor:amount,kind,sourceComponentId:null,targetComponentId:null,status:'confirmed',confidence:100,createdBy:'user'};}
function part(id:string,parent:string,amount:string,role:Role,type:Component['type']='other'):Component{return {id,transactionId:parent,type,amountMinor:amount,role:facet(role),category:facet('food'),subcategory:facet(null)};}
test('refund is a reduction in its own bank date, never new income',()=>{
 const g=graph();g.operations=[op('purchase','-1000000'),op('refund','1000000','refund',null,'2026-10-01')];g.links=[link('refund-link','refund','purchase','1000000')];const p=reconcile(g).operations;
 assert.equal(aggregate(p,{from:'2026-09-01',through:'2026-09-30'}).netExpensesMinor,'1000000');const october=aggregate(p,{from:'2026-10-01'});assert.equal(october.netExpensesMinor,'-1000000');assert.equal(october.incomeMinor,'0');assert.equal(aggregate(p).netExpensesMinor,'0');
});
test('one refund allocated across categories retains an unresolved remainder',()=>{
 const g=graph();g.operations=[op('food','-600000'),op('clothes','-400000','purchase','clothes'),op('refund','1000000','refund',null)];g.links=[link('f','refund','food','600000')];let r=reconcile(g),refund=r.operations.find(o=>o.id==='refund')!;
 assert.equal(refund.unresolvedMinor,'400000');assert.ok(refund.reviewReasons.includes('unlinked_refund'));assert.equal(aggregate(r.operations).incomeMinor,'0');
 g.links.push(link('c','refund','clothes','400000'));r=reconcile(g);assert.equal(r.operations.find(o=>o.id==='refund')!.parts.length,2);assert.equal(aggregate(r.operations).netExpensesMinor,'0');
});
test('refund category follows its purchase unless the source is manually verified',()=>{
 const g=graph();g.operations=[op('p','-1000'),op('r','1000','refund',null)];g.links=[link('l','r','p','1000')];g.operations[0]!.semantics.category=facet('clothes','user',true);assert.equal(reconcile(g).operations[1]!.parts[0]!.categoryId,'clothes');
 g.operations[1]!.semantics.category=facet('food','user',true);assert.equal(reconcile(g).operations[1]!.parts[0]!.categoryId,'food');
});
test('partial own transfer never guesses the remaining money to be a fee',()=>{
 const g=graph();g.operations=[op('out','-1500000','transfer_out',null),op('in','1000000','transfer_in',null)];g.links=[link('l','out','in','1000000','own_transfer')];const p=reconcile(g).operations;assert.equal(p[0]!.unresolvedMinor,'500000');assert.equal(aggregate(p).grossExpensesMinor,'0');assert.equal(p[1]!.neutralMinor,'1000000');assert.equal(aggregate(p).attentionIds.length,1);
});
test('own transfer does not hide an independently known fee component',()=>{
 const g=graph();const out=op('out','-100500','transfer_out',null);out.decomposition=true;g.operations=[out,op('in','100000','transfer_in',null)];g.components=[part('principal','out','-100000','unresolved'),part('fee','out','-500','expense','fee')];g.links=[{...link('l','out','in','100000','own_transfer'),sourceComponentId:'principal'}];const p=reconcile(g).operations;assert.equal(aggregate(p).netExpensesMinor,'500');assert.equal(p[0]!.unresolvedMinor,'0');
});
test('bank facts survive effective corrections and sum conflicts suspend the decomposition',()=>{
 const g=graph(),o=op('p','-2500000','loan_payment');o.decomposition=true;g.operations=[o];g.components=[part('principal','p','-2000000','neutral','principal'),part('interest','p','-450000','expense','interest'),part('insurance','p','-50000','expense','insurance')];g.loanMode='economic';assert.equal(aggregate(reconcile(g).operations).netExpensesMinor,'500000');
 g.loanMode='cashflow';assert.equal(aggregate(reconcile(g).operations).netExpensesMinor,'2500000');o.corrections.amountMinor='-2400000';const p=reconcile(g).operations;assert.equal(o.source.amountMinor,'-2500000');assert.equal(p[0]!.unresolvedMinor,'2400000');assert.equal(aggregate(p).netExpensesMinor,'0');
});
test('active same-role components replace the parent amount',()=>{
 const g=graph(),o=op('p','-10000');o.decomposition=true;g.operations=[o];g.components=[part('a','p','-6000','expense'),part('b','p','-4000','expense')];assert.equal(aggregate(reconcile(g).operations).netExpensesMinor,'10000');
});
test('refund, reimbursement and expense reversal share a target capacity',()=>{
 const g=graph();g.operations=[op('p','-10000'),op('r','6000','refund',null),op('c','5000','transfer_in',null)];g.links=[link('r','r','p','6000'),link('c','c','p','5000','expense_reimbursement')];const r=reconcile(g);assert.equal(r.links.every(l=>!l.active),true);assert.equal(aggregate(r.operations).netExpensesMinor,'10000');
});
test('a new source amount does not silently shrink a confirmed allocation',()=>{
 const g=graph();g.operations=[op('p','-100000'),op('r','100000','refund',null)];g.links=[link('l','r','p','100000')];g.operations[0]!.source.amountMinor='-90000';const r=reconcile(g);assert.equal(r.links[0]!.reason,'CAPACITY_CONFLICT');assert.equal(g.links[0]!.amountMinor,'100000');assert.equal(g.links[0]!.status,'confirmed');assert.equal(r.operations[1]!.unresolvedMinor,'100000');
 g.operations[0]!.corrections.amountMinor='-100000';assert.equal(reconcile(g).links[0]!.active,true);
});
test('candidate and rejected links have no effect',()=>{
 for(const status of ['candidate','rejected']as const){const g=graph();g.operations=[op('p','-1000'),op('r','1000','refund',null)];g.links=[{...link('l','r','p','1000'),status}];assert.equal(aggregate(reconcile(g).operations).netExpensesMinor,'1000');}
});
test('user-verified financial meaning is never overwritten by a confirmed link',()=>{
 const g=graph();const o=op('out','-1000','transfer_out');o.semantics.role=facet('expense','user',true);g.operations=[o,op('in','1000','transfer_in',null)];g.links=[link('l','out','in','1000','own_transfer')];assert.equal(reconcile(g).links[0]!.reason,'VERIFIED_FACET_CONFLICT');assert.equal(aggregate(reconcile(g).operations).netExpensesMinor,'1000');
});
test('reversal of income reduces income and uses its own period',()=>{
 const g=graph(),salary=op('i','5000000','transfer_in','salary'),reversal=op('r','-5000000','reversal',null,'2026-10-01');salary.semantics.role=facet('income','user',true);g.operations=[salary,reversal];g.links=[link('l','r','i','5000000','reversal')];const p=reconcile(g).operations;assert.equal(aggregate(p,{from:'2026-10-01'}).incomeMinor,'-5000000');assert.equal(aggregate(p).netExpensesMinor,'0');
});
test('cash and loan proceeds are neutral; an unlinked refund is unresolved',()=>{
 const g=graph();g.operations=[op('a','-1000','cash_withdrawal'),op('b','1000','cash_deposit'),op('c','10000','loan_disbursement'),op('d','1000','refund',null)];const s=aggregate(reconcile(g).operations);assert.equal(s.incomeMinor,'0');assert.equal(s.netExpensesMinor,'0');assert.equal(s.unresolvedMinor,'1000');
});
test('credit-card repayment capacity is independent of a purchase refund',()=>{
 const g=graph();g.accounts[0]!.type='credit_card';g.operations=[op('p','-10000'),op('pay','-10000','credit_card_repayment'),op('r','10000','refund',null)];g.links=[link('pay','pay','p','10000','credit_card_repayment'),link('r','r','p','10000')];const r=reconcile(g);assert.equal(r.links.every(l=>l.active),true);assert.equal(aggregate(r.operations).netExpensesMinor,'0');
});
test('excluding a purchase never silently excludes its refund, and a specific include wins',()=>{
 const g=graph();g.operations=[op('p','-1000'),op('r','1000','refund',null)];g.links=[link('l','r','p','1000')];g.operations[0]!.analyticsOverride='exclude';assert.equal(aggregate(reconcile(g).operations).netExpensesMinor,'-1000');g.accounts[0]!.analyticsEnabled=false;g.operations[0]!.analyticsOverride='include';assert.equal(aggregate(reconcile(g).operations).netExpensesMinor,'1000');assert.equal(aggregate(reconcile(g).operations,{includeExcluded:true}).netExpensesMinor,'0');
});
test('date-only sources retain precision, and instant periods use Moscow calendar dates',()=>{
 assert.deepEqual(dateFact({precision:'day',date:'2026-02-28'}),{precision:'day',date:'2026-02-28'});assert.throws(()=>dateFact({precision:'day',date:'2026-02-30'}));assert.equal(operationDay(dateFact({precision:'instant',instant:'2026-09-30T22:00:00Z'})),'2026-10-01');
});
test('money above JS safe integer stays exact through aggregation',()=>{
 const g=graph();g.operations=[op('p','-9007199254740993'),op('q','-9007199254740993')];assert.equal(aggregate(reconcile(g).operations).netExpensesMinor,'18014398509481986');
});
test('more specific future rules win while verified facets and bank technical kind survive',()=>{
 const g=graph(),o=op('p','-1000');o.semantics.category=facet('food','user',true);const rules:Rule[]=[{id:'broad',name:'Broad',enabled:true,priority:100,conditions:{merchantContains:'shop'},assignments:{categoryId:'clothes',role:'neutral',kind:'other'}},{id:'specific',name:'Specific',enabled:true,priority:0,conditions:{merchantContains:'shop',direction:'out'},assignments:{role:'expense'}}];const r=applyRules(o,g.accounts[0]!,rules);assert.equal(r.semantics.category.value,'food');assert.equal(r.semantics.kind.value,'purchase');assert.equal(r.semantics.role.value,'expense');assert.equal(o.semantics.role.source,'deterministic_system_rule');
});
test('equally specific contradictory rules require review instead of picking an arbitrary winner',()=>{
 const g=graph(),o=op('p','-1000'),base={name:'Rule',enabled:true,priority:0,conditions:{merchantContains:'shop'}};const r=applyRules(o,g.accounts[0]!,[{...base,id:'a',assignments:{role:'expense'}},{...base,id:'b',assignments:{role:'neutral'}}]);assert.ok(r.reviewReasons.includes('conflicting_rules'));assert.equal(r.semantics.role.value,'expense');assert.throws(()=>validateRule({...base,conditions:{},assignments:{role:'expense'}}));
});
test('shared text guard removes known identifiers locally and rejects them at the server boundary',()=>{
 const raw='Оплата карта 1234 5678 9012 3456';assert.equal(sanitizeText(raw).includes('1234'),false);assert.throws(()=>safeText(raw));assert.equal(safeText('Алексей И. — аренда'),'Алексей И. — аренда');
});
test('low-confidence category is undefined without removing a known expense from totals',()=>{
 const g=graph(),o=op('p','-1000');o.semantics.category=facet('food','ai',false,69);g.operations=[o];const p=reconcile(g).operations,s=aggregate(p);assert.equal(s.netExpensesMinor,'1000');assert.equal(s.categories[0]!.id,null);assert.ok(p[0]!.reviewReasons.includes('low_category_confidence'));
});
test('category threshold and independent manual verification have different effects',()=>{
 const g=graph(),o=op('p','-1000');g.operations=[o];o.semantics.category=facet('food','ai',false,70);assert.ok(reconcile(g).operations[0]!.reviewReasons.includes('low_category_confidence'));o.semantics.category=facet('food','ai',false,90);assert.equal(reconcile(g).operations[0]!.reviewReasons.includes('low_category_confidence'),false);o.semantics.category=facet('food','user',true,30);assert.equal(reconcile(g).operations[0]!.parts[0]!.categoryId,'food');assert.equal(reconcile(g).operations[0]!.reviewReasons.includes('low_category_confidence'),false);
});
test('an allocation to a decomposed purchase requires the exact component endpoint',()=>{
 const g=graph(),p=op('p','-1000');p.decomposition=true;g.operations=[p,op('r','600','refund',null)];g.components=[part('a','p','-600','expense'),part('b','p','-400','expense')];g.links=[link('l','r','p','600')];assert.equal(reconcile(g).links[0]!.active,false);g.links[0]!.targetComponentId='a';assert.equal(reconcile(g).links[0]!.active,true);assert.equal(aggregate(reconcile(g).operations).netExpensesMinor,'400');
});
test('a component ID equal to another transaction ID cannot share its capacity pool',()=>{
 const g=graph(),split=op('split','-1000','transfer_out',null);split.decomposition=true;g.operations=[op('same','-1000','transfer_out',null),split,op('in','50','transfer_in',null),op('a','100','transfer_in',null),op('b','100','transfer_in',null)];g.components=[part('same','split','-100','unresolved'),part('fee','split','-900','expense','fee')];g.links=[link('root','same','in','50','own_transfer'),{...link('a','split','a','100','own_transfer'),sourceComponentId:'same'},{...link('b','split','b','100','own_transfer'),sourceComponentId:'same'}];const r=reconcile(g);assert.equal(r.links.find(l=>l.id==='root')!.active,true);assert.equal(r.links.find(l=>l.id==='a')!.reason,'CAPACITY_CONFLICT');assert.equal(r.links.find(l=>l.id==='b')!.reason,'CAPACITY_CONFLICT');
});
test('a contradictory automatic subcategory requires review without hiding a known expense',()=>{
 const g=graph();g.categories.push({id:'bad-sub',name:'Income child',parentId:'food',role:'income',hidden:false});const p=op('p','-1000');p.semantics.subcategory=facet('bad-sub','personal_rule');g.operations=[p];const r=reconcile(g).operations;assert.equal(r[0]!.parts[0]!.subcategoryId,null);assert.ok(r[0]!.reviewReasons.includes('category_conflict'));assert.equal(aggregate(r).netExpensesMinor,'1000');
});
