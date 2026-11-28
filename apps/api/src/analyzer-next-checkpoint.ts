/** Private server checkpoint, never a provider/client payload. The existing
 * runtime key authenticates stored state; the DB adapter must still authorize
 * access and atomically commit it with the answer and request receipt. */
import {createHmac,timingSafeEqual} from 'node:crypto';
import {object} from '../../../packages/finance-core/src/model.ts';
import {PrototypeSession} from '../../../packages/analyzer/src/next/workflow.ts';
import type {State} from '../../../packages/analyzer/src/next/tasks.ts';
import type {TaskScope} from '../../../packages/analyzer/src/task-context.ts';

export const nextCheckpointVersion='cashneuro-next-checkpoint/1';
const limit=2*1024*1024;
export type NextCheckpoint={version:typeof nextCheckpointVersion;payload:string;mac:string};
function invalid():never{throw new TypeError('NEXT_CHECKPOINT_INVALID');}
function signature(payload:string,key:Uint8Array){
 if(!(key instanceof Uint8Array)||key.byteLength!==32)invalid();
 return createHmac('sha256',key).update(nextCheckpointVersion+'\0').update(payload).digest();
}
export function sealNextSession(session:PrototypeSession,key:Uint8Array):NextCheckpoint{
 if(!(session instanceof PrototypeSession))invalid();
 const state=session.snapshot();
 // Running work has no committed answer. Keep its request journal and recover
 // against the preceding stable checkpoint instead.
 if(state.running!==null)throw new TypeError('NEXT_CHECKPOINT_BUSY');
 const payload=JSON.stringify({version:nextCheckpointVersion,state});
 if(Buffer.byteLength(payload)>limit)throw new TypeError('NEXT_CHECKPOINT_TOO_LARGE');
 return {version:nextCheckpointVersion,payload,mac:signature(payload,key).toString('hex')};
}
function authenticatedState(raw:unknown,key:Uint8Array):State{
  const r=object(raw,['version','payload','mac']);
  if(r.version!==nextCheckpointVersion||typeof r.payload!=='string'||Buffer.byteLength(r.payload)>limit||typeof r.mac!=='string'||!/^[a-f0-9]{64}$/.test(r.mac))invalid();
  if(!timingSafeEqual(signature(r.payload,key),Buffer.from(r.mac,'hex')))invalid();
  const saved=object(JSON.parse(r.payload),['version','state']);
  if(saved.version!==nextCheckpointVersion)invalid();
  return saved.state as State;
}
export function restoreNextSession(scope:TaskScope,raw:unknown,key:Uint8Array):PrototypeSession{
 try{return PrototypeSession.fromTrustedCheckpoint(scope,authenticatedState(raw,key));}catch{invalid();}
}
/** Only the DB adapter may rebind a surviving chat after its generation-reset
 * trigger updates the row. Owner/chat lifetime stay fixed; full key reset deletes
 * the chat via the existing cascade instead. Default restoration stays strict. */
export function restoreNextSessionForStore(scope:TaskScope,raw:unknown,key:Uint8Array,storedGeneration:string):PrototypeSession{
 try{
  if(storedGeneration!==scope.generation)invalid();
  const saved=authenticatedState(raw,key),state=PrototypeSession.fromTrustedCheckpoint(saved.scope,saved).snapshot();
  if(['ownerId','chatId','chatEpoch'].some(k=>state.scope[k as keyof TaskScope]!==scope[k as keyof TaskScope]))invalid();
  if(state.scope.generation!==scope.generation){state.scope.generation=scope.generation;state.book.scope.generation=scope.generation;state.revision++;}
  return PrototypeSession.fromTrustedCheckpoint(scope,state);
 }catch{invalid();}
}
