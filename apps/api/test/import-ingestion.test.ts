import {test,before,after,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import {postgresFixture} from './postgres.ts';
import {createServer} from '../src/server.ts';
import {hashPassword,token,envelope} from '../src/crypto.ts';
import {acceptCounterpartyObservation,prepareFinance,prepareImportContext} from '../src/finance.ts';
import {processImport,importStatus,runImportStage,IMPORT_CHUNK} from '../src/import-ingestion.ts';
import {createLocalPreparation} from '../../../packages/imports/src/local.ts';
import type {ExtractedRow,LocalContext} from '../../../packages/imports/src/local.ts';
import type {PreparedBatch} from '../../../packages/imports/src/contract.ts';
import {sourceSanitizer} from '../../../packages/imports/src/safe-source.ts';
import {descriptionSourceSanitizer,localSourceSanitizer} from '../../../packages/imports/src/safe-source.ts';
import {localBankAdapter,parseBankTable,csvTable} from '../../../packages/imports/src/bank-table.ts';
import {parseBankPdf,pdfParserVersions} from '../../../packages/imports/src/bank-pdf.ts';
import {syntheticLayout} from '../../../packages/imports/test/synthetic-layout.ts';
import type {Config} from '../src/types.ts';
let pg:Awaited<ReturnType<typeof postgresFixture>>,server:Awaited<ReturnType<typeof createServer>>,control:Awaited<ReturnType<typeof createServer>>,fc:Config,cookie:string;
const password='Synthetic import password 123!',account='00000000000000000001';
before(async()=>{pg=await postgresFixture();fc={profile:'finance',pool:pg.finance,baseURL:'https://api.example.test',origin:'https://app.example.test',authSecret:token(),wrappingKey:randomBytes(32),environment:'test'};server=await createServer(fc);control=await createServer({...fc,profile:'control',pool:pg.control});});
after(async()=>{await server?.close();await control?.close();await pg?.close();});
async function within<T>(user:string,fn:(db:PoolClient)=>Promise<T>){const db=await pg.finance.connect();try{await db.query('BEGIN');await prepareFinance(db,user);const r=await fn(db);await db.query('COMMIT');return r;}catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}}
async function seed(id:string){await pg.owner.query("INSERT INTO identity.auth_user(id,name,email,email_verified,created_at,updated_at) VALUES($1,'Synthetic user',$2,true,now(),now())",[id,id+'@example.test']);await pg.owner.query("INSERT INTO identity.auth_account(id,user_id,account_id,provider_id,password,created_at,updated_at) VALUES($1,$2,$2,'credential',$3,now(),now())",[randomUUID(),id,await hashPassword(password)]);await pg.owner.query('INSERT INTO identity.security_state(user_id,indefinite) VALUES($1,true)',[id]);}
beforeEach(async()=>{await pg.owner.query('TRUNCATE identity.auth_user,identity.rate_limit,identity.outbox,commerce.access_cycle,finance.workspace CASCADE');await seed('first');await seed('second');const r=await server.fastify.inject({method:'POST',url:'/auth/sign-in/email',payload:{email:'first@example.test',password},headers:{origin:fc.origin,'content-type':'application/json'}});assert.equal(r.statusCode,200,r.body);cookie=r.cookies.map(c=>c.name+'='+c.value).join('; ');});
function request(path:string,payload?:unknown,overrides:Record<string,string>={}){return server.fastify.inject({method:payload===undefined?'GET':'POST',url:path,...(payload===undefined?{}:{payload:payload as Record<string,unknown>}),headers:{origin:fc.origin,cookie,...(payload===undefined?{}:{'content-type':'application/json'}),...overrides}});}
async function context():Promise<LocalContext>{const r=await request('/finance/import-context',{contextId:randomUUID()});assert.equal(r.statusCode,200,r.body);return r.json();}
function row(overrides:Partial<ExtractedRow>={}):ExtractedRow{return {operationDate:{precision:'day',date:'2026-09-01'},amountMinor:'-100',currency:'RUB',direction:'debit',account:{kind:'bank_account',value:account},bankReference:'Synthetic-1',...overrides};}
async function batch(rows=[row()],bytes='Synthetic statement bytes',c?:LocalContext){const local=await createLocalPreparation(c??await context());try{return await local.prepare(randomUUID(),[{fileId:randomUUID(),bank:'tbank',bytes:new TextEncoder().encode(bytes),rows,filename:'Private local filename',password:'Private local password'}]);}finally{local.dispose();}}
async function accept(b:PreparedBatch){const r=await request('/finance/import-accept',b);assert.equal(r.statusCode,202,r.body);return r.json();}
async function status(id:string){return within('first',db=>importStatus(db,'first',{batchId:id}));}
async function drain(id:string){for(let n=0;n<30;n++){const s=await status(id);if(!['accepted','processing'].includes(s.status))return s;await within('first',db=>processImport(db,'first',id));}throw new Error('Synthetic import did not finish');}
async function command(intent:unknown){const e=(await request('/finance/epoch')).json(),actionId=randomUUID(),p=await request('/finance/preview',{actionId,generation:e.generation,revision:e.revision,intent});assert.equal(p.statusCode,200,p.body);const c=await request('/finance/commit',{actionId,...((intent as {kind:string}).kind==='reset_financial'?{confirmReset:true}:{})});assert.equal(c.statusCode,200,c.body);return {preview:p.json(),result:c.json()};}
async function counts(){const result:Record<string,number>={};for(const table of ['transaction','source_observation','account','account_alias','ingestion_batch','ingestion_file','ingestion_row','ingestion_account','duplicate_candidate','ingestion_dispatch'])result[table]=Number((await pg.owner.query(`SELECT count(*) AS n FROM finance.${table} WHERE user_id='first'`)).rows[0].n);return result;}
async function safeBatch(rows=[row({safeSource:{event:'purchase',merchant:'ozon'}})],bytes='Synthetic safe source'){
 const local=await createLocalPreparation(await context(),undefined,'bank-pdf/2',sourceSanitizer);
 try{return await local.prepare(randomUUID(),[{fileId:randomUUID(),bank:'tbank',bytes:new TextEncoder().encode(bytes),rows:rows.map(r=>({...r,localDescription:r.localDescription??JSON.stringify(r.safeSource??null)}))}]);}finally{local.dispose();}
}

async function actionEpoch(){const e=(await request('/finance/epoch')).json();return {generation:e.generation,revision:e.revision};}
async function importedOperation(){const id=(await pg.owner.query('SELECT id FROM finance.transaction')).rows[0].id;const r=await request('/finance/operation',{id});assert.equal(r.statusCode,200,r.body);return r.json();}
async function detail(id:string){const r=await request('/finance/operation',{id});assert.equal(r.statusCode,200,r.body);return r.json();}
test('mixed local table contract persists parser and finite cash/transfer facts, isolates bad rows and cascades cancellation',async()=>{
 const csv='Банк;Т-Банк\nНомер счета;'+account+'\nДата операции;Сумма операции;Валюта;Описание\n2026-09-01;-10.01;RUB;Снятие наличных Private ATM\n2026-09-02;20.00;RUB;Внесение наличных Private ATM\n2026-09-03;1.00;RUB;Кешбэк Private\n2026-09-04;2.00;RUB;Входящий перевод Private Person\n2026-09-05;-3.00;RUB;Исходящий перевод Private Person\n30.02.2026;-1.00;RUB;Покупка OZON Private';
 const local=await createLocalPreparation(await context(),undefined,localBankAdapter,localSourceSanitizer);let batch:PreparedBatch;
 try{batch=await local.prepare(randomUUID(),[parseBankTable(randomUUID(),new TextEncoder().encode(csv),csvTable(csv))]);}finally{local.dispose();}
 await accept(batch);const report=await drain(batch.batchId);assert.equal(report.counts.created,5);assert.equal(report.counts.notImported,1);assert.equal(report.status,'partial');
 const state=(await request('/finance/state')).json(),ops=state.operations;assert.equal(ops.find((o:any)=>o.classification.kind.value==='cash_withdrawal').analyticsRole,'neutral');assert.equal(ops.find((o:any)=>o.classification.kind.value==='cash_deposit').analyticsRole,'neutral');assert.equal(ops.find((o:any)=>o.classification.kind.value==='cashback').analyticsRole,'income');assert.equal(ops.filter((o:any)=>['transfer_in','transfer_out'].includes(o.classification.kind.value)).every((o:any)=>o.analyticsRole==='unresolved'),true);
 const sources=(await pg.owner.query("SELECT versions,description,merchant_text FROM finance.source_observation WHERE user_id='first'")).rows;assert.equal(sources.every(s=>s.versions.parser==='tbank-table/1'&&s.versions.sanitizer==='bank-source/3'),true);assert.equal(JSON.stringify(sources).includes('Private'),false);
 const replay=await request('/finance/import-accept',batch);assert.equal(replay.statusCode,202);assert.equal(replay.json().batchId,batch.batchId);assert.equal((await counts()).transaction,5);
 const invalid=structuredClone(batch);invalid.batchId=randomUUID();invalid.files[0]!.fileId=randomUUID();invalid.files[0]!.rows[0]!.parser='sber-table/1';assert.equal((await request('/finance/import-accept',invalid)).statusCode,400);
 await command({kind:'cancel_import',batchId:batch.batchId});assert.equal((await counts()).transaction,0);assert.equal((await counts()).source_observation,0);assert.equal(JSON.stringify((await request('/finance/state')).json()).includes('Private'),false);
});
test('OCR parser metadata cannot promote merchant or strict dedupe evidence over HTTP',async()=>{
 const local=await createLocalPreparation(await context(),undefined,localBankAdapter,localSourceSanitizer);let batch:PreparedBatch;
 try{batch=await local.prepare(randomUUID(),[{fileId:randomUUID(),bank:'tbank',bytes:new TextEncoder().encode('Synthetic scanned bytes'),rows:[row({parser:'tbank-ocr/1',bankReference:undefined,safeSource:null,localDescription:undefined})]}]);}finally{local.dispose();}
 const bad=structuredClone(batch);bad.files[0]!.rows[0]!.safeSource={event:'purchase',merchant:'ozon'};assert.equal((await request('/finance/import-accept',bad)).statusCode,400);
 await accept(batch);await drain(batch.batchId);const op=await importedOperation();assert.equal(op.source.versions.parser,'tbank-ocr/1');assert.equal(op.semantics.kind.confidence,0);assert.equal(op.projection.analyticsRole,'unresolved');assert.equal(op.projection.reviewReasons.length>0,true);
 const evidence=(await pg.owner.query("SELECT source_evidence,description_hmac,strict_fingerprint FROM finance.ingestion_row WHERE user_id='first'")).rows;assert.deepEqual(evidence,[{source_evidence:null,description_hmac:null,strict_fingerprint:null}]);
});
test('expanded source corpus and private full-description fingerprints distinguish equal-brand purchases and reuse exact unknown descriptions',async()=>{
 const exact=row({bankReference:undefined,operationDate:{precision:'instant',instant:'2026-09-01T10:00:00.000Z'},safeSource:{event:'purchase',merchant:'vkusvill'},localDescription:'Покупка ВкусВилл Synthetic-Terminal-A auth Synthetic-Private-1'});
 const first=await safeBatch([exact],'Expanded first');await accept(first);await drain(first.batchId);let current=await importedOperation();assert.equal(current.source.merchantText,'ВкусВилл');assert.equal(current.source.versions.sanitizer,'bank-source/2');assert.equal(current.source.versions.dedupe,'strict-bank-description/2');
 const other=await safeBatch([{...exact,localDescription:'Покупка ВкусВилл Synthetic-Terminal-B auth Synthetic-Private-2'}],'Expanded other');await accept(other);const different=await drain(other.batchId);assert.equal(different.counts.created,1);assert.equal((await request('/finance/state')).json().duplicateCandidates.length,0);
 const repeat=await safeBatch([exact],'Expanded repeat');await accept(repeat);assert.equal((await drain(repeat.batchId)).counts.existing,1);assert.equal((await counts()).transaction,2);
 const unknown={...exact,safeSource:{event:'purchase' as const,merchant:null},localDescription:'Покупка Synthetic Unknown Store authorization Synthetic-Private-3'};
 const u=await safeBatch([unknown],'Unknown first');await accept(u);await drain(u.batchId);const again=await safeBatch([unknown],'Unknown repeat');await accept(again);assert.equal((await drain(again.batchId)).counts.existing,1);assert.equal((await counts()).transaction,3);
 const stored=(await pg.owner.query("SELECT description_hmac,source_evidence,payload FROM finance.ingestion_row WHERE user_id='first'")).rows;assert.equal(stored.every(r=>/^[a-f0-9]{64}$/.test(r.description_hmac)&&r.payload===null),true);assert.equal(JSON.stringify(stored).includes('Synthetic'),false);
 const report=await status(u.batchId);assert.equal(JSON.stringify(report).includes('descriptionHmac'),false);assert.equal(JSON.stringify((await request('/finance/state')).json()).includes('descriptionHmac'),false);
 await command({kind:'cancel_import',batchId:u.batchId});assert.equal((await counts()).transaction,3);await command({kind:'delete_financial',scope:{kind:'operations',operationIds:report.files[0]!.operationIds!}});assert.equal((await pg.owner.query("SELECT count(*) AS n FROM finance.ingestion_row WHERE description_hmac=$1",[again.files[0]!.rows[0]!.descriptionHmac])).rows[0].n,'0');
});
test('date-only private descriptions remain separate possible duplicates and preserve explicit different decisions on exact-file reimport',async()=>{
 const dated=row({bankReference:undefined,safeSource:{event:'purchase',merchant:'dns'},localDescription:'Оплата по карте DNS Synthetic-Private-1'}),a=await safeBatch([dated],'Date-only A');await accept(a);await drain(a.batchId);const b=await safeBatch([dated],'Date-only B');await accept(b);await drain(b.batchId);
 assert.equal((await counts()).transaction,2);const pair=(await request('/finance/state')).json().duplicateCandidates[0];assert.ok(pair);await command({kind:'duplicate_different',id:pair.id});
 const repeated=await safeBatch([dated],'Date-only B');await accept(repeated);assert.equal((await drain(repeated.batchId)).counts.existing,1);assert.equal((await request('/finance/state')).json().duplicateCandidates.length,0);
});
async function weakPair(){const rows=[row({bankReference:undefined,safeSource:{event:'purchase',merchant:'ozon'}})],a=await safeBatch(rows,'merge source A');await accept(a);const ar=await drain(a.batchId),b=await safeBatch(rows,'merge source B');await accept(b);await drain(b.batchId);const pair=(await request('/finance/state')).json().duplicateCandidates[0];return {pair,leftBatch:ar.operationIds[0]===pair.leftId?a:b,rightBatch:ar.operationIds[0]===pair.leftId?b:a};}
const mergeIntent=(pair:any,extra:Record<string,unknown>={})=>({kind:'merge_duplicate',id:pair.id,canonicalId:pair.leftId,sourceSide:'left',choices:{},...extra});
async function previewCommand(intent:unknown){return request('/finance/preview',{actionId:randomUUID(),...await actionEpoch(),intent});}

