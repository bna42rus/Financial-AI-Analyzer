import {ApiError} from './server-client';
import {rebasePatch,safeOperationPatch} from './finance-client';
import type {FinanceDetail,FinancePreview,FinanceReceipt,OperationPatch} from './finance-client';
type Intent={kind:'operation';id:string;patch:OperationPatch}|{kind:'undo';id:string;value:string};
type Attempt={mode:'edit'|'correction'|'undo';baseline:FinanceDetail;intent:Intent};
type Pending={path:string;body:Record<string,unknown>;attempt:Attempt};
export type OperationFlowState={detail:FinanceDetail;phase:'idle'|'sending'|'retry'|'preview'|'conflict'|'stale'|'unavailable';error:string;message:string;preview:FinancePreview|null;conflict:{current:FinanceDetail;attempt:Attempt}|null;undoActionId:string|null};
export type OperationDependencies={request:(path:string,body:Record<string,unknown>)=>Promise<FinancePreview|FinanceReceipt>;load:(id:string)=>Promise<FinanceDetail>};
export class OperationFlow{
 private state:OperationFlowState;private pending:Pending|null=null;private disposed=false;
 constructor(detail:FinanceDetail,private dependencies:OperationDependencies,private changed:(state:OperationFlowState)=>void,private saved:(detail:FinanceDetail)=>void){this.state={detail,phase:'idle',error:'',message:'',preview:null,conflict:null,undoActionId:null};}
 private publish(patch:Partial<OperationFlowState>){if(this.disposed)return;this.state={...this.state,...patch};this.changed({...this.state});}
 private begin(attempt:Attempt){const d=attempt.baseline,body={actionId:crypto.randomUUID(),generation:d.generation,revision:d.revision,intent:attempt.intent};return this.send({path:attempt.mode==='edit'?'/finance/edit':'/finance/preview',body,attempt});}
 edit(patch:OperationPatch){if(this.state.phase!=='idle'||this.disposed)return;return this.begin({mode:'edit',baseline:this.state.detail,intent:{kind:'operation',id:this.state.detail.id,patch:safeOperationPatch(patch)}});}
 correct(patch:OperationPatch){if(this.state.phase!=='idle'||this.disposed)return;return this.begin({mode:'correction',baseline:this.state.detail,intent:{kind:'operation',id:this.state.detail.id,patch:safeOperationPatch(patch)}});}
 undo(){if(this.state.phase!=='idle'||!this.state.undoActionId||this.disposed)return;return this.begin({mode:'undo',baseline:this.state.detail,intent:{kind:'undo',id:crypto.randomUUID(),value:this.state.undoActionId}});}
 retry(){if(this.state.phase==='retry'&&this.pending&&!this.disposed)return this.send(this.pending);}
 confirm(){if(this.state.phase==='preview'&&this.pending&&!this.disposed)return this.send(this.pending);}
 cancelPreview(){if(this.state.phase==='preview'){this.pending=null;this.publish({phase:'idle',preview:null,error:''});}}
 private async send(pending:Pending):Promise<void>{
  if(this.disposed)return;this.pending=pending;this.publish({phase:'sending',error:'',message:'',conflict:null});
  try{
   const result=await this.dependencies.request(pending.path,pending.body);if(this.disposed)return;
   if(result.status==='previewed'){
    const commit={path:'/finance/commit',body:{actionId:result.actionId},attempt:pending.attempt};this.pending=commit;
    if(pending.attempt.mode==='undo'){await this.send(commit);return;}
    this.publish({phase:'preview',preview:result});return;
   }
   this.pending=null;this.publish({undoActionId:pending.attempt.mode==='undo'?null:result.actionId,preview:null,message:pending.attempt.mode==='undo'?'Изменение отменено.':'Изменение сохранено.'});
   try{const detail=await this.dependencies.load(this.state.detail.id);if(this.disposed)return;if(detail.generation!==result.generation){this.publish({phase:'unavailable',error:'Финансовые данные были сброшены. Откройте список заново.'});return;}this.publish({detail,phase:'idle'});this.saved(detail);}
   catch{this.publish({phase:'stale',error:'Изменение сохранено, но карточку не удалось обновить. Обновите её перед следующей правкой.'});}
  }catch(error){if(this.disposed)return;
   const code=error instanceof ApiError?error.code:'NETWORK_ERROR';
   if(['FINANCE_CHANGED','DEPENDENCIES_CHANGED'].includes(code)){
    try{const current=await this.dependencies.load(this.state.detail.id);if(this.disposed)return;this.pending=null;if(current.generation!==pending.attempt.baseline.generation){this.publish({phase:'unavailable',preview:null,error:'Финансовые данные были сброшены. Откройте список заново.'});return;}this.publish({phase:'conflict',preview:null,conflict:{current,attempt:pending.attempt},error:'Операция или связанные данные изменились. Сравните текущую версию и вашу правку.'});}
    catch{this.pending=null;this.publish({phase:'stale',preview:null,error:'Не удалось загрузить текущую версию. Обновите карточку.'});}
   }else if(['AUTH_REQUIRED','FINANCE_ACCESS_REQUIRED','GENERATION_CHANGED','NOT_FOUND'].includes(code)){this.pending=null;this.publish({phase:'unavailable',preview:null,error:error instanceof Error?error.message:'Операция больше недоступна.'});}
   else if(code==='NETWORK_ERROR'){this.publish({phase:'retry',error:'Сервер не подтвердил результат. Повтор использует то же изменение и не выполнит его второй раз.'});}
   else{this.pending=null;this.publish({phase:'idle',preview:null,error:error instanceof Error?error.message:'Не удалось сохранить изменение.'});}
  }
 }
 useCurrent(){const conflict=this.state.conflict;if(!conflict||this.disposed)return;this.pending=null;this.publish({detail:conflict.current,phase:'idle',conflict:null,error:'',preview:null,message:'Открыта текущая версия. Ваша правка не применена.'});this.saved(conflict.current);}
 applyOwn(){const conflict=this.state.conflict;if(!conflict||this.disposed)return;const {attempt,current}=conflict,intent=attempt.intent.kind==='operation'?{...attempt.intent,patch:rebasePatch(attempt.baseline,current,attempt.intent.patch)}:attempt.intent;return this.begin({...attempt,baseline:current,intent});}
 async reload(){if(this.disposed||['sending','retry','preview'].includes(this.state.phase))return;this.publish({phase:'sending',error:''});try{const detail=await this.dependencies.load(this.state.detail.id);if(this.disposed)return;if(detail.generation!==this.state.detail.generation){this.publish({phase:'unavailable',error:'Финансовые данные были сброшены. Откройте список заново.'});return;}this.pending=null;this.publish({detail,phase:'idle',conflict:null,preview:null,message:''});this.saved(detail);}catch(e){this.publish({phase:'unavailable',error:e instanceof Error?e.message:'Операция больше недоступна.'});}}
 dispose(){this.disposed=true;this.pending=null;}
}
