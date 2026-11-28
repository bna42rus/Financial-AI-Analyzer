import {test} from 'node:test';
import assert from 'node:assert/strict';
import {analyzerLexicon,analyzerLexiconVersion,resolveLexeme} from '../src/next/lexicon.ts';
import {metrics,groupings} from '../../finance-core/src/overview.ts';
import {calculatorSchema} from '../src/calculators.ts';
import {sourceNameIndex} from '../src/next/source-literals.ts';
import {periodExpression,periodFacts} from '../src/next/period.ts';
import {paymentChoice,isLoanChartResume} from '../src/next/source-intent.ts';

const key=(family:string,word:string,typos=false)=>{
 const match=resolveLexeme(family,word,typos);assert.equal(match.status,'known',`${family}: ${word}`);
 if(match.status!=='known')throw Error('unknown');return match.key;
};
test('versioned lexicon covers every registered metric, grouping and calculator without ambiguous canonical entries',()=>{
 assert.equal(analyzerLexiconVersion,'cashneuro-analyzer-lexicon/1');
 const codes=analyzerLexicon.map(e=>e.family+':'+e.key);assert.equal(new Set(codes).size,codes.length);
 for(const entry of analyzerLexicon){assert.ok(entry.forms.length);assert.ok(entry.forms.includes(entry.canonical));assert.ok(Object.isFrozen(entry));assert.ok(Object.isFrozen(entry.forms));}
 const keys=(family:string)=>analyzerLexicon.filter(e=>e.family===family).map(e=>e.key).sort();
 assert.deepEqual(keys('metric'),[...metrics].sort());assert.deepEqual(keys('grouping'),[...groupings].sort());
 assert.deepEqual(keys('calculator'),calculatorSchema.anyOf.map(s=>(s.properties.kind as {enum:string[]}).enum[0]!).sort());
 for(const family of ['metric','grouping','calculator'])for(const entry of analyzerLexicon.filter(e=>e.family===family))assert.equal(key(family,entry.canonical),entry.key);
});
test('explicit forms, abbreviations and whole-word typos preserve the typed financial meaning',()=>{
 for(const [family,word,expected] of [
  ['entity_role','СЧЁТА','accounts'],['entity_role','подкатегориях','categories'],['entity_role','контрагентми','counterparties'],
  ['calendar_month','сент.','september'],['calendar_month','октябярь','october'],['calendar_month','февраля','february'],
  ['calendar_unit','мес.','month'],['time_relation','предыдущем','previous'],
  ['payment','дифиренцированный','differentiated'],['payment','аннуитентный','annuity'],
  ['metric','расхоодв','expenses'],['format','диаграммой','chart'],['format','графки','chart'],
 ] as const)assert.equal(key(family,word,true),expected);
 assert.equal(resolveLexeme('format','графки').status,'unknown');
 assert.equal(key('calendar_month','июнь',true),'june');assert.equal(key('calendar_month','июль',true),'july');
});
test('ambiguity and financial distinctions are retained instead of guessed',()=>{
 assert.deepEqual(resolveLexeme('financial_term','процент',true),{status:'ambiguous',keys:['interest','interest_rate']});
 assert.deepEqual(resolveLexeme('calendar_month','июрем',true),{status:'ambiguous',keys:['july','june']});
 for(const word of ['поступления','списания','остаток','наличные','переводы'])assert.equal(resolveLexeme('metric',word,true).status,'unknown',word);
 for(const [word,expected] of [['поступления','inflow'],['списания','outflow'],['остаток','balance'],['наличные','cash']] as const)assert.equal(key('financial_term',word),expected);
});
test('no approximate operators, negations, numeric values, IDs, partial words or arbitrary catalog names',()=>{
 for(const [family,word] of [
  ['operator','большо'],['operator','меньши'],['negation','бес'],['negation','включитильно'],
  ['payment','неаннуитетный'],['payment','безаннуитетного'],['calendar_month','июрь'],
  ['calendar_month','2025-10'],['calendar_month','октябрь 2026'],['metric','100.01'],
  ['entity_role','Учебный счёт'],['entity_role','Учебный'],['format','суперграфик'],
  ['format','t1_v2'],['format','г'.repeat(161)],['unknown','расходы'],
 ] as const)assert.equal(resolveLexeme(family,word,true).status,'unknown',family+':'+word);
 assert.equal(key('operator','строго больше',true),'strict_lower');assert.equal(key('operator','не больше',true),'inclusive_upper');
});
test('role typo recovery anchors an unchanged whole catalog name and preserves negative/list conditions',()=>{
 const names=['Учебный счёт','Кофе Ёж'];
 for(const [field,expression,question,index] of [
  ['accounts','со счета «Учебный счёт»','со счетаа «Учебный счёт»',0],
  ['categories','по катигории «Кофе Еж»','по категории «Кофе Ёж»',1],
  ['counterparties','у контрагента «Кофе Еж»','у контрагнта «Кофе Ёж»',1],
 ] as const)assert.equal(sourceNameIndex(field,expression,question,names),index);
 for(const question of ['не со счёта «Учебный счёт»','без счёта «Учебный счёт»','со счёта «Учебны счёт»','со счёта «Учебный счёт Плюс»'])assert.throws(()=>sourceNameIndex('accounts','со счёта «Учебный счёт»',question,names),/TASK_(?:EVIDENCE|ENTITY)/);
 assert.throws(()=>sourceNameIndex('accounts','со счетов «Учебный счёт» и «Кофе Ёж»','со счетов «Учебный счёт» и «Кофе Ёж»',names));
});
test('month words can vary while years, days, context and direction of time stay unchanged',()=>{
 const date='2026-11-28',previous={from:'2025-10-01',through:'2025-10-31'};
 for(const expression of ['октябярь 2025','за окт. 2025','за октябре 2025'])assert.deepEqual(periodExpression(expression,'За октябярь 2025 расходы',date),{from:'2025-10-01',through:'2025-10-31'});
 assert.deepEqual(periodExpression('2025-10-03/2025-10-17','С 3 по 17 октябяря 2025 включительно',date),{from:'2025-10-03',through:'2025-10-17'});
 assert.deepEqual(periodExpression('прошлом месяце','В прошлом месяце',date,previous),{from:'2026-10-01',through:'2026-10-31'});
 assert.deepEqual(periodExpression('текущем месяце','В текущем месяце',date,previous),{from:'2026-11-01',through:'2026-11-28'});
 assert.deepEqual(periodExpression('сент.','Сент.',date,previous),{from:'2025-09-01',through:'2025-09-30'});
 for(const [expression,question] of [
  ['2026-10','За октябярь 2025'],['2025-10','За октябярь 2024'],
  ['2025-10-03/2025-10-17','С 3 по 19 октябяря 2025'],['2025-10','За октябярь 2025 или сентябрь 2025'],
  ['июнь 2025','Июль 2025'],['2025-06','июрем 2025'],
 ] as const)assert.throws(()=>periodExpression(expression,question,date),/TASK_(?:PERIOD|EVIDENCE)/);
});
test('contextual payment and chart recognition accepts forms but not questions, negation or changed numbers',()=>{
 assert.equal(paymentChoice('А дифференцированную?')?.payment,'differentiated');
 for(const question of ['Что значит дифференцированный?','Не аннуитетный','аннуитетный 12','неаннуитетный'])assert.equal(paymentChoice(question),null);
 for(const question of ['Покажи диаграмму платежей того расчета кредита','Выведи графки платежей того расчета кредита'])assert.equal(isLoanChartResume(question),true,question);
 for(const question of ['Не покажи график расчета кредита','Покажи график платежей кредита 12%','Что такое график расчета кредита?'])assert.equal(isLoanChartResume(question),false,question);
});

test('calendar typo scanning cannot manufacture a period from a card or other words in a financial question',()=>{
 const date='2026-11-28';
 for(const question of ['Покажи расходы по карте','Покажи расходы по карет','Учебный счёт, карта'])assert.deepEqual(periodFacts(question,date),[],question);
 assert.equal(resolveLexeme('calendar_month','карте',true).status,'unknown');
 assert.deepEqual(periodExpression('2025-10','Покажи расходы по карте за 2025-10',date),{from:'2025-10-01',through:'2025-10-31'});
 assert.throws(()=>periodExpression('2025-03','Покажи расходы по карте 2025',date),/TASK_(?:EVIDENCE|PERIOD)/);
 assert.deepEqual(periodExpression('2026-10','А октябярь?',date),{from:'2026-10-01',through:'2026-10-31'});
});