test('duplicate merge keeps canonical ID, immutable source instances and old-ID reads, then checked Undo restores both operations',async()=>{
 const {pair,leftBatch,rightBatch}=await weakPair(),sources=(await pg.owner.query('SELECT * FROM finance.source_observation ORDER BY id')).rows;
 const saved=await command(mergeIntent(pair,{sourceSide:'right'}));assert.equal(saved.preview.impact.details.sourcesPreserved,2);assert.equal(saved.preview.impact.after.netExpensesMinor,'100');
 const state=(await request('/finance/state')).json();assert.equal(state.operations.length,1);assert.equal(state.operations[0].id,pair.leftId);assert.deepEqual(state.operationAliases,[{id:pair.rightId,canonicalId:pair.leftId}]);assert.equal((await detail(pair.rightId)).id,pair.leftId);
 assert.deepEqual((await pg.owner.query('SELECT * FROM finance.source_observation ORDER BY id')).rows,sources);assert.deepEqual((await status(leftBatch.batchId)).operationIds,[pair.leftId]);assert.deepEqual((await status(rightBatch.batchId)).operationIds,[pair.leftId]);
 assert.deepEqual((await request('/finance/commit',{actionId:saved.result.actionId})).json(),saved.result);
 const h=(await request('/finance/history-query',{kinds:['merge_duplicate'],operationIds:[pair.rightId]})).json();assert.equal(h.actions[0].undoable,true);
 await command({kind:'restore_history',actionIds:[saved.result.actionId]});const undone=(await request('/finance/state')).json();assert.equal(undone.operations.length,2);assert.deepEqual(undone.operationAliases,[]);assert.equal(undone.duplicateCandidates.length,1);assert.equal((await detail(pair.rightId)).id,pair.rightId);assert.deepEqual((await pg.owner.query('SELECT * FROM finance.source_observation ORDER BY id')).rows,sources);
});
test('conflicting manual values require choices and merge Undo refuses later edits',async()=>{
 const {pair}=await weakPair();await command({kind:'operation',id:pair.leftId,patch:{merchant:'Left user',comment:'Left comment',corrections:{amountMinor:'-101'}}});await command({kind:'operation',id:pair.rightId,patch:{merchant:'Right user',comment:'Right comment',corrections:{amountMinor:'-102'}}});
 const blocked=await previewCommand(mergeIntent(pair));assert.equal(blocked.statusCode,200,blocked.body);assert.deepEqual(new Set(blocked.json().impact.details.conflicts.map((c:any)=>c.field)),new Set(['merchant','comment','amountMinor']));assert.equal((await request('/finance/commit',{actionId:blocked.json().actionId})).json().code,'MERGE_CONFLICT');assert.equal((await request('/finance/state')).json().operations.length,2);
 const saved=await command(mergeIntent(pair,{choices:{merchant:'right',comment:'left',amountMinor:'right'}})),op=await detail(pair.leftId);assert.equal(op.comment,'Left comment');assert.equal(op.semantics.merchant.value,'Right user');assert.equal(op.semantics.merchant.userVerified,true);assert.equal(op.corrections.amountMinor,'-102');assert.equal(op.source.amountMinor,'-100');
 await command({kind:'operation',id:pair.leftId,patch:{comment:'New edit'}});const undo=await previewCommand({kind:'undo',id:randomUUID(),value:saved.result.actionId});assert.equal(undo.statusCode,409,undo.body);assert.equal((await detail(pair.leftId)).comment,'New edit');
});
test('merge validates ownership, freshness, tenant aliases and source membership without granting bank-fact updates',async()=>{
 const {pair}=await weakPair();assert.equal((await previewCommand(mergeIntent(pair,{canonicalId:randomUUID()}))).statusCode,404);assert.equal((await previewCommand(mergeIntent({...pair,id:randomUUID()}))).statusCode,404);assert.equal((await previewCommand(mergeIntent(pair,{choices:{merchant:'invented'}}))).statusCode,400);
 const a=await detail(pair.leftId),b=(await pg.owner.query('SELECT source_observation_id FROM finance.transaction WHERE id=$1',[pair.rightId])).rows[0];await assert.rejects(within('first',db=>db.query('UPDATE finance.transaction SET source_observation_id=$3 WHERE user_id=$1 AND id=$2',['first',pair.leftId,b.source_observation_id])),{code:'23514'});
 await assert.rejects(within('first',db=>db.query('UPDATE finance.source_observation SET amount_minor=1 WHERE user_id=$1',['first'])),{code:'42501'});assert.equal((await within('second',db=>db.query('SELECT finance.canonical_operation($1,$2) AS id',['first',pair.leftId]))).rows[0].id,null);
 const p=await previewCommand(mergeIntent(pair));await command({kind:'operation',id:pair.leftId,patch:{comment:'Changed'}});assert.equal((await request('/finance/commit',{actionId:p.json().actionId})).statusCode,409);
 const fresh=await previewCommand(mergeIntent(pair));await pg.owner.query("UPDATE identity.security_state SET status='suspended' WHERE user_id='first'");assert.equal((await request('/finance/commit',{actionId:fresh.json().actionId})).statusCode,403);assert.equal(a.source.amountMinor,'-100');
});
test('cancelling merged sources restores the canonical operation, clears empty alias payloads and finally deletes the entire ID family',async()=>{
 const {pair,leftBatch,rightBatch}=await weakPair();await command({kind:'operation',id:pair.rightId,patch:{comment:'Keep manually',merchant:'Verified label'}});await command(mergeIntent(pair,{sourceSide:'right'}));
 const cancelled=await command({kind:'cancel_import',batchId:rightBatch.batchId});assert.equal(cancelled.preview.impact.details.counts.sharedOperations,1);const kept=await detail(pair.leftId);assert.equal(kept.comment,'Keep manually');assert.equal(kept.semantics.merchant.value,'Verified label');assert.equal((await counts()).source_observation,1);assert.equal((await detail(pair.rightId)).id,pair.leftId);
 const alias=(await pg.owner.query('SELECT * FROM finance.transaction WHERE id=$1',[pair.rightId])).rows[0];assert.equal(alias.source_observation_id,null);assert.equal(alias.comment,'');assert.deepEqual(alias.corrections,{});
 await command({kind:'cancel_import',batchId:leftBatch.batchId});assert.equal((await counts()).transaction,0);assert.equal((await counts()).ingestion_row,0);assert.equal((await request('/finance/operation',{id:pair.rightId})).statusCode,404);
 const again=await safeBatch([row({bankReference:undefined,safeSource:{event:'purchase',merchant:'ozon'}})],'merge source A');await accept(again);await drain(again.batchId);assert.equal([pair.leftId,pair.rightId].includes((await importedOperation()).id),false);
});
test('explicitly merged ordinals survive repeat file import while new identical rows stay separate and new sources block Undo',async()=>{
 const rows=[row({bankReference:undefined,safeSource:{event:'purchase',merchant:'ozon'}}),row({bankReference:undefined,safeSource:{event:'purchase',merchant:'ozon'}})],a=await safeBatch(rows,'two known ordinals');await accept(a);await drain(a.batchId);const ids=(await pg.owner.query('SELECT id FROM finance.transaction ORDER BY id')).rows.map(r=>r.id),pair={id:randomUUID(),leftId:ids[0],rightId:ids[1]};await pg.owner.query('INSERT INTO finance.duplicate_candidate(user_id,id,left_id,right_id) VALUES($1,$2,$3,$4)',['first',pair.id,...ids]);const saved=await command(mergeIntent(pair));
 const b=await safeBatch(rows,'two known ordinals');await accept(b);const repeated=await drain(b.batchId);assert.equal(repeated.counts.existing,2);assert.equal(repeated.counts.created,0);assert.deepEqual(repeated.operationIds,[pair.leftId]);assert.equal((await counts()).source_observation,4);assert.equal((await request('/finance/state')).json().operations.length,1);assert.equal((await previewCommand({kind:'undo',id:randomUUID(),value:saved.result.actionId})).statusCode,409);
 const c=await safeBatch(rows,'two previously unknown ordinals');await accept(c);await drain(c.batchId);assert.equal((await request('/finance/state')).json().operations.length,3);
});
test('component and allocation IDs move with merge and return to their original operations on Undo',async()=>{
 const {pair}=await weakPair();for(const id of [pair.leftId,pair.rightId])await command({kind:'components',id,parts:[{type:'other',amountMinor:'-100',role:'expense'}]});const right=await detail(pair.rightId),refund=await safeBatch([row({bankReference:'Merge refund',amountMinor:'50',direction:'credit',safeSource:{event:'refund',merchant:'ozon'}})],'refund for merge');await accept(refund);const r=await drain(refund.batchId),refundId=r.operationIds[0],linkId=randomUUID();await command({kind:'link',id:linkId,link:{sourceId:refundId,targetId:pair.rightId,targetComponentId:right.components[0].id,kind:'refund',amountMinor:'50',status:'confirmed'}});
 const saved=await command(mergeIntent(pair,{components:'right'})),op=await detail(pair.leftId);assert.equal(op.components[0].id,right.components[0].id);assert.equal(op.components[0].transactionId,pair.leftId);assert.equal(op.links.find((l:any)=>l.id===linkId).targetId,pair.leftId);assert.equal(op.linkStates.find((l:any)=>l.id===linkId).active,true);
 await command({kind:'undo',id:randomUUID(),value:saved.result.actionId});const restored=await detail(pair.rightId);assert.equal(restored.components[0].transactionId,pair.rightId);assert.equal(restored.links.find((l:any)=>l.id===linkId).targetId,pair.rightId);assert.equal((await detail(pair.leftId)).components.length,1);
});
test('a self-link blocks merge until explicitly removed, and checked Undo restores its ID',async()=>{
 const {pair}=await weakPair(),linkId=randomUUID();await command({kind:'link',id:linkId,link:{sourceId:pair.leftId,targetId:pair.rightId,kind:'own_transfer',amountMinor:'1',status:'candidate'}});const blocked=await previewCommand(mergeIntent(pair));assert.equal(blocked.json().impact.details.conflicts.some((c:any)=>c.reason==='SELF_LINK'),true);assert.equal((await request('/finance/commit',{actionId:blocked.json().actionId})).statusCode,409);
 const saved=await command(mergeIntent(pair,{dropLinkIds:[linkId]}));assert.deepEqual(saved.preview.impact.details.linksDropped,[linkId]);assert.equal((await pg.owner.query('SELECT 1 FROM finance.link')).rowCount,0);await command({kind:'undo',id:randomUUID(),value:saved.result.actionId});assert.equal((await pg.owner.query('SELECT id FROM finance.link')).rows[0].id,linkId);
});
test('collapsed duplicate pairs retain an existing different-operation decision for the third operation',async()=>{
 const {pair}=await weakPair(),third=await safeBatch([row({bankReference:undefined,safeSource:{event:'purchase',merchant:'ozon'}})],'third merge source');await accept(third);const report=await drain(third.batchId),thirdId=report.operationIds[0],pairs=(await request('/finance/state')).json().duplicateCandidates,reject=pairs.find((p:any)=>[p.leftId,p.rightId].includes(pair.leftId)&&[p.leftId,p.rightId].includes(thirdId));await command({kind:'duplicate_different',id:reject.id});await command(mergeIntent(pair));const state=(await request('/finance/state')).json();assert.equal(state.operations.length,2);assert.equal(state.duplicateCandidates.length,0);assert.equal((await pg.owner.query("SELECT count(*)::int AS n FROM finance.duplicate_candidate WHERE status='different'")).rows[0].n,1);assert.equal(state.operations.every((o:any)=>!o.reviewReasons.includes('possible_duplicate')),true);
});
test('successive merges flatten the entire ID family and Undo restores its previous mapping without alias chains',async()=>{
 const {pair}=await weakPair();await command(mergeIntent(pair));const third=await safeBatch([row({bankReference:undefined,safeSource:{event:'purchase',merchant:'ozon'}})],'new third source');await accept(third);const report=await drain(third.batchId),thirdId=report.operationIds[0],nextPair=(await request('/finance/state')).json().duplicateCandidates[0],saved=await command(mergeIntent(nextPair,{canonicalId:thirdId}));let state=(await request('/finance/state')).json();assert.equal(state.operations.length,1);assert.equal(state.operationAliases.length,2);assert.equal(state.operationAliases.every((a:any)=>a.canonicalId===thirdId),true);assert.equal((await detail(pair.rightId)).id,thirdId);assert.equal(saved.preview.impact.details.sourcesPreserved,3);
 await command({kind:'undo',id:randomUUID(),value:saved.result.actionId});state=(await request('/finance/state')).json();assert.equal(state.operations.length,2);assert.deepEqual(state.operationAliases,[{id:pair.rightId,canonicalId:pair.leftId}]);assert.equal((await detail(pair.rightId)).id,pair.leftId);
});
test('physical deletion of a merged canonical operation erases aliases, fingerprints and merge history and cannot resurrect old IDs',async()=>{
 const {pair}=await weakPair(),saved=await command(mergeIntent(pair)),deleted=await command({kind:'delete_financial',scope:{kind:'operations',operationIds:[pair.leftId]}});assert.equal(deleted.preview.impact.details.counts.operations,1);assert.equal(deleted.preview.impact.details.counts.retainedOperations,1);assert.deepEqual(deleted.preview.impact.details.retainedOperationIds,[pair.rightId]);assert.equal(deleted.result.cleanup.counts.retainedOperations,1);assert.equal(JSON.stringify(deleted.result).includes(pair.rightId),false);const c=await counts();assert.equal(c.transaction,0);assert.equal(c.source_observation,0);assert.equal(c.ingestion_row,0);assert.equal(c.duplicate_candidate,0);assert.equal((await previewCommand({kind:'undo',id:randomUUID(),value:saved.result.actionId})).statusCode,409);
 const again=await safeBatch([row({bankReference:undefined,safeSource:{event:'purchase',merchant:'ozon'}})],'merge source A');await accept(again);await drain(again.batchId);assert.equal([pair.leftId,pair.rightId].includes((await importedOperation()).id),false);
});

