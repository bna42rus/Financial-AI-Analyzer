import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {validateQuestionCatalog,renderQuestionCatalog,questionInputs,catalogUrl,documentUrl} from '../../../scripts/analyzer-question-catalog.mjs';
import {interfaceAction} from '../src/interface-actions.ts';

const corpus=JSON.parse(await readFile(catalogUrl,'utf8'));
test('acceptance inventory covers every Registry group without claiming real-model measurements',()=>{
 validateQuestionCatalog(corpus);assert.equal(corpus.cases.length,337);assert.equal(corpus.groups.length,23);
 for(const group of ['read','accounts','transactions','categories','rules','counterparties','budgets','analytics','overview','operations_ui','interface','history','imports','documents','calculators','fresh','review','safety'])assert.ok(corpus.groups.some(g=>g.id===group),group);
 assert.ok(corpus.cases.every(c=>c.measurement==='not_executed'));assert.equal(corpus.paidCalls,0);
 const copy=structuredClone(corpus);copy.cases.push({...copy.cases[0]});assert.throws(()=>validateQuestionCatalog(copy),/INVALID|DUPLICATE/);
});
test('all device questions correspond to finite actual commands; unsupported financial tools stay separate',()=>{
 for(const c of corpus.cases.filter(c=>c.route==='device'))assert.ok(interfaceAction(c.question),c.id+': '+c.question);
 assert.equal(corpus.cases.filter(c=>c.route==='blocked_fresh').length,10);
 assert.equal(corpus.cases.filter(c=>c.route==='blocked_document').length,8);
 assert.ok(corpus.cases.some(c=>c.route==='editor'));assert.ok(corpus.cases.some(c=>c.route==='unsupported'));
});
test('model input contains questions only, never goldens, routes or expected outcomes',()=>{
 const inputs=questionInputs(corpus);assert.equal(inputs.length,337);
 for(let i=0;i<inputs.length;i++)assert.deepEqual(inputs[i],{question:corpus.cases[i].question});
 assert.ok(inputs.every(i=>Object.keys(i).length===1));
});
test('owner document is reproducible and live flags cannot turn preparation into paid requests',async()=>{
 assert.equal(await readFile(documentUrl,'utf8'),renderQuestionCatalog(corpus));
 const cli=new URL('../../../scripts/analyzer-question-catalog.mjs',import.meta.url);
 const result=spawnSync(process.execPath,[cli.pathname,'--live'],{encoding:'utf8'});
 assert.notEqual(result.status,0);assert.match(result.stderr,/QUESTION_CATALOG_NO_LIVE_RUNNER/);
});
