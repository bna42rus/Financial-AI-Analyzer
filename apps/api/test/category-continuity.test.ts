import {test} from 'node:test';import assert from 'node:assert/strict';
import {categoryContinuity} from '../src/category-continuity.ts';
import type {Graph} from '../../../packages/finance-core/src/model.ts';
const graph=():Graph=>({accounts:[],operations:[],components:[],links:[],loanMode:'cashflow',categories:[{id:'root',name:'Продукты',parentId:null,role:'expense',hidden:false},{id:'leaf',name:'Магазины',parentId:'root',role:'expense',hidden:false}]});
test('a rename retains the previous category meaning by ID without a new category',()=>{const g=graph(),before=structuredClone(g),bindings=categoryContinuity(g,'root');assert.ok(bindings.some(b=>b.categoryId==='root'));assert.deepEqual(g,before);assert.equal(g.categories.length,2);});
test('explicit private bindings have precedence; duplicate category names are not chosen by order',()=>{const g=graph();g.categories.push({...g.categories[0]!,id:'second'});g.categories.push({...g.categories[1]!,id:'second-leaf',parentId:'second'});assert.equal(categoryContinuity(g,'root').length,0);});