test('cancel preview warns about unique manual edits, commit purges sources, retains empty accounts and has no Undo',async()=>{
 const b=await safeBatch([row({amountMinor:'-73107',safeSource:{event:'purchase',merchant:'ozon'}})]);await accept(b);await drain(b.batchId);
 const op=await importedOperation(),key=(await context()).keyVersion;await command({kind:'operation',id:op.id,patch:{comment:'My decision',merchant:'My merchant',role:'expense'}});await command({kind:'components',id:op.id,parts:[{type:'other',amountMinor:'-30000',role:'expense'},{type:'other',amountMinor:'-43107',role:'expense'}]});
 const {preview,result}=await command({kind:'cancel_import',batchId:b.batchId});
 assert.equal(preview.impact.details.counts.operations,1);assert.equal(preview.impact.details.counts.manualEdits,1);assert.equal(preview.impact.details.counts.components,2);assert.equal(result.cleanup.undoable,false);
 assert.equal((await status(b.batchId)).status,'cancelled');assert.equal((await status(b.batchId)).counts.removed,1);
 const c=await counts();assert.equal(c.transaction,0);assert.equal(c.source_observation,0);assert.equal(c.ingestion_row,0);assert.equal(c.ingestion_dispatch,0);assert.equal(c.account,1);assert.equal((await context()).keyVersion,key);
 assert.equal((await pg.owner.query('SELECT count(*)::int AS n FROM finance.component')).rows[0].n,0);
 assert.equal((await pg.owner.query('SELECT file_hmac FROM finance.ingestion_file')).rows[0].file_hmac,null);
 const receipt=(await request('/finance/commit',{actionId:result.actionId}));assert.equal(receipt.statusCode,200,receipt.body);assert.deepEqual(receipt.json(),result);
 const persisted=JSON.stringify((await pg.owner.query('SELECT * FROM finance.action')).rows);for(const fragment of ['-73107','My decision','My merchant',b.files[0]!.fileHmac])assert.equal(persisted.includes(fragment),false);
 const undo=await request('/finance/preview',{actionId:randomUUID(),...await actionEpoch(),intent:{kind:'undo',id:randomUUID(),value:result.actionId}});assert.equal(undo.statusCode,409);
 const again=await safeBatch([row({amountMinor:'-73107',safeSource:{event:'purchase',merchant:'ozon'}})]);await accept(again);await drain(again.batchId);assert.notEqual((await importedOperation()).id,op.id);
});
test('shared cancellation restores the latest remaining source and keeps verified decisions and corrections',async()=>{
 const a=await batch([row({amountMinor:'-100'})],'source A');await accept(a);await drain(a.batchId);const original=await importedOperation();
 await command({kind:'operation',id:original.id,patch:{corrections:{amountMinor:'-777'},comment:'Keep this',merchant:'Verified merchant',role:'expense'}});
 const b=await batch([row({amountMinor:'-200'})],'source B');await accept(b);await drain(b.batchId);const c=await batch([row({amountMinor:'-300'})],'source C');await accept(c);await drain(c.batchId);
 await command({kind:'cancel_import',batchId:b.batchId});assert.equal((await importedOperation()).source.amountMinor,'-300');
 const {preview}=await command({kind:'cancel_import',batchId:c.batchId});assert.equal(preview.impact.details.counts.sharedOperations,1);assert.equal(preview.impact.details.counts.operations,0);
 const kept=await importedOperation();assert.equal(kept.id,original.id);assert.equal(kept.source.amountMinor,'-100');assert.equal(kept.projection.amountMinor,'-777');assert.equal(kept.comment,'Keep this');assert.equal(kept.semantics.merchant.value,'Verified merchant');assert.equal(kept.semantics.merchant.userVerified,true);
 assert.equal((await counts()).source_observation,1);
});
test('cancelling the only merchant evidence cannot leave its inherited text in a remaining observation or classification',async()=>{
 const a=await safeBatch();await accept(a);await drain(a.batchId);const b=await batch([row({amountMinor:'-200'})],'text-free remaining source');await accept(b);await drain(b.batchId);
 assert.equal((await importedOperation()).source.merchantText,'Ozon');await command({kind:'cancel_import',batchId:a.batchId});
 const op=await importedOperation();assert.equal(op.source.amountMinor,'-200');assert.equal(op.source.merchantText,'');assert.equal(op.source.description,'');assert.equal(op.semantics.merchant.value,'');assert.equal(op.semantics.kind.value,'other');
 assert.equal((await pg.owner.query("SELECT 1 FROM finance.source_observation WHERE merchant_text='Ozon' OR description='Покупка'")).rowCount,0);
 const c=await batch([row({amountMinor:'-250'})],'new text-free source');await accept(c);await drain(c.batchId);assert.equal((await importedOperation()).semantics.merchant.value,'');
});
test('cancelling one file after a checkpoint stops its pending rows and lets the other accepted file finish',async()=>{
 const contextValue=await context(),a=await batch(Array.from({length:IMPORT_CHUNK+1},(_,i)=>row({bankReference:'Cancelled-'+i})),'file A',contextValue),b=await batch([row({bankReference:'Surviving-1'}),row({bankReference:'Surviving-2'})],'file B',contextValue);a.files.push(...b.files);
 await accept(a);await within('first',db=>processImport(db,'first',a.batchId));assert.equal((await counts()).transaction,IMPORT_CHUNK);
 const {preview}=await command({kind:'cancel_import',batchId:a.batchId,fileId:a.files[0]!.fileId});assert.equal(preview.impact.details.counts.pendingRows,1);assert.equal(preview.impact.details.counts.operations,IMPORT_CHUNK);
 const complete=await drain(a.batchId);assert.equal(complete.status,'completed');assert.equal(complete.counts.created,2);assert.equal(complete.counts.removed,IMPORT_CHUNK+1);assert.equal(complete.counts.pending,0);assert.equal((await counts()).transaction,2);assert.equal((await counts()).ingestion_dispatch,0);
 assert.ok(complete.files[0]!.cancelledAt);assert.equal(complete.files[1]!.cancelledAt,null);
});
test('strict exact-source fingerprint reuses a no-ID operation across files despite effective edits, but consumes it only once',async()=>{
 const exact=row({bankReference:undefined,operationDate:{precision:'instant',instant:'2026-09-01T10:00:00.000Z'},safeSource:{event:'purchase',merchant:'ozon'}}),a=await safeBatch([exact],'strict A');await accept(a);await drain(a.batchId);const original=await importedOperation();
 await command({kind:'operation',id:original.id,patch:{corrections:{amountMinor:'-999',operationDate:{precision:'day',date:'2026-10-01'}},merchant:'User label'}});
 const b=await safeBatch([exact,{...exact}],'strict B');await accept(b);const report=await drain(b.batchId);assert.equal(report.counts.existing,1);assert.equal(report.counts.created,1);assert.equal((await counts()).transaction,2);
 const fingerprint=(await pg.owner.query('SELECT strict_fingerprint FROM finance.ingestion_row')).rows;assert.equal(fingerprint.every(r=>/^[a-f0-9]{64}$/.test(r.strict_fingerprint)),true);
 await command({kind:'cancel_import',batchId:b.batchId});assert.equal((await counts()).transaction,1);assert.equal((await importedOperation()).id,original.id);
 const c=await safeBatch([exact],'strict C');await accept(c);assert.equal((await drain(c.batchId)).counts.existing,1);
});
test('different-operation decision is persisted across reimport and can be restored through checked History',async()=>{
 const a=await batch([row({bankReference:undefined})],'different A');await accept(a);await drain(a.batchId);const b=await batch([row({bankReference:undefined})],'different B');await accept(b);await drain(b.batchId);
 const pair=(await request('/finance/state')).json().duplicateCandidates[0];const saved=await command({kind:'duplicate_different',id:pair.id});
 assert.equal((await request('/finance/state')).json().duplicateCandidates.length,0);assert.equal((await pg.owner.query('SELECT status FROM finance.duplicate_candidate')).rows[0].status,'different');
 const again=await batch([row({bankReference:undefined})],'different B');await accept(again);await drain(again.batchId);assert.equal((await counts()).transaction,2);assert.equal((await request('/finance/state')).json().duplicateCandidates.length,0);
 const history=(await request('/finance/history-query',{operationIds:[pair.leftId]})).json();assert.equal(history.actions.some((a:any)=>a.id===saved.result.actionId),true);
 await command({kind:'restore_history',actionIds:[saved.result.actionId]});assert.equal((await request('/finance/state')).json().duplicateCandidates.length,1);
 assert.equal((await request('/finance/state')).json().operations.every((o:any)=>o.reviewReasons.includes('possible_duplicate')),true);
});
test('cancellation checks ownership, access and fresh dependencies before commit',async()=>{
 const a=await batch();await accept(a);await drain(a.batchId);const epoch=await actionEpoch();
 for(const intent of [{kind:'cancel_import',batchId:randomUUID()},{kind:'cancel_import',batchId:a.batchId,fileId:randomUUID()},{kind:'duplicate_different',id:randomUUID()}]){const result=await request('/finance/preview',{actionId:randomUUID(),...epoch,intent});assert.equal(result.statusCode,404,result.body);}
 const actionId=randomUUID(),preview=await request('/finance/preview',{actionId,...epoch,intent:{kind:'cancel_import',batchId:a.batchId}});assert.equal(preview.statusCode,200,preview.body);
 const b=await batch([row({bankReference:'Another'})],'new dependency');await accept(b);assert.equal((await request('/finance/commit',{actionId})).statusCode,409);assert.equal((await status(a.batchId)).status,'completed');
 await pg.owner.query("UPDATE identity.security_state SET status='suspended' WHERE user_id='first'");assert.equal((await request('/finance/commit',{actionId})).statusCode,403);
});
test('legacy shared source without recorded evidence fails closed instead of restoring invented text',async()=>{
 const a=await safeBatch();await accept(a);await drain(a.batchId);const b=await batch([row({amountMinor:'-200'})],'legacy shared source');await accept(b);await drain(b.batchId);
 await pg.owner.query("UPDATE finance.ingestion_row SET evidence_recorded=false WHERE file_id=$1",[b.files[0]!.fileId]);
 const preview=await request('/finance/preview',{actionId:randomUUID(),...await actionEpoch(),intent:{kind:'cancel_import',batchId:a.batchId}});assert.equal(preview.statusCode,409,preview.body);assert.equal(preview.json().code,'IMPORT_SOURCE_UPGRADE_REQUIRED');assert.equal((await counts()).source_observation,2);assert.equal((await status(a.batchId)).status,'completed');
});
test('history filters and per-file canonical IDs follow cancellation without exposing source fragments',async()=>{
 const c=await context(),a=await batch([row()],'scope A',c),b=await batch([row({bankReference:'Other-operation'})],'scope B',c);a.files.push(...b.files);await accept(a);const complete=await drain(a.batchId);
 assert.equal(complete.operationIds.length,2);assert.equal(complete.files[0]!.operationIds.length,1);assert.notDeepEqual(complete.files[0]!.operationIds,complete.files[1]!.operationIds);
 await command({kind:'cancel_import',batchId:a.batchId,fileId:a.files[0]!.fileId});const report=await status(a.batchId);assert.equal(report.operationIds.length,1);assert.deepEqual(report.files[0]!.operationIds,[]);assert.deepEqual(report.operationIds,report.files[1]!.operationIds);
 assert.equal((await request('/finance/imports',{status:'cancelled'})).json().batches.length,1);assert.equal((await request('/finance/imports',{status:'errors'})).json().batches.length,0);assert.equal((await request('/finance/imports',{status:'made-up'})).statusCode,400);
});
test('source restoration invalidates over-capacity allocations without deleting the surviving refund or user link',async()=>{
 const a=await safeBatch([row({safeSource:{event:'purchase',merchant:'ozon'}}),row({bankReference:'Refund',amountMinor:'200',direction:'credit',safeSource:{event:'refund',merchant:'ozon'}})],'allocation A');await accept(a);await drain(a.batchId);
 const ops=(await pg.owner.query('SELECT t.id,o.source_kind FROM finance.transaction t JOIN finance.source_observation o ON (o.user_id,o.id)=(t.user_id,t.source_observation_id)')).rows,purchase=ops.find(o=>o.source_kind==='purchase')!.id,refund=ops.find(o=>o.source_kind==='refund')!.id;
 const b=await safeBatch([row({amountMinor:'-200',safeSource:{event:'purchase',merchant:'ozon'}})],'allocation B');await accept(b);await drain(b.batchId);
 const linkId=randomUUID();await command({kind:'link',id:linkId,link:{sourceId:refund,targetId:purchase,kind:'refund',amountMinor:'200',status:'confirmed'}});
 const {preview}=await command({kind:'cancel_import',batchId:b.batchId});assert.equal(preview.impact.details.counts.linksRecalculated,1);assert.equal(preview.impact.details.counts.linksDeleted,0);
 const state=(await request('/finance/state')).json(),link=state.links.find((l:any)=>l.id===linkId);assert.equal(link.active,false);assert.ok(link.reason);assert.equal(state.operations.length,2);assert.equal((await pg.owner.query('SELECT count(*)::int AS n FROM finance.link')).rows[0].n,1);
});

