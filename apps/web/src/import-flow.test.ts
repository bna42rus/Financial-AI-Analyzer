import {test,expect,vi} from 'vitest';
import {ImportFlow} from './import-flow';
import type {ImportDependencies,ImportFlowState} from './import-flow';
import type {PreparedBatch} from '../../../packages/imports/src/contract';
import type {ImportReport} from '../../../packages/imports/src/report';
import {ApiError} from './server-client';
const file=()=>new File(['Artificial bytes'],'Private filename.pdf');
const batch=()=>({batchId:crypto.randomUUID(),files:[{fileId:crypto.randomUUID(),status:'prepared',rows:[]}]} as unknown as PreparedBatch);
const report=(b:PreparedBatch)=>({batchId:b.batchId,status:'accepted'} as ImportReport);
function harness(overrides:Partial<ImportDependencies>={}){
 const b=batch(),events:ImportFlowState[]=[],accepted=vi.fn();
 const dependencies:ImportDependencies={context:vi.fn(async()=>({key:'Private local key'} as any)),prepare:vi.fn(async()=>({batch:b,localIssues:[]})),accept:vi.fn(async()=>report(b)),...overrides};
 const flow=new ImportFlow(dependencies,s=>events.push(s),accepted);return {flow,dependencies,events,accepted,b};
}
test('network handoff receives only the prepared batch and never File, filename, password or key',async()=>{
 const h=harness();await h.flow.choose([file()]);expect(h.dependencies.accept).toHaveBeenCalledWith(h.b);expect(JSON.stringify((h.dependencies.accept as any).mock.calls)).not.toContain('Private');expect(h.accepted).toHaveBeenCalledOnce();expect(h.events.at(-1)?.phase).toBe('idle');
});
test('lost acknowledgement retries the identical batch and concurrent retry clicks cannot double-submit',async()=>{
 let release:(r:ImportReport)=>void=()=>{};const accept=vi.fn().mockRejectedValueOnce(new ApiError('NETWORK_ERROR','Network unavailable')).mockImplementationOnce(()=>new Promise<ImportReport>(resolve=>{release=resolve;}));const h=harness({accept});await h.flow.choose([file()]);expect(h.events.at(-1)?.phase).toBe('retry');const retry=h.flow.retry();await h.flow.retry();expect(accept).toHaveBeenCalledTimes(2);expect(accept.mock.calls[0]![0]).toBe(accept.mock.calls[1]![0]);release(report(h.b));await retry;expect(h.accepted).toHaveBeenCalledOnce();
});
test('server recovery clears an uncertain handoff without resubmitting it or changing batch identity',async()=>{
 const accept=vi.fn(async()=>{throw new ApiError('NETWORK_ERROR','Unconfirmed');}),h=harness({accept});await h.flow.choose([file()]);h.flow.recover({batchId:crypto.randomUUID()} as ImportReport);expect(h.events.at(-1)?.phase).toBe('retry');h.flow.recover(report(h.b));expect(h.events.at(-1)?.phase).toBe('idle');await h.flow.retry();expect(accept).toHaveBeenCalledOnce();
});
test('a late handoff failure cannot undo confirmed server recovery or call acceptance twice',async()=>{
 let fail:(e:Error)=>void=()=>{};const accept=vi.fn(()=>new Promise<ImportReport>((_r,reject)=>{fail=reject;})),h=harness({accept});const started=h.flow.choose([file()]);await vi.waitFor(()=>expect(accept).toHaveBeenCalledOnce());h.flow.recover(report(h.b));fail(new ApiError('NETWORK_ERROR','Late failure'));await started;expect(h.events.at(-1)?.phase).toBe('idle');expect(h.accepted).toHaveBeenCalledOnce();await h.flow.retry();expect(accept).toHaveBeenCalledOnce();
});
test('closing local preparation aborts the reader and a late result cannot be submitted',async()=>{
 let finish:(r:any)=>void=()=>{};const prepare=vi.fn(()=>new Promise<any>(resolve=>{finish=resolve;})),h=harness({prepare});const started=h.flow.choose([file()]);await vi.waitFor(()=>expect(prepare).toHaveBeenCalledOnce());const signal=(prepare.mock.calls as unknown as unknown[][])[0]![3] as AbortSignal;h.flow.close();expect(signal.aborted).toBe(true);finish({batch:h.b,localIssues:[]});await started;expect(h.dependencies.accept).not.toHaveBeenCalled();expect(h.events.at(-1)?.phase).toBe('idle');
});
test('leaving the account disposes local references and suppresses late UI updates',async()=>{
 let resolve:(r:any)=>void=()=>{};const h=harness({context:()=>new Promise<any>(r=>{resolve=r;})});const started=h.flow.choose([file()]);const count=h.events.length;h.flow.dispose();resolve({key:'Private local key'});await started;expect(h.events).toHaveLength(count);expect(h.dependencies.prepare).not.toHaveBeenCalled();
});
test('password-only attempts remain local; fresh retries use new file IDs and clear password values',async()=>{
 let calls=0,seenPassword='',firstId='';const h=harness({prepare:async(_c,_b,inputs)=>{calls++;if(calls===1){firstId=inputs[0]!.fileId;return {batch:null,localIssues:[{fileId:firstId,code:'PASSWORD_REQUIRED'}]};}seenPassword=inputs[0]!.password!;expect(inputs[0]!.fileId).not.toBe(firstId);return {batch:batch(),localIssues:[]};}});await h.flow.choose([file()]);expect(h.dependencies.accept).not.toHaveBeenCalled();const id=h.events.at(-1)!.locked[0]!.fileId;await h.flow.unlock({[id]:'Private PDF password'});expect(seenPassword).toBe('Private PDF password');expect(JSON.stringify((h.dependencies.accept as any).mock.calls)).not.toContain('Private');
});
test('one unreadable or unsupported file preserves a valid prepared file and technical local issues',async()=>{
 const h=harness({prepare:async(_c,_b,inputs)=>({batch:batch(),localIssues:[{fileId:inputs[1]!.fileId,code:'LOCAL_READ_FAILED'}]})});await h.flow.choose([file(),new File(['a'],'Unreadable.pdf'),new File(['a'],'Private.docx')]);expect(h.dependencies.accept).toHaveBeenCalledOnce();expect(h.events.at(-1)?.issues.map(i=>i.code)).toEqual(['UNSUPPORTED_FILE','LOCAL_READ_FAILED']);
});
test('expired preparation discards the unsent batch instead of retrying it under a new context',async()=>{
 const h=harness({accept:vi.fn(async()=>{throw new ApiError('IMPORT_CONTEXT_EXPIRED','Choose files again');})});await h.flow.choose([file()]);expect(h.events.at(-1)?.phase).toBe('idle');await h.flow.retry();expect(h.dependencies.accept).toHaveBeenCalledOnce();expect(h.events.at(-1)?.error).toBe('Choose files again');
});
test('all invalid selections need no server key or upload and do not invent source fingerprints',async()=>{
 const h=harness();await h.flow.choose([new File([],'Empty.pdf'),new File(['a'],'Private.zip')]);expect(h.dependencies.context).not.toHaveBeenCalled();expect(h.dependencies.accept).not.toHaveBeenCalled();expect(h.events.at(-1)?.issues).toHaveLength(2);await h.flow.choose(Array.from({length:11},file));expect(h.events.at(-1)?.error).toContain('10');
});
