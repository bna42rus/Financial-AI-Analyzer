import {useState} from 'react';
import type {ReactNode} from 'react';
import type {FinanceState} from './finance-client';
import type {WorkspaceCommand,WorkspaceIntent} from './workspace-command';
import common from './App.module.css';
import {OperationDialog} from './OperationDialog';
import styles from './Settings.module.css';
export type EditorProps={state:FinanceState;command:WorkspaceCommand|null;disabled:boolean;close:()=>void};
export function useSettingsDraft(props:EditorProps){
 const [snapshot]=useState(()=>structuredClone(props.state)),[error,setError]=useState('');
 const stale=snapshot.generation!==props.state.generation||snapshot.revision!==props.state.revision;
 return {snapshot,error,stale,locked:props.disabled||stale,submit:(build:()=>WorkspaceIntent,title:string,confirm=true)=>{if(props.disabled||stale)return;try{const intent=build();setError('');void props.command?.begin(intent,title,confirm,snapshot);}catch(e){setError(e instanceof Error?e.message:'Проверьте поля.');}}};
}
export function DraftFrame({title,close,error,stale,children,footer,disabled=false,narrow=false,wide=false}:{title:string;close:()=>void;error:string;stale:boolean;children:ReactNode;footer?:ReactNode;disabled?:boolean;narrow?:boolean;wide?:boolean}){
 return <OperationDialog title={title} compact={!wide} narrow={narrow} onClose={()=>{if(!disabled)close();}} footer={<><button type="button" className={common.button} disabled={disabled} onClick={close}>Отменить</button>{footer}</>}>
  <div className={styles.settingsStack}>{stale&&<p role="alert">Данные обновились. Откройте окно заново.</p>}{children}{error&&<p className={styles.inlineError} role="alert">{error}</p>}</div>
 </OperationDialog>;
}
export function operationName(state:FinanceState,id:string){const op=state.operations.find(o=>o.id===id);return op?.classification.merchant.value||'Операция без названия';}