test('import history restores accepted and completed batches without keys, payloads or filenames',async()=>{
 const b=await batch();await accept(b);const pending=await request('/finance/imports');assert.equal(pending.statusCode,200);assert.equal(pending.json().batches[0].batchId,b.batchId);assert.equal(pending.json().batches[0].status,'accepted');
 for(const secret of ['Private',account,b.files[0]!.fileHmac,b.files[0]!.rows[0]!.account.hmac,'-100','2026-09-01'])assert.equal(pending.body.includes(secret),false);
 await drain(b.batchId);assert.equal((await request('/finance/imports')).json().batches[0].status,'completed');
 assert.equal((await request('/finance/imports',undefined,{cookie:''})).statusCode,401);assert.equal((await request('/finance/imports?user=second')).statusCode,404);
 assert.equal((await request('/finance/imports',{before:randomUUID(),raw:'Private'})).statusCode,400);
 const otherCookie=await server.fastify.inject({method:'POST',url:'/auth/sign-in/email',payload:{email:'second@example.test',password},headers:{origin:fc.origin,'content-type':'application/json'}});const foreign=otherCookie.cookies.map(c=>c.name+'='+c.value).join('; ');
 assert.deepEqual((await request('/finance/imports',undefined,{cookie:foreign})).json().batches,[]);assert.equal((await request('/finance/imports',{before:b.batchId},{cookie:foreign})).statusCode,404);
 assert.equal((await control.fastify.inject({method:'GET',url:'/finance/imports',headers:{origin:fc.origin,cookie}})).statusCode,404);
 await pg.owner.query("UPDATE identity.security_state SET status='suspended' WHERE user_id='first'");assert.equal((await request('/finance/imports')).statusCode,403);
});
test('history pagination remains bounded with tied timestamps and does not repeat or skip batch IDs',async()=>{
 const c=await context(),ids=Array.from({length:51},()=>randomUUID());
 for(const id of ids)await pg.owner.query("INSERT INTO finance.ingestion_batch(user_id,id,generation,key_version,request_digest,versions,status,created_at) VALUES('first',$1,$2,$3,$4,'{}','completed','2026-01-01T00:00:00.000123Z')",[id,c.generation,c.keyVersion,'a'.repeat(64)]);
 const first=(await request('/finance/imports')).json();assert.equal(first.batches.length,50);assert.ok(first.nextCursor);const last=(await request('/finance/imports',{before:first.nextCursor})).json();assert.equal(last.batches.length,1);assert.equal(last.nextCursor,null);assert.equal(new Set([...first.batches,...last.batches].map(b=>b.batchId)).size,51);
 await command({kind:'reset_financial',keepCategories:true,keepRules:true,keepInterface:true});assert.deepEqual((await request('/finance/imports')).json().batches,[]);
});

test('safe source codes persist canonical source fields before current personal rules',async()=>{
 await command({kind:'rule',id:randomUUID(),create:true,patch:{name:'Synthetic merchant rule',enabled:true,priority:1,conditions:{merchantEquals:'Ozon'},assignments:{merchant:'Personal shop',role:'neutral'}}});
 const b=await safeBatch();await accept(b);assert.equal((await drain(b.batchId)).counts.created,1);
 const op=await importedOperation();assert.equal(op.source.merchantText,'Ozon');assert.equal(op.source.description,'Покупка');assert.equal(op.source.sourceKind,'purchase');assert.equal(op.source.versions.sanitizer,sourceSanitizer);assert.equal(op.semantics.kind.value,'purchase');assert.equal(op.semantics.merchant.value,'Personal shop');assert.equal(op.semantics.merchant.source,'personal_rule');assert.equal(op.semantics.role.value,'neutral');
});
test('enrichment appends provenance and upgrades unverified bank facets without duplicating a file instance',async()=>{
 const a=await batch([row({bankReference:undefined})],'Same synthetic PDF');await accept(a);await drain(a.batchId);
 const b=await safeBatch([row({bankReference:undefined,safeSource:{event:'purchase',merchant:'ozon'}})],'Same synthetic PDF');await accept(b);assert.equal((await drain(b.batchId)).counts.updated,1);
 const op=await importedOperation();assert.equal(op.semantics.kind.value,'purchase');assert.equal(op.semantics.role.value,'expense');assert.equal(op.semantics.merchant.value,'Ozon');assert.equal((await counts()).transaction,1);assert.equal((await counts()).source_observation,2);
});
test('safe source updates preserve verified semantics, corrections, category and comments',async()=>{
 const a=await safeBatch();await accept(a);await drain(a.batchId);const t=(await pg.owner.query('SELECT id FROM finance.transaction')).rows[0].id;
 await command({kind:'operation',id:t,patch:{kind:'transfer_out',role:'neutral',merchant:'Verified shop',comment:'Synthetic preserved comment',corrections:{amountMinor:'-777'}}});
 const before=(await pg.owner.query('SELECT semantics,corrections,comment FROM finance.transaction WHERE id=$1',[t])).rows[0];
 const b=await safeBatch([row({safeSource:{event:'purchase',merchant:'magnit'}})],'Updated synthetic PDF');await accept(b);assert.equal((await drain(b.batchId)).counts.updated,1);assert.deepEqual((await pg.owner.query('SELECT semantics,corrections,comment FROM finance.transaction WHERE id=$1',[t])).rows[0],before);assert.equal((await importedOperation()).source.merchantText,'Магнит');
});
test('older and unknown descriptions cannot erase prior merchant source facts',async()=>{
 const a=await safeBatch();await accept(a);await drain(a.batchId);
 for(const b of [await batch([row()],'Older profile'),await safeBatch([row({safeSource:{event:'purchase',merchant:null}})],'Unknown store')]){await accept(b);const s=await drain(b.batchId);assert.equal(s.counts.existing,1);assert.equal(s.counts.updated,0);}
 const op=await importedOperation();assert.equal(op.source.merchantText,'Ozon');assert.equal(op.source.description,'Покупка');assert.equal(op.semantics.merchant.value,'Ozon');assert.equal((await counts()).source_observation,3);const observations=(await pg.owner.query('SELECT versions FROM finance.source_observation')).rows;assert.equal(observations.every(o=>o.versions.sourceSanitizer===sourceSanitizer&&o.versions.merchantSanitizer===sourceSanitizer),true);
});
test('safe merchant equality alone never authorizes cross-file dedupe',async()=>{
 for(const bytes of ['Synthetic first PDF','Synthetic second PDF']){const b=await safeBatch([row({bankReference:undefined,safeSource:{event:'purchase',merchant:'ozon'}})],bytes);await accept(b);assert.equal((await drain(b.batchId)).counts.created,1);}
 assert.equal((await counts()).transaction,2);assert.equal((await counts()).duplicate_candidate,1);
});
test('HTTP independently rejects source smuggling, unsupported versions and contradictory signs before staging',async()=>{
 const original=await safeBatch();
 for(const edit of [
  (b:any)=>b.files[0].rows[0].safeSource.merchant='Private recipient',
  (b:any)=>b.files[0].rows[0].safeSource.raw='Private auth',
  (b:any)=>b.files[0].rows[0].safeSource.event='refund',
  (b:any)=>b.versions.sanitizer='bank-source/3',
  (b:any)=>b.files[0].rows[0].descriptionHmac='Private raw description',
  (b:any)=>{delete b.files[0].rows[0].descriptionHmac;},
  (b:any)=>{b.files[0].rows[0].amountMinor='bad';b.files[0].rows[0].safeSource.raw='Private auth';},
  (b:any)=>{b.files[0].rows[0].amountMinor='bad';b.files[0].rows[0].descriptionHmac='Private raw description';}
 ]){const b=structuredClone(original);edit(b);const r=await request('/finance/import-accept',b);assert.equal(r.statusCode,400);assert.deepEqual(r.json(),{code:'INVALID_IMPORT_PAYLOAD'});assert.equal(r.body.includes('Private'),false);}
 assert.equal((await counts()).ingestion_batch,0);
});
test('deletion clears safe source observations and pending codes cannot resurrect them',async()=>{
 const a=await safeBatch();await accept(a);await drain(a.batchId);const pending=await safeBatch(undefined,'Pending safe PDF');await accept(pending);const t=(await pg.owner.query('SELECT id FROM finance.transaction')).rows[0].id;await command({kind:'delete_financial',scope:{kind:'operations',operationIds:[t]}});await within('first',db=>processImport(db,'first',pending.batchId));assert.equal((await counts()).source_observation,0);assert.equal((await counts()).transaction,0);assert.equal((await pg.owner.query('SELECT 1 FROM finance.ingestion_row WHERE payload IS NOT NULL')).rowCount,0);
});

