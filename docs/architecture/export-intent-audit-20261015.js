// Read-only operator inspection. Run as module stdin from the pinned API checkout.
import { createDecipheriv, createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { join } from 'node:path';
import { readPilotJson } from './src/task-pilot-journal.ts';
import { BenchmarkLedger, benchmarkDigest } from './src/benchmark-ledger.ts';
import { loadTrialCorpus, trialRequestId } from './src/task-trial.ts';
import { privateJson } from './src/kms.ts';
const fail = () => { throw Error('INTENT_AUDIT_EXPORT_CHECK_FAILED'); };
const dir='/var/lib/cashneuro/analyzer-benchmark', binding='0167d21fd279fa1df5cac60df29fa86f6966a164f270dff5e636cf6cb0e1e4fa';
if(process.getuid?.()!==0) fail();
const frozen=await readPilotJson(join(dir,'task-intent-trial-v1.json'));
if(frozen.hash!==benchmarkDigest(frozen.payload)||frozen.hash!=='767ac28da3b8811a700d5844de6ddb48b8814045434dc52f4bff482711896e34'||frozen.payload.bindingSha256!==binding) fail();
const ledger=await BenchmarkLedger.load(join(dir,'smoke-ledger.jsonl'),{readOnly:true});
try {
 if(ledger.previous!=='9af593b96f72a742b2117ab34c403da8d62bbd601fe6ad65c6009fb042b8a568'||ledger.records.size!==753) fail();
 const {corpus}=await loadTrialCorpus(), slots=[];
 for(const turn of [...corpus.singles,...corpus.dialogs.flatMap(d=>d.turns)]) if(turn.split==='development') slots.push({turn,occurrence:0});
 for(const r of corpus.repetitions) for(let occurrence=1;occurrence<=r.additionalIndependentCopies;occurrence++) slots.push({turn:corpus.singles.find(t=>t.id===r.caseId),occurrence});
 const records=[]; let key;
 for(const {turn,occurrence} of slots) {
  const id=trialRequestId(binding,turn.id,'gate',occurrence), receipt=ledger.records.get(id)?.receipt;
  if(!receipt) continue;
  if(!frozen.payload.requestIds.includes(id)||!receipt.usage||receipt.code!==null) fail();
  const saved=await readPilotJson(join(dir,'task-intent-trial-v1-cache',id+'.json'));
  if(saved.hash!==benchmarkDigest(saved.payload)||saved.payload.id!==id||saved.payload.wireSha256!==receipt.value.wireSha256) fail();
  let value=saved.payload.value, validationCode=null;
  if(saved.payload.code!==null) {
   if(saved.payload.code!=='TASK_PILOT_PAYLOAD_INVALID'||value!==null) fail();
   const capsule=await readPilotJson(join(dir,'task-json-error-'+id+'.json')), c=capsule.payload;
   if(capsule.hash!==benchmarkDigest(c)||c.id!==id||c.kind!=='payload_rejection'||c.httpStatus!==200||c.truncated!==false||c.wireSha256!==receipt.value.wireSha256||c.cipher!=='aes-256-gcm') fail();
   key??=Buffer.from((await readPilotJson(join(dir,'task-json-error-key.json'))).key,'base64');
   const nonce=Buffer.from(c.nonce,'base64'), tag=Buffer.from(c.tag,'base64');
   if(key.length!==32||nonce.length!==12||tag.length!==16) fail();
   const decipher=createDecipheriv('aes-256-gcm',key,nonce); decipher.setAuthTag(tag);
   const raw=Buffer.concat([decipher.update(Buffer.from(c.encrypted,'base64')),decipher.final()]);
   if(raw.length!==c.bodyBytesCaptured||raw.length>16384||createHash('sha256').update(raw).digest('hex')!==c.bodySha256) fail();
   value=JSON.parse(raw.toString('utf8')); validationCode=c.safeMessage;
  }
  records.push({id,caseId:turn.id,occurrence,question:turn.question,wireSha256:receipt.value.wireSha256,usage:receipt.usage,validationCode,value});
 }
 if(records.length!==88||records.filter(r=>r.validationCode!==null).length!==23) fail();
 const audit={audit:'cashneuro-intent-cached-decisions/1',bindingSha256:binding,frozenSha256:frozen.hash,ledgerHeadSha256:ledger.previous,paidCalls:0,records};
 const text=JSON.stringify(audit), keys=await privateJson('/etc/cashneuro/ai/benchmark/provider-keys.json');
 const secrets=[keys.cloud?.apiKey,keys.yandex?.apiKey,key?.toString('base64'),key?.toString('hex')].filter(s=>typeof s==='string'&&s.length>0);
 for(const secret of secrets) for(const variant of [secret,encodeURIComponent(secret),Buffer.from(secret).toString('base64')]) if(text.includes(variant)) throw Error('INTENT_AUDIT_REFLECTED_SECRET_DENIED');
 console.log('CASHNEURO_INTENT_AUDIT_V1 '+gzipSync(Buffer.from(text)).toString('base64'));
} finally { await ledger.close(); }
