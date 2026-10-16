import type {LocalContext} from '../../../packages/imports/src/local';
import type {PreparedBatch} from '../../../packages/imports/src/contract';
import type {ImportReport} from '../../../packages/imports/src/report';
import type {prepareLocalBankFiles} from './import-local';
import {ApiError} from './server-client';

export type LocalIssue={fileId:string;name:string;code:string};
export type ImportFlowState={phase:'idle'|'local'|'sending'|'retry';issues:LocalIssue[];locked:{fileId:string;name:string}[];error:string};
type Input={fileId:string;file:File;password?:string};
export type ImportDependencies={context:(signal:AbortSignal)=>Promise<LocalContext>;prepare:typeof prepareLocalBankFiles;accept:(batch:PreparedBatch)=>Promise<ImportReport>};
const initial=():ImportFlowState=>({phase:'idle',issues:[],locked:[],error:''});
/** Raw File/password/key references never enter a network dependency or persistent storage. */
export class ImportFlow{
 private state=initial();private pending:PreparedBatch|null=null;private locked:Input[]=[];private controller:AbortController|null=null;private turn=0;private disposed=false;
 constructor(private dependencies:ImportDependencies,private changed:(state:ImportFlowState)=>void,private accepted:(report:ImportReport)=>void){}
 private publish(patch:Partial<ImportFlowState>){if(this.disposed)return;this.state={...this.state,...patch};this.changed({...this.state,issues:[...this.state.issues],locked:[...this.state.locked]});}
 private current(turn:number){return !this.disposed&&this.turn===turn;}
 choose(files:File[]){if(this.state.phase!=='idle'||this.disposed)return;return this.start(files.map(file=>({fileId:crypto.randomUUID(),file})));}
 unlock(passwords:Record<string,string>){if(this.state.phase!=='idle'||this.disposed)return;return this.start(this.locked.map(i=>({fileId:crypto.randomUUID(),file:i.file,password:passwords[i.fileId]})));}
 private async start(inputs:Input[]){
  if(!inputs.length)return;
  if(inputs.length>10){this.publish({error:'Выберите не больше 10 файлов за одну загрузку.'});return;}
  const turn=++this.turn,controller=new AbortController();this.controller=controller;this.locked=[];this.publish({phase:'local',error:'',issues:[],locked:[]});
  const issues:LocalIssue[]=[],valid=inputs.filter(i=>{
   const code=!/\.(pdf|csv|xlsx)$/i.test(i.file.name)?'UNSUPPORTED_FILE':i.file.size===0?'EMPTY_FILE':i.file.size>20*1024*1024?'LOCAL_LIMIT':null;
   if(code)issues.push({fileId:i.fileId,name:i.file.name,code});return code===null;
  });
  try{
   if(!valid.length){this.publish({phase:'idle',issues});return;}
   const context=await this.dependencies.context(controller.signal);if(!this.current(turn))return;
   const result=await this.dependencies.prepare(context,crypto.randomUUID(),valid,controller.signal);context.key='';if(!this.current(turn))return;
   for(const issue of result.localIssues){const input=valid.find(i=>i.fileId===issue.fileId)!;issues.push({...issue,name:input.file.name});if(['PASSWORD_REQUIRED','WRONG_PASSWORD'].includes(issue.code))this.locked.push({fileId:input.fileId,file:input.file});}
   this.publish({issues,locked:this.locked.map(i=>({fileId:i.fileId,name:i.file.name}))});
   // All-blocked/password-only attempts stay local; valid files can finish independently.
   if(!result.batch||!result.batch.files.some(f=>f.status==='prepared')){this.publish({phase:'idle'});return;}
   this.pending=result.batch;for(const input of inputs)input.password=undefined;valid.length=0;inputs.length=0;await this.submit();
  }catch(error){if(this.current(turn))this.publish({phase:'idle',error:error instanceof ApiError?error.message:'Не удалось подготовить загрузку. Выберите файлы заново.'});}
  finally{if(this.current(turn))this.controller=null;for(const input of inputs)input.password=undefined;}
 }
 async retry(){if(this.state.phase==='retry'&&!this.disposed)await this.submit();}
 private async submit(){
  const batch=this.pending;if(!batch)return;this.publish({phase:'sending',error:''});
  try{const report=await this.dependencies.accept(batch);if(this.disposed||this.pending!==batch)return;this.pending=null;this.publish({phase:'idle'});this.accepted(report);}
  catch(error){if(this.disposed||this.pending!==batch)return;
   const expired=error instanceof ApiError&&['IMPORT_CONTEXT_EXPIRED','IMPORT_CONTEXT_CHANGED','INVALID_IMPORT_PAYLOAD','IMPORT_BATCH_REUSED','IMPORT_FILE_REUSED'].includes(error.code);
   if(expired)this.pending=null;
   this.publish({phase:expired?'idle':'retry',error:error instanceof ApiError?error.message:'Сервер не подтвердил приём. Повторите отправку подготовленных данных.'});
  }
 }
 recover(report:ImportReport){if(this.pending?.batchId===report.batchId&&!this.disposed){this.pending=null;this.publish({phase:'idle',error:''});this.accepted(report);}}
 close(){
  if(this.state.phase==='local'){++this.turn;this.controller?.abort();this.controller=null;this.publish({phase:'idle',error:''});}
  this.locked=[];this.publish({issues:[],locked:[]});
  // An uncertain handoff retains only the same sanitized batch for idempotent retry.
 }
 dispose(){this.disposed=true;++this.turn;this.controller?.abort();this.controller=null;this.pending=null;this.locked=[];this.state=initial();}
}