test('acceptance is durable, count-only and does not yet write financial observations',async()=>{
 const b=await batch(),r=await request('/finance/import-accept',b);assert.equal(r.statusCode,202,r.body);assert.equal(r.headers['cache-control'],'no-store');assert.equal(r.json().status,'accepted');assert.equal(r.json().counts.pending,1);assert.equal((await counts()).transaction,0);assert.equal((await counts()).ingestion_row,1);
 for(const secret of [account,b.files[0]!.fileHmac,b.files[0]!.rows[0]!.account.hmac,'-100','2026-09-01','Private local'])assert.equal(r.body.includes(secret),false);
 assert.equal((await request('/finance/import-status',{batchId:b.batchId})).statusCode,200);
});
test('all three local bank adapters persist their actual parser version and Ozon contracts stay non-loan',async()=>{
 const session=await createLocalPreparation(await context(),undefined,'bank-pdf/2');
 try{
  const b=await session.prepare(randomUUID(),(['tbank','ozon','sber'] as const).map(bank=>parseBankPdf(randomUUID(),new TextEncoder().encode('Synthetic '+bank),syntheticLayout(bank))));
  await accept(b);const s=await drain(b.batchId);assert.equal(s.counts.created,6);assert.equal(s.counts.notImported,0);
  const facts=(await pg.owner.query('SELECT a.bank_id,a.account_type,o.versions FROM finance.source_observation o JOIN finance.account a ON (a.user_id,a.id)=(o.user_id,o.account_id)')).rows;
  for(const fact of facts)assert.equal(fact.versions.parser,pdfParserVersions[fact.bank_id as keyof typeof pdfParserVersions]);
  assert.equal(facts.filter(f=>f.bank_id==='ozon').every(f=>f.account_type==='other'),true);
  assert.equal((await pg.owner.query("SELECT count(*)::int AS n FROM finance.account_alias WHERE alias_type='bank_contract'")).rows[0].n,1);
  const again=await session.prepare(randomUUID(),(['tbank','ozon','sber'] as const).map(bank=>parseBankPdf(randomUUID(),new TextEncoder().encode('Synthetic '+bank),syntheticLayout(bank))));
  await accept(again);assert.equal((await drain(again.batchId)).counts.existing,6);assert.equal((await counts()).transaction,6);
 }finally{session.dispose();}
});
test('a worker can finish an accepted import without the browser or a live preparation TTL',async()=>{
 const b=await batch();await accept(b);await pg.owner.query("UPDATE finance.ingestion_context SET expires_at=clock_timestamp()-interval '1 second'");assert.equal(await runImportStage(pg.finance),true);const s=await status(b.batchId);assert.equal(s.status,'completed');assert.equal(s.counts.created,1);assert.equal(s.counts.review,1);assert.equal(s.newAccountIds.length,1);assert.equal((await counts()).ingestion_dispatch,0);assert.equal((await counts()).source_observation,1);assert.equal((await pg.owner.query('SELECT payload FROM finance.ingestion_row')).rows[0].payload,null);
});
test('invalid rows and blocked files produce exact partial counts without invented transactions',async()=>{
 const b=await batch([row(),row({amountMinor:undefined}),row()]);b.files[0]!.rows[1]!.operationDate={precision:'day',date:'2026-02-30'};b.files.push({fileId:randomUUID(),bank:'sber',fileHmac:'b'.repeat(64),rowsFound:2,status:'blocked',error:'LOCAL_READ_FAILED',rows:[],issues:[]});await accept(b);const s=await drain(b.batchId);assert.equal(s.status,'partial');assert.deepEqual(s.counts,{files:2,blockedFiles:1,rowsFound:5,pending:0,created:1,existing:0,updated:0,notImported:4,removed:0,review:1});assert.equal((await counts()).transaction,1);assert.equal(s.files[0]!.issues[0]!.nextStep,'verify_local_source');
});
test('same batch retry is idempotent after TTL, while altered reuse conflicts',async()=>{
 const b=await batch(),initial=await accept(b);assert.deepEqual(await accept(b),initial);await drain(b.batchId);await pg.owner.query("UPDATE finance.ingestion_context SET expires_at=clock_timestamp()-interval '1 second'");assert.equal((await accept(b)).counts.created,1);b.files[0]!.rows[0]!.amountMinor='-200';const r=await request('/finance/import-accept',b);assert.equal(r.statusCode,409,r.body);assert.equal(r.json().code,'IMPORT_BATCH_REUSED');assert.equal((await counts()).transaction,1);
});
test('the database and server allow one active batch, including concurrent acceptance',async()=>{
 const c=await context(),a=await batch([row()],'first',c),b=await batch([row()],'second',c),results=await Promise.all([request('/finance/import-accept',a),request('/finance/import-accept',b)]);assert.deepEqual(results.map(r=>r.statusCode).sort(),[202,409]);assert.equal(results.find(r=>r.statusCode===409)!.json().code,'IMPORT_ALREADY_ACTIVE');assert.equal((await counts()).ingestion_batch,1);
});
test('exact file instances dedupe one to one while identical real purchases remain two transactions',async()=>{
 const rows=[row({bankReference:undefined}),row({bankReference:undefined})],a=await batch(rows);await accept(a);assert.equal((await drain(a.batchId)).counts.created,2);assert.equal((await counts()).duplicate_candidate,0);const b=await batch(rows);await accept(b);const s=await drain(b.batchId);assert.equal(s.counts.existing,2);assert.equal((await counts()).transaction,2);assert.equal((await counts()).source_observation,4);
});
test('a stable reference joins intersecting different files without duplicating transactions',async()=>{
 const a=await batch();await accept(a);await drain(a.batchId);const b=await batch([row()],'Different bytes');await accept(b);const s=await drain(b.batchId);assert.equal(s.counts.existing,1);assert.equal((await counts()).transaction,1);assert.equal((await counts()).source_observation,2);assert.equal((await counts()).account,1);
});
test('batch reports separate source-row outcomes from distinct canonical transaction counts',async()=>{
 const c=await context(),a=await batch([row()],'First file',c),b=await batch([row()],'Second file',c);a.files.push(...b.files);await accept(a);const s=await drain(a.batchId);assert.equal(s.counts.rowsFound,2);assert.equal(s.counts.created,1);assert.equal(s.counts.existing,1);assert.deepEqual(s.transactionCounts,{total:1,created:1,existing:0,updated:0,review:1});assert.equal(s.files[1]!.transactionCounts.existing,1);assert.equal((await counts()).source_observation,2);
});
test('an explicitly unknown direction remains an unchanged source fact on reimport',async()=>{
 const a=await batch([row({direction:'unknown'})]);await accept(a);await drain(a.batchId);const b=await batch([row({direction:'unknown'})],'Another file');await accept(b);const s=await drain(b.batchId);assert.equal(s.counts.existing,1);assert.equal(s.counts.updated,0);
});
test('two rows sharing a reference consume a transaction at most once per file',async()=>{
 const a=await batch();await accept(a);await drain(a.batchId);const b=await batch([row(),row()],'Different bytes');await accept(b);const s=await drain(b.batchId);assert.equal(s.counts.existing,1);assert.equal(s.counts.created,1);assert.equal((await counts()).transaction,2);assert.equal((await counts()).duplicate_candidate,1);
});
test('date/amount equality across different files is ambiguous in the text-free profile',async()=>{
 const a=await batch([row({bankReference:undefined})]);await accept(a);await drain(a.batchId);const b=await batch([row({bankReference:undefined})],'Other file');await accept(b);const s=await drain(b.batchId);assert.equal(s.counts.created,1);assert.equal((await counts()).transaction,2);assert.equal((await counts()).duplicate_candidate,1);const ops=(await request('/finance/state')).json().operations;assert.equal(ops.every((o:any)=>o.reviewReasons.includes('possible_duplicate')),true);
});
test('new source facts update one operation while preserving user corrections and verified semantics',async()=>{
 const a=await batch();await accept(a);await drain(a.batchId);const t=(await pg.owner.query('SELECT id FROM finance.transaction')).rows[0].id,category=(await pg.owner.query("SELECT id FROM finance.category WHERE user_id='first' AND role='expense' AND parent_id IS NULL LIMIT 1")).rows[0].id;
 await command({kind:'operation',id:t,patch:{corrections:{amountMinor:'-777',operationDate:{precision:'day',date:'2026-09-05'}},kind:'purchase',role:'expense',categoryId:category,merchant:'Verified shop',comment:'Keep this synthetic comment'}});
 const before=(await pg.owner.query('SELECT corrections,semantics,comment FROM finance.transaction WHERE id=$1',[t])).rows[0];
 const b=await batch([row({amountMinor:'-200'})],'Updated source');await accept(b);assert.equal((await drain(b.batchId)).counts.updated,1);assert.deepEqual((await pg.owner.query('SELECT corrections,semantics,comment FROM finance.transaction WHERE id=$1',[t])).rows[0],before);assert.equal((await counts()).transaction,1);const source=(await pg.owner.query('SELECT o.amount_minor FROM finance.source_observation o JOIN finance.transaction t ON (t.user_id,t.source_observation_id)=(o.user_id,o.id) WHERE t.id=$1',[t])).rows[0];assert.equal(source.amount_minor,'-200');
});
test('a checkpoint retry preserves counts, consumed instances and provenance across restarts',async()=>{
 const rows=Array.from({length:IMPORT_CHUNK+1},(_,i)=>row({bankReference:'Synthetic-'+(i===IMPORT_CHUNK?0:i)})),a=await batch(rows);await accept(a);await within('first',db=>processImport(db,'first',a.batchId));let s=await status(a.batchId);assert.equal(s.status,'processing');assert.equal(s.counts.created,IMPORT_CHUNK);assert.equal(s.counts.pending,1);
 // Control the persisted scheduler time instead of assuming its 10 ms delay elapsed.
 await pg.owner.query("UPDATE finance.ingestion_dispatch SET next_attempt_at=clock_timestamp()+interval '1 hour' WHERE user_id='first' AND batch_id=$1",[a.batchId]);assert.equal(await runImportStage(pg.finance),false);
 await pg.owner.query("UPDATE finance.ingestion_dispatch SET next_attempt_at=clock_timestamp()-interval '1 second' WHERE user_id='first' AND batch_id=$1",[a.batchId]);assert.equal(await runImportStage(pg.finance),true);
 s=await status(a.batchId);assert.equal(s.status,'completed');assert.equal(s.counts.pending,0);assert.equal(s.counts.created,rows.length);assert.equal((await counts()).source_observation,rows.length);assert.equal((await counts()).duplicate_candidate,1);assert.equal((await counts()).ingestion_dispatch,0);
});
test('a failed atomic stage rolls back account, operation, provenance and checkpoint together',async()=>{
 const a=await batch([row(),row({bankReference:'Synthetic-2'})]);await accept(a);const before=await counts();await assert.rejects(within('first',async db=>{const query=db.query.bind(db);(db as any).query=async(...args:any[])=>{if(typeof args[0]==='string'&&args[0].startsWith('UPDATE finance.ingestion_row SET status=\'imported\''))throw new Error('Synthetic checkpoint failure');return (query as any)(...args);};try{await processImport(db,'first',a.batchId);}finally{db.query=query;}}));assert.deepEqual(await counts(),before);assert.equal((await drain(a.batchId)).counts.created,2);
});
test('worker races serialize, so two workers never process one row twice',async()=>{
 const a=await batch();await accept(a);await Promise.all([within('first',db=>processImport(db,'first',a.batchId)),within('first',db=>processImport(db,'first',a.batchId))]);assert.equal((await counts()).transaction,1);assert.equal((await counts()).source_observation,1);assert.equal((await status(a.batchId)).counts.created,1);
});
test('physical deletion clears source dedupe and reimports only removed file instances',async()=>{
 const rows=[row({bankReference:'Synthetic-1'}),row({bankReference:'Synthetic-2'})],a=await batch(rows);await accept(a);await drain(a.batchId);const ids=(await pg.owner.query('SELECT transaction_id FROM finance.source_observation ORDER BY bank_ref_hmac')).rows.map(r=>r.transaction_id);await command({kind:'delete_financial',scope:{kind:'operations',operationIds:[ids[0]]}});assert.equal((await counts()).ingestion_row,1);assert.equal((await status(a.batchId)).counts.removed,1);const b=await batch(rows);await accept(b);const s=await drain(b.batchId);assert.equal(s.counts.created,1);assert.equal(s.counts.existing,1);assert.equal((await counts()).transaction,2);assert.equal((await pg.owner.query('SELECT 1 FROM finance.transaction WHERE id=$1',[ids[0]])).rowCount,0);
});
test('deletion invalidates queued copies and old jobs cannot resurrect deleted financial data',async()=>{
 const a=await batch();await accept(a);await drain(a.batchId);const b=await batch([row(),row({bankReference:'Synthetic-2'})],'Pending file');await accept(b);const t=(await pg.owner.query('SELECT id FROM finance.transaction')).rows[0].id;const deletion=await command({kind:'delete_financial',scope:{kind:'operations',operationIds:[t]}});assert.equal(deletion.preview.impact.details.counts.pendingImportRowsInvalidated,2);assert.equal((await counts()).transaction,0);assert.equal((await counts()).ingestion_dispatch,0);await within('first',db=>processImport(db,'first',b.batchId));const s=await status(b.batchId);assert.equal(s.status,'invalidated');assert.equal(s.counts.notImported,2);assert.equal((await pg.owner.query('SELECT 1 FROM finance.ingestion_row WHERE payload IS NOT NULL')).rowCount,0);assert.equal((await request('/finance/import-accept',b)).statusCode,409);
});
test('full reset erases accepted payloads, fingerprints, issues, candidates and scheduler metadata',async()=>{
 const a=await batch([row({amountMinor:undefined}),row()]);await accept(a);const before=await context();const done=await command({kind:'reset_financial',keepCategories:true,keepRules:true,keepInterface:true});assert.equal(done.preview.impact.details.counts.imports,1);assert.equal(done.preview.impact.details.counts.importRows,2);const after=await counts();for(const key of Object.keys(after))assert.equal(after[key],0,key);const fresh=await context();assert.notEqual(fresh.keyVersion,before.keyVersion);assert.equal((await request('/finance/import-status',{batchId:a.batchId})).statusCode,404);
});
test('queued imports recheck current entitlement; suspension leaves a safe retry checkpoint',async()=>{
 const a=await batch();await accept(a);await pg.owner.query("UPDATE identity.security_state SET status='suspended' WHERE user_id='first'");assert.equal(await runImportStage(pg.finance),true);assert.equal((await counts()).transaction,0);assert.equal((await counts()).ingestion_row,1);assert.equal((await request('/finance/import-status',{batchId:a.batchId})).statusCode,403);await pg.owner.query("UPDATE identity.security_state SET status='active' WHERE user_id='first'");assert.equal((await drain(a.batchId)).counts.created,1);
});
test('server refuses missing access, raw smuggling, expired/foreign context and control profile',async()=>{
 const a=await batch();assert.equal((await request('/finance/import-accept',a,{cookie:''})).statusCode,401);assert.equal((await request('/finance/import-accept',a,{origin:'https://other.example.test'})).statusCode,403);assert.equal((await request('/finance/import-accept?private=sentinel',a)).statusCode,404);
 const foreign=await within('second',async db=>prepareImportContext(db,'second',await prepareFinance(db,'second'),{contextId:randomUUID()},envelope(fc.wrappingKey)));const b=structuredClone(a);b.context.contextId=foreign.contextId;assert.equal((await request('/finance/import-accept',b)).statusCode,409);
 (b as any).rawAccount='Private sentinel';b.context=a.context;const bad=await request('/finance/import-accept',b);assert.equal(bad.statusCode,400);assert.deepEqual(bad.json(),{code:'INVALID_IMPORT_PAYLOAD'});assert.equal(bad.body.includes('sentinel'),false);
 const cc=await control.fastify.inject({method:'POST',url:'/finance/import-accept',payload:a,headers:{origin:fc.origin,cookie,'content-type':'application/json'}});assert.equal(cc.statusCode,404);await pg.owner.query("UPDATE finance.ingestion_context SET expires_at=clock_timestamp()-interval '1 second'");assert.equal((await request('/finance/import-accept',a)).json().code,'IMPORT_CONTEXT_EXPIRED');assert.equal((await counts()).ingestion_batch,0);
});
test('ownership/RLS isolate all financial ingestion tables from other users and control/mail roles',async()=>{
 const a=await batch();await accept(a);await drain(a.batchId);await within('second',async db=>{for(const table of ['ingestion_batch','ingestion_file','ingestion_row','ingestion_account','duplicate_candidate'])assert.equal((await db.query(`SELECT 1 FROM finance.${table}`)).rowCount,0);});assert.equal((await within('second',db=>importStatus(db,'second',{batchId:a.batchId})).catch((e:any)=>e.code)),'NOT_FOUND');
 for(const role of ['control_api','mail_finance','mail_control'])for(const table of ['ingestion_batch','ingestion_file','ingestion_row','ingestion_account','duplicate_candidate','ingestion_dispatch'])assert.equal((await pg.owner.query('SELECT has_table_privilege($1,$2,\'SELECT\') AS allowed',[role,'finance.'+table])).rows[0].allowed,false);
});

test('a new counterparty binding on an original merged source targets its canonical operation and blocks earlier Undo',async()=>{
 const {pair}=await weakPair(),saved=await command(mergeIntent(pair,{sourceSide:'left'})),partyId=randomUUID(),observationId=(await pg.owner.query('SELECT id FROM finance.source_observation WHERE transaction_id=$1',[pair.rightId])).rows[0].id;
 await command({kind:'counterparty',id:partyId,create:true,patch:{name:'Synthetic source party'}});const e=await context();await within('first',db=>acceptCounterpartyObservation(db,'first',{generation:e.generation,keyVersion:e.keyVersion},{observationId,counterpartyId:partyId,aliasId:null}));
 assert.equal((await request('/finance/state')).json().counterpartySources[0].transactionId,pair.leftId);assert.equal((await previewCommand({kind:'undo',id:randomUUID(),value:saved.result.actionId})).statusCode,409);
});

test('richer bank text upgrades exact file instances without duplicates or overwriting manual edits; cancellation restores earlier evidence',async()=>{
 const raw='Покупка Аптека Ромашка карта 4111111111111111',bytes='same synthetic source bytes';
 const rows=[row({bankReference:undefined,localDescription:raw,safeSource:{event:'purchase',merchant:null},parser:'tbank-table/1',localMcc:'5912',localBankCategory:'Здоровье'})];
 const prepare=async(profile:'bank-source/3'|'bank-source/4')=>{const local=await createLocalPreparation(await context(),undefined,localBankAdapter,profile);try{return await local.prepare(randomUUID(),[{fileId:randomUUID(),bank:'tbank',bytes:new TextEncoder().encode(bytes),rows}]);}finally{local.dispose();}};
 const old=await prepare('bank-source/3');await accept(old);await drain(old.batchId);const first=await importedOperation();assert.equal(first.source.description,'Покупка');
 await command({kind:'operation',id:first.id,patch:{merchant:'Моя аптека',comment:'Ручной комментарий'}});
 const enriched=await prepare('bank-source/4');await accept(enriched);const result=await drain(enriched.batchId);assert.equal(result.counts.created,0);assert.equal(result.counts.updated,1);assert.equal((await counts()).transaction,1);
 const upgraded=await detail(first.id);assert.equal(upgraded.source.description,'Покупка Аптека Ромашка [скрыто]');assert.equal(upgraded.source.sourceMcc,'5912');assert.equal(upgraded.source.bankCategory,'Здоровье');assert.equal(upgraded.semantics.merchant.value,'Моя аптека');assert.equal(upgraded.comment,'Ручной комментарий');assert.equal(upgraded.source.amountMinor,first.source.amountMinor);
 const page=await request('/finance/operations-page',{query:{filter:{search:'Ромашка'}}});assert.equal(page.statusCode,200,page.body);assert.equal(page.json().operations[0].description,upgraded.source.description);
 const legacy=await prepare('bank-source/3');await accept(legacy);await drain(legacy.batchId);assert.equal((await detail(first.id)).source.description,upgraded.source.description);assert.equal((await counts()).transaction,1);
 await command({kind:'cancel_import',batchId:legacy.batchId});await command({kind:'cancel_import',batchId:enriched.batchId});const restored=await detail(first.id);assert.equal(restored.source.description,'Покупка');assert.equal(restored.source.sourceMcc,undefined);assert.equal(restored.semantics.merchant.value,'Моя аптека');assert.equal(restored.comment,'Ручной комментарий');
});

 test('owner-approved bank display retains names and ordinary digits while targeted secrets never reach stored observations',async()=>{
 const local=await createLocalPreparation(await context(),undefined,localBankAdapter,'bank-source/4');
 let b:PreparedBatch;try{b=await local.prepare(randomUUID(),[{fileId:randomUUID(),bank:'tbank',bytes:new TextEncoder().encode('Synthetic targeted description file'),rows:[
  row({bankReference:undefined,parser:'tbank-table/1',localDescription:'Исходящий перевод Иванов Иван Иванович 1500 рублей за 2 билета'}),
  row({bankReference:undefined,parser:'tbank-table/1',localDescription:'Покупка Магазин24 карта ****1234 номер операции ABCDEF-123'}),
  row({bankReference:undefined,parser:'tbank-table/1',localDescription:'Оплата через СБП Магазин24',localMcc:'5912'})
 ]}]);}finally{local.dispose();}
 await accept(b!);await drain(b!.batchId);
 const descriptions=(await pg.owner.query("SELECT description,source_kind FROM finance.source_observation WHERE user_id='first' ORDER BY description")).rows;
 assert.equal(descriptions.length,3);assert.ok(descriptions.some(r=>r.description==='Исходящий перевод Иванов Иван Иванович 1500 рублей за 2 билета'&&r.source_kind==='transfer_out'));
 assert.ok(descriptions.some(r=>r.description==='Оплата через СБП Магазин24'&&r.source_kind==='other'));assert.ok(descriptions.some(r=>r.description.includes('Магазин24')&&r.source_kind==='purchase'));
 assert.ok(!JSON.stringify(descriptions).includes('1234'));assert.ok(!JSON.stringify(descriptions).includes('ABCDEF'));
 const again=await request('/finance/operation',{id:(await pg.owner.query("SELECT transaction_id FROM finance.source_observation WHERE user_id='first' AND source_kind='transfer_out'")).rows[0].transaction_id});assert.equal(again.statusCode,200,again.body);assert.equal(again.json().semantics.merchant.value,'');
 });

test('sanitized merchant recognition separates bank text, delivery and normalized shop on import',async()=>{
 const local=await createLocalPreparation(await context(),undefined,localBankAdapter,descriptionSourceSanitizer);
 let prepared:PreparedBatch;try{prepared=await local.prepare(randomUUID(),[{fileId:randomUUID(),bank:'tbank',bytes:new TextEncoder().encode('Synthetic delivery recognition'),rows:[row({bankReference:undefined,localDescription:'Покупка DOSTAVKA PYATEROCHKA MOSCOW RUS',safeSource:{event:'purchase',merchant:null},parser:'tbank-table/1'}),row({bankReference:undefined,localDescription:'Покупка VIPVENDING Москва Рус',safeSource:{event:'purchase',merchant:null},parser:'tbank-table/1'})]}]);}finally{local.dispose();}
 await accept(prepared!);await drain(prepared!.batchId);const state=(await request('/finance/state')).json();
 const delivery=state.operations.find((o:any)=>o.description.includes('PYATEROCHKA')),vending=state.operations.find((o:any)=>o.description.includes('VIPVENDING'));
 assert.equal(delivery.classification.merchant.value,'PYATEROCHKA');assert.equal(state.categories.find((c:any)=>c.id===delivery.classification.subcategory.value).name,'Доставка продуктов');
 assert.equal(vending.classification.category.confidence,75);assert.ok(vending.reviewReasons.includes('low_category_confidence'));
});

test('already stored inflected contract text is hidden in bank wording and merchant views without changing identity or money',async()=>{
 const first=await batch();await accept(first);await drain(first.batchId);const op=await importedOperation(),id=op.id;
 await pg.owner.query("UPDATE finance.source_observation SET description='Перевод с договора 12345678',merchant_text='Оплата по договору № TEST-1234',versions=versions || '{\"sourceSanitizer\":\"bank-source/4\"}'::jsonb WHERE user_id='first'");
 await pg.owner.query("UPDATE finance.ingestion_row SET source_evidence=$2 WHERE user_id=$1",['first',JSON.stringify({event:'purchase',merchant:null,details:{description:'Перевод с договора 12345678',merchantText:'Оплата по договору № TEST-1234',bankCategory:'',mcc:null}})]);
 const semantics=structuredClone(op.semantics);semantics.merchant.value='Оплата по договору № TEST-1234';await pg.owner.query('UPDATE finance.transaction SET semantics=$3 WHERE user_id=$1 AND id=$2',['first',id,JSON.stringify(semantics)]);
 const response=(await request('/finance/operation',{id})).json();assert.equal(response.id,id);assert.equal(response.source.amountMinor,op.source.amountMinor);assert.ok(!JSON.stringify(response).includes('12345678'));assert.ok(!JSON.stringify(response).includes('TEST-1234'));assert.ok(response.source.description.includes('[скрыто]'));
});

test('same-file reimport preserves a manual purchase split and bank identity, while a new Ozon purchase stays unsplit',async()=>{
 async function prepare(rows:ExtractedRow[],bytes:string){const local=await createLocalPreparation(await context(),undefined,localBankAdapter,descriptionSourceSanitizer);try{return await local.prepare(randomUUID(),[{fileId:randomUUID(),bank:'tbank',bytes:new TextEncoder().encode(bytes),rows}]);}finally{local.dispose();}}
 const item=row({amountMinor:'-1000000',localDescription:'Покупка Ozon',parser:'tbank-table/1',safeSource:{event:'purchase',merchant:'ozon'}}),first=await prepare([item],'Synthetic Ozon statement overlap');await accept(first);await drain(first.batchId);const original=await importedOperation();
 const state=(await request('/finance/state')).json(),food=state.categories.find((c:any)=>c.name==='Продукты'&&!c.parentId).id,clothes=state.categories.find((c:any)=>c.name==='Одежда и аксессуары'&&!c.parentId).id;
 assert.equal(state.categories.find((c:any)=>c.id===original.semantics.category.value).name,'Маркетплейсы');const a=randomUUID(),b=randomUUID();
 await command({kind:'components',id:original.id,parts:[{id:a,type:'other',amountMinor:'-500000',role:'expense',categoryId:food},{id:b,type:'other',amountMinor:'-500000',role:'expense',categoryId:clothes}]});const saved=await detail(original.id);
 const repeat=await prepare([item],'Synthetic Ozon statement overlap');await accept(repeat);await drain(repeat.batchId);const same=await detail(original.id);assert.equal((await counts()).transaction,1);assert.deepEqual(same.source,saved.source);assert.deepEqual(same.components,saved.components);assert.equal(same.semantics.merchant.value,'Ozon');assert.equal(same.projection.amountMinor,'-1000000');
 const next=await prepare([row({...item,amountMinor:'-20000',bankReference:'synthetic-new-ozon-reference',operationDate:{precision:'day',date:'2026-10-02'}})],'Synthetic next Ozon purchase');await accept(next);await drain(next.batchId);
 const operations=(await request('/finance/state')).json().operations;assert.equal(operations.length,2);const added=operations.find((o:any)=>o.id!==original.id);assert.equal(added.classification.merchant.value,'Ozon');assert.equal(added.decompositionActive,false);assert.equal(added.amountMinor,'-20000');assert.equal((await detail(original.id)).components.length,2);
 await command({kind:'cancel_import',batchId:repeat.batchId});assert.equal((await detail(original.id)).components.length,2);assert.equal((await counts()).transaction,2);
});

test('/5 HTTP reimport keeps identity, immutable old observations, manual merchant and category parts through cancellation',async()=>{
 const {merchantSourceSanitizer}=await import('../../../packages/imports/src/safe-source.ts');
 async function prepare(profile:typeof merchantSourceSanitizer|typeof descriptionSourceSanitizer,bytes:string){
  const local=await createLocalPreparation(await context(),undefined,localBankAdapter,profile);
  try{return await local.prepare(randomUUID(),[{fileId:randomUUID(),bank:'tbank',bytes:new TextEncoder().encode(bytes),rows:[row({bankReference:undefined,operationDate:{precision:'instant',instant:'2026-10-01T12:00:00.000Z'},amountMinor:'-10000',localDescription:'Покупка PYATEROCHKA MOSCOW RUS',parser:'tbank-table/1'})]}]);}finally{local.dispose();}
 }
 assert.ok((await context()).sourceProfiles?.includes(merchantSourceSanitizer));
 const first=await prepare(descriptionSourceSanitizer,'Synthetic old source');await accept(first);await drain(first.batchId);const original=await importedOperation();
 const observations=(await pg.owner.query("SELECT id,merchant_text,description,versions FROM finance.source_observation WHERE user_id='first' ORDER BY id")).rows;
 const state=(await request('/finance/state')).json(),food=state.categories.find((c:any)=>c.name==='Продукты'&&c.parentId===null).id;
 await command({kind:'operation',id:original.id,patch:{merchant:'Моё личное имя',comment:'Моя заметка'}});
 await command({kind:'components',id:original.id,parts:[{type:'other',amountMinor:'-6000',role:'expense',categoryId:food},{type:'other',amountMinor:'-4000',role:'expense',categoryId:food}]});
 const parts=(await detail(original.id)).components;
 const next=await prepare(merchantSourceSanitizer,'Synthetic new source');assert.equal(next.files[0]!.rows[0]!.descriptionHmac,first.files[0]!.rows[0]!.descriptionHmac);
 await accept(next);const report=await drain(next.batchId);assert.equal(report.counts.updated,1);assert.equal(report.counts.created,0);assert.equal((await counts()).transaction,1);
 const current=await detail(original.id);assert.equal(current.source.merchantText,'PYATEROCHKA MOSCOW RUS');assert.equal(current.semantics.merchant.value,'Моё личное имя');assert.equal(current.comment,'Моя заметка');assert.deepEqual(current.components,parts);
 const oldRows=(await pg.owner.query("SELECT id,merchant_text,description,versions FROM finance.source_observation WHERE user_id='first' AND id=ANY($1::uuid[]) ORDER BY id",[observations.map(r=>r.id)])).rows;assert.deepEqual(oldRows,observations);
 await command({kind:'cancel_import',batchId:next.batchId});const restored=await detail(original.id);assert.equal(restored.source.merchantText,'Пятёрочка');assert.equal(restored.source.versions.sourceSanitizer,descriptionSourceSanitizer);assert.equal(restored.semantics.merchant.value,'Моё личное имя');assert.deepEqual(restored.components,parts);
});

test('/5 HTTP source preserves a translation business and keeps a real incoming transfer as a separate event',async()=>{
 const {merchantSourceSanitizer}=await import('../../../packages/imports/src/safe-source.ts');
 const local=await createLocalPreparation(await context(),undefined,localBankAdapter,merchantSourceSanitizer);let prepared:PreparedBatch;
 try{prepared=await local.prepare(randomUUID(),[{fileId:randomUUID(),bank:'tbank',bytes:new TextEncoder().encode('Synthetic translation and money transfer'),rows:[row({bankReference:'Synthetic-business',localDescription:'Оплата услуг бюро переводов',localMerchant:'Бюро переводов Север',parser:'tbank-table/1'}),row({bankReference:'Synthetic-transfer',amountMinor:'100',direction:'credit',localDescription:'Входящий перевод Иван Петров',localMerchant:'Иван Петров',parser:'tbank-table/1'})]}]);}finally{local.dispose();}
 await accept(prepared);const report=await drain(prepared.batchId);assert.equal(report.counts.created,2);
 const operations=await Promise.all(report.operationIds.map((id:string)=>detail(id)));
 const business=operations.find(o=>o.source.sourceKind==='purchase')!,transfer=operations.find(o=>o.source.sourceKind==='transfer_in')!;
 assert.equal(business.source.merchantText,'Бюро переводов Север');assert.equal(transfer.source.merchantText,'');assert.equal(transfer.source.description,'Входящий перевод Иван Петров');assert.equal(transfer.semantics.role.value,'unresolved');
 assert.equal(Number((await pg.owner.query("SELECT count(*) AS n FROM finance.classification_run WHERE user_id='first'")).rows[0].n),0);
});

test('/5 capability and acceptance wait for the storage migration; old source formats remain supported',async()=>{
 const {readFile}=await import('node:fs/promises'),{merchantSourceSanitizer}=await import('../../../packages/imports/src/safe-source.ts');
 const legacyMigration=await readFile(new URL('../../../packages/database/migrations/0029_bank_description.sql',import.meta.url),'utf8');
 const nextMigration=await readFile(new URL('../../../packages/database/migrations/0031_merchant_source.sql',import.meta.url),'utf8');
 await pg.owner.query(legacyMigration);
 try{
  const c=await context();assert.equal(c.sourceProfiles?.includes(merchantSourceSanitizer),false);
  const local=await createLocalPreparation(c,undefined,localBankAdapter,merchantSourceSanitizer);let prepared:PreparedBatch;
  try{prepared=await local.prepare(randomUUID(),[{fileId:randomUUID(),bank:'tbank',bytes:new TextEncoder().encode('Synthetic schema-capability test'),rows:[row({localDescription:'Покупка Аптека Ромашка',parser:'tbank-table/1'})]}]);}finally{local.dispose();}
  const refused=await request('/finance/import-accept',prepared);assert.equal(refused.statusCode,503,refused.body);assert.equal(refused.json().code,'IMPORT_SOURCE_PROFILE_UNAVAILABLE');assert.equal((await counts()).ingestion_batch,0);
  await pg.owner.query(nextMigration);assert.equal((await context()).sourceProfiles?.includes(merchantSourceSanitizer),true);
  await accept(prepared);await drain(prepared.batchId);
  const saved=(await pg.owner.query("SELECT id,source_evidence FROM finance.ingestion_row WHERE user_id='first' AND source_evidence IS NOT NULL")).rows[0];
  for(const flag of [null,false,0,{},'safe','']){
   const bad=structuredClone(saved.source_evidence);bad.details.textEvidence=flag;
   await assert.rejects(pg.owner.query('UPDATE finance.ingestion_row SET source_evidence=$2 WHERE id=$1',[saved.id,JSON.stringify(bad)]),(e:any)=>e.code==='23514');
  }
  const extra={...saved.source_evidence,details:{...saved.source_evidence.details,raw:'forbidden'}};
  await assert.rejects(pg.owner.query('UPDATE finance.ingestion_row SET source_evidence=$2 WHERE id=$1',[saved.id,JSON.stringify(extra)]),(e:any)=>e.code==='23514');
  assert.deepEqual((await pg.owner.query('SELECT source_evidence FROM finance.ingestion_row WHERE id=$1',[saved.id])).rows[0].source_evidence,saved.source_evidence);
 }finally{await pg.owner.query(nextMigration);}
});

test('/5 import applies typed activity and own category resolution while retaining bank wording, roles and separate review',async()=>{
 const {merchantSourceSanitizer}=await import('../../../packages/imports/src/safe-source.ts');
 const local=await createLocalPreparation(await context(),undefined,localBankAdapter,merchantSourceSanitizer);let b:PreparedBatch;
 const merchants=['Аптека Ромашка','Optika Север','Яндекс Go','Пятёрочка доставка','Кафе на АЗС','AP\u200bTEKA Ромашка'];
 try{b=await local.prepare(randomUUID(),[{fileId:randomUUID(),bank:'tbank',bytes:new TextEncoder().encode('Synthetic finite activity import'),rows:merchants.map((name,i)=>row({bankReference:'Synthetic-activity-'+i,localDescription:'Покупка '+name,localMerchant:name,parser:'tbank-table/1'}))}]);}finally{local.dispose();}
 await accept(b!);const report=await drain(b!.batchId);assert.equal(report.counts.created,6);const state=(await request('/finance/state')).json(),details=await Promise.all(report.operationIds.map((id:string)=>detail(id)));
 const expected=['Аптеки',null,'Такси','Доставка продуктов','Рестораны и кафе',null];
 for(let i=0;i<merchants.length;i++){
  const op=details.find((o:any)=>o.source.merchantText===merchants[i]!.replace('\u200b',''))!;assert.ok(op,merchants[i]);assert.equal(op.source.amountMinor,'-100');assert.equal(op.semantics.kind.value,i===5?'other':'purchase');assert.equal(op.semantics.role.value,i===5?'unresolved':'expense');assert.equal(op.semantics.merchant.value,op.source.merchantText);assert.equal(op.components.length,0);
  const sub=state.categories.find((c:any)=>c.id===op.semantics.subcategory.value)?.name??null;assert.equal(sub,expected[i],merchants[i]);
  if(i===1)assert.equal(state.categories.find((c:any)=>c.id===op.semantics.category.value)?.name,'Здоровье и спорт');
  if(i===2)assert.equal(op.semantics.category.confidence,80);
  if(i===5)assert.equal(op.semantics.category.value,null);
 }
 assert.equal(Number((await pg.owner.query("SELECT count(*) AS n FROM finance.classification_run WHERE user_id='first'")).rows[0].n),0);
});

test('/5 future Latin imports retain existing Cyrillic private predicates ahead of the common activity catalog',async()=>{
 const {merchantSourceSanitizer}=await import('../../../packages/imports/src/safe-source.ts');const state=(await request('/finance/state')).json(),custom=state.categories.find((c:any)=>c.name==='Еда вне дома'&&!c.parentId).id;
 await command({kind:'rule',id:randomUUID(),create:true,patch:{name:'Личное прежнее правило',enabled:true,priority:2,conditions:{merchantContains:'Пятёрочка'},assignments:{categoryId:custom}}});
 const local=await createLocalPreparation(await context(),undefined,localBankAdapter,merchantSourceSanitizer);let b:PreparedBatch;
 try{b=await local.prepare(randomUUID(),[{fileId:randomUUID(),bank:'tbank',bytes:new TextEncoder().encode('Synthetic existing private predicate'),rows:[row({localDescription:'Покупка PYATEROCHKA MOSCOW RUS',localMerchant:'PYATEROCHKA MOSCOW RUS',parser:'tbank-table/1'})]}]);}finally{local.dispose();}
 await accept(b!);await drain(b!.batchId);const op=await importedOperation();assert.equal(op.semantics.category.value,custom);assert.equal(op.semantics.category.source,'personal_rule');assert.equal(op.source.merchantText,'PYATEROCHKA MOSCOW RUS');assert.equal(op.semantics.merchant.value,'PYATEROCHKA MOSCOW RUS');assert.equal(op.source.description,'Покупка PYATEROCHKA MOSCOW RUS');
});

test('/5 NAME is a read-only view shared by state, detail, search and saved operation rows',async()=>{
 const {merchantSourceSanitizer}=await import('../../../packages/imports/src/safe-source.ts');
 const local=await createLocalPreparation(await context(),undefined,localBankAdapter,merchantSourceSanitizer);let b:PreparedBatch;
 try{b=await local.prepare(randomUUID(),[{fileId:randomUUID(),bank:'tbank',bytes:new TextEncoder().encode('Synthetic NAME projection'),rows:[row({localDescription:'Покупка WORLDCLASS',localMerchant:'WORLDCLASS',parser:'tbank-table/1'})]}]);}finally{local.dispose();}
 await accept(b!);await drain(b!.batchId);const original=await importedOperation(),observations=(await pg.owner.query("SELECT * FROM finance.source_observation WHERE user_id='first' ORDER BY id")).rows,epoch=(await request('/finance/epoch')).json();
 assert.equal(original.displayName.title,'World Class');assert.equal(original.semantics.merchant.value,'WORLDCLASS');assert.equal(original.source.merchantText,'WORLDCLASS');assert.equal(original.source.description,'Покупка WORLDCLASS');
 const state=(await request('/finance/state')).json(),page=await request('/finance/operations-page',{query:{filter:{search:'World Class'}}});assert.equal(page.statusCode,200,page.body);assert.equal(page.json().total,1);
 assert.deepEqual(state.operations[0].displayName,original.displayName);assert.deepEqual(page.json().operations[0].displayName,original.displayName);assert.equal(original.displayName.safeBankDescriptionRef.operationId,original.id);
 assert.deepEqual((await request('/finance/epoch')).json(),epoch);assert.deepEqual((await pg.owner.query("SELECT * FROM finance.source_observation WHERE user_id='first' ORDER BY id")).rows,observations);
 await command({kind:'operation',id:original.id,patch:{merchant:'Мой зал 24'}});const manual=await detail(original.id);assert.equal(manual.displayName.title,'Мой зал 24');assert.deepEqual(manual.source,original.source);
 assert.equal((await request('/finance/operations-page',{query:{filter:{search:'Мой зал 24'}}})).json().total,1);
 await command({kind:'delete_financial',scope:{kind:'operations',operationIds:[original.id]}});assert.equal((await request('/finance/operation',{id:original.id})).statusCode,404);assert.equal((await request('/finance/operations-page',{query:{filter:{search:'World Class'}}})).json().total,0);
});
test('/5 extended logistics assigns the actual separate service without disguising the bank wording as goods',async()=>{
 const {merchantSourceSanitizer}=await import('../../../packages/imports/src/safe-source.ts');const local=await createLocalPreparation(await context(),undefined,localBankAdapter,merchantSourceSanitizer);let b:PreparedBatch;
 try{b=await local.prepare(randomUUID(),[{fileId:randomUUID(),bank:'tbank',bytes:new TextEncoder().encode('Synthetic parcel service'),rows:[row({localDescription:'Покупка B2CPL отправка посылки',localMerchant:'B2CPL',localMcc:'4215',parser:'tbank-table/1'})]}]);}finally{local.dispose();}
 await accept(b!);await drain(b!.batchId);const item=await importedOperation(),state=(await request('/finance/state')).json();assert.equal(state.categories.find((c:any)=>c.id===item.semantics.subcategory.value)?.name,'Прочий транспорт');assert.equal(item.displayName.title,'B2CPL');assert.equal(item.source.merchantText,'B2CPL');assert.equal(item.components.length,0);assert.equal(item.semantics.role.value,'expense');
});

async function interestBatch(bytes:string,rows:ExtractedRow[],profile:'bank-source/5'|'bank-source/4'='bank-source/5'){
 const local=await createLocalPreparation(await context(),undefined,localBankAdapter,profile);
 try{return await local.prepare(randomUUID(),[{fileId:randomUUID(),bank:'tbank',bytes:new TextEncoder().encode(bytes),rows}]);}finally{local.dispose();}
}
test('FIN-T59 HTTP: unknown installment payments have a terminal contract reason and no duplicated purchase expense',async()=>{
 const rows=[row({bankReference:'Synthetic-full-purchase',localDescription:'Покупка Ozon',amountMinor:'-10000',parser:'tbank-table/1'}),row({bankReference:'Synthetic-installment',localDescription:'Очередной платёж Яндекс Сплит',amountMinor:'-2500',parser:'tbank-table/1',localMcc:'5999'})],b=await interestBatch('Synthetic purchase and installment',rows);await accept(b);await drain(b.batchId);
 const state=(await request('/finance/state')).json(),payment=state.operations.find((o:any)=>o.amountMinor==='-2500');assert.equal(payment.financialContract.status,'BLOCKED_UNSUPPORTED_CONTRACT');assert.equal(payment.analyticsRole,'unresolved');assert.equal(state.summary.netExpensesMinor,'10000');assert.equal(state.summary.unresolvedMinor,'2500');assert.equal((await counts()).account,1);
 const detailBefore=await detail(payment.id),ledger=(await pg.owner.query("SELECT * FROM finance.source_observation WHERE user_id='first' ORDER BY id")).rows;await command({kind:'operation',id:payment.id,patch:{role:'neutral'}});const chosen=await detail(payment.id);assert.equal(chosen.projection.analyticsRole,'neutral');assert.equal(chosen.projection.financialContract,undefined);assert.deepEqual(chosen.source,detailBefore.source);assert.deepEqual((await pg.owner.query("SELECT * FROM finance.source_observation WHERE user_id='first' ORDER BY id")).rows,ledger);
});
test('FIN-T92/T93 HTTP: source-local dates survive normalizer upgrade, conflict/cancellation and manual corrections without a duplicate',async()=>{
 const instant='2026-09-30T22:30:00.000Z',input=row({operationDate:{precision:'instant',instant,sourceOffsetMinutes:540},postedDate:{precision:'instant',instant:'2026-10-01T22:30:00.000Z',sourceOffsetMinutes:-600},localDescription:'Покупка Синтетический магазин',parser:'tbank-table/1',bankReference:undefined});
 const c=await context();assert.ok(c.normalizers?.includes('strict-source/2'));
 const legacy=await createLocalPreparation({...c,normalizers:undefined},undefined,localBankAdapter,'bank-source/5');let first:PreparedBatch;try{first=await legacy.prepare(randomUUID(),[{fileId:randomUUID(),bank:'tbank',bytes:new TextEncoder().encode('Synthetic same source calendar'),rows:[input]}]);}finally{legacy.dispose();}
 await accept(first!);await drain(first!.batchId);const original=await importedOperation();assert.ok(original.projection.reviewReasons.includes('source_timezone_unknown'));
 const oldRows=(await pg.owner.query("SELECT * FROM finance.source_observation WHERE user_id='first' ORDER BY id")).rows;
 const next=await interestBatch('Synthetic same source calendar',[input]);await accept(next);assert.equal((await drain(next.batchId)).counts.created,0);let current=await detail(original.id);assert.equal(current.source.operationDate.sourceOffsetMinutes,540);assert.equal(current.source.postedDate.sourceOffsetMinutes,-600);assert.ok(!current.projection.reviewReasons.includes('source_timezone_unknown'));assert.equal((await counts()).transaction,1);
 assert.deepEqual((await pg.owner.query("SELECT * FROM finance.source_observation WHERE user_id='first' AND id=ANY($1::uuid[]) ORDER BY id",[oldRows.map(r=>r.id)])).rows,oldRows);
 const page=(await request('/finance/operations-page',{query:{filter:{from:'2026-10-01',through:'2026-10-01'}}})).json();assert.equal(page.total,1);
 const conflict=await interestBatch('Synthetic conflicting explicit offset',[{...input,operationDate:{precision:'instant',instant,sourceOffsetMinutes:-600}}]);await accept(conflict);await drain(conflict.batchId);current=await detail(original.id);assert.equal(current.source.operationDate.sourceOffsetMinutes,null);assert.ok(current.projection.reviewReasons.includes('source_timezone_conflict'));
 await command({kind:'operation',id:original.id,patch:{corrections:{operationDate:{precision:'day',date:'2026-10-03'},postedDate:null}}});current=await detail(original.id);assert.equal(current.projection.date.date,'2026-10-03');assert.ok(!current.projection.reviewReasons.includes('source_timezone_conflict'));assert.equal((await request('/finance/operations-page',{query:{filter:{postedFrom:'2026-10-01'}}})).json().total,0);
 await command({kind:'cancel_import',batchId:conflict.batchId});current=await detail(original.id);assert.equal(current.source.operationDate.sourceOffsetMinutes,540);assert.equal(current.projection.date.date,'2026-10-03');await command({kind:'operation',id:original.id,patch:{corrections:{}}});
 await command({kind:'cancel_import',batchId:next.batchId});current=await detail(original.id);assert.ok(current.projection.reviewReasons.includes('source_timezone_unknown'));assert.equal(current.source.operationDate.sourceOffsetMinutes,undefined);assert.equal(current.source.amountMinor,'-100');
});
test('FIN-T49/T50 HTTP: /5 incoming deposit interest and paid loan interest retain bank facts through repeat, corrections reset and cancellation',async()=>{
 const input=[row({bankReference:'Synthetic-received-interest',localDescription:'Начисление процентов по вкладу',amountMinor:'450000',direction:'credit',parser:'tbank-table/1'}),row({bankReference:'Synthetic-paid-interest',localDescription:'Уплата процентов по кредиту',amountMinor:'-50000',direction:'debit',parser:'tbank-table/1'})];
 const first=await interestBatch('Synthetic interest first',input);await accept(first);await drain(first.batchId);const state=(await request('/finance/state')).json(),received=state.operations.find((o:any)=>o.amountMinor==='450000'),paid=state.operations.find((o:any)=>o.amountMinor==='-50000');
 assert.equal(received.analyticsRole,'income');assert.equal(paid.analyticsRole,'expense');assert.equal(state.summary.incomeMinor,'450000');assert.equal(state.summary.netExpensesMinor,'50000');assert.equal(state.categories.find((c:any)=>c.id===received.classification.subcategory.value)?.name,'Проценты по счетам и вкладам');assert.equal(state.categories.find((c:any)=>c.id===paid.classification.subcategory.value)?.name,'Проценты');
 const before=await detail(received.id);assert.equal(before.source.sourceKind,'other');assert.equal(before.semantics.kind.value,'interest');assert.equal(before.semantics.kind.source,'deterministic_system_rule');
 const oldObservations=(await pg.owner.query("SELECT * FROM finance.source_observation WHERE user_id='first' ORDER BY id")).rows;
 await command({kind:'operation',id:received.id,patch:{corrections:{amountMinor:'450001'},comment:'Мои проценты'}});assert.equal((await detail(received.id)).projection.analyticsRole,'income');await command({kind:'operation',id:received.id,patch:{corrections:{}}});assert.equal((await detail(received.id)).projection.amountMinor,'450000');
 const again=await interestBatch('Synthetic interest repeat',input);await accept(again);assert.equal((await drain(again.batchId)).counts.existing,2);assert.equal((await counts()).transaction,2);
 assert.deepEqual((await pg.owner.query("SELECT * FROM finance.source_observation WHERE user_id='first' AND id=ANY($1::uuid[]) ORDER BY id",[oldObservations.map(o=>o.id)])).rows,oldObservations);
 await command({kind:'cancel_import',batchId:again.batchId});const restored=await detail(received.id);assert.equal(restored.projection.analyticsRole,'income');assert.equal(restored.comment,'Мои проценты');assert.equal(restored.source.amountMinor,'450000');assert.equal(restored.source.sourceKind,'other');
 assert.equal(Number((await pg.owner.query("SELECT count(*) AS n FROM finance.classification_run WHERE user_id='first'")).rows[0].n),0);
});
test('FIN-P04/P09 HTTP: private interest role and a later verified decision survive repeat and cancellation',async()=>{
 await command({kind:'rule',id:randomUUID(),create:true,patch:{name:'Личное учётное решение',enabled:true,priority:1,conditions:{descriptionContains:'процентов по вкладу'},assignments:{role:'neutral'}}});
 const rows=[row({localDescription:'Начисление процентов по вкладу',amountMinor:'450000',direction:'credit',parser:'tbank-table/1'})],first=await interestBatch('Synthetic private interest',rows);await accept(first);await drain(first.batchId);let op=await importedOperation();assert.equal(op.semantics.role.source,'personal_rule');assert.equal(op.projection.analyticsRole,'neutral');
 await command({kind:'operation',id:op.id,patch:{role:'income',merchant:'Мой вклад'}});const again=await interestBatch('Synthetic private interest repeat',rows);await accept(again);await drain(again.batchId);await command({kind:'cancel_import',batchId:again.batchId});op=await detail(op.id);assert.equal(op.semantics.role.userVerified,true);assert.equal(op.projection.analyticsRole,'income');assert.equal(op.semantics.merchant.value,'Мой вклад');
});
test('FIN-P09 HTTP: deleting the only /5 evidence removes inferred interest while retained legacy facts stay unresolved',async()=>{
 const rows=[row({localDescription:'Начисление процентов по вкладу',amountMinor:'450000',direction:'credit',parser:'tbank-table/1'})];
 const current=await interestBatch('Synthetic current interest',rows);await accept(current);await drain(current.batchId);const id=(await importedOperation()).id;assert.equal((await detail(id)).semantics.kind.value,'interest');
 const old=await interestBatch('Synthetic legacy retained',rows,'bank-source/4');await accept(old);await drain(old.batchId);await command({kind:'cancel_import',batchId:current.batchId});const restored=await detail(id);assert.equal(restored.source.versions.sourceSanitizer,'bank-source/4');assert.equal(restored.semantics.kind.value,'other');assert.equal(restored.projection.analyticsRole,'unresolved');assert.equal(restored.semantics.category.value,null);
});
test('FIN-P09 HTTP: a full financial reset and fresh import do not resurrect the wrong interest initializer',async()=>{
 const rows=[row({localDescription:'Начисление процентов по вкладу',amountMinor:'450000',direction:'credit',parser:'tbank-table/1'})],first=await interestBatch('Synthetic interest before reset',rows);await accept(first);await drain(first.batchId);const before=await importedOperation();
 await command({kind:'reset_financial',keepCategories:true,keepRules:true,keepInterface:true});assert.equal((await counts()).transaction,0);
 const fresh=await interestBatch('Synthetic interest after reset',rows);await accept(fresh);await drain(fresh.batchId);const after=await importedOperation();assert.notEqual(after.id,before.id);assert.equal(after.projection.analyticsRole,'income');assert.equal(after.source.amountMinor,'450000');assert.equal(after.source.description,before.source.description);
});
