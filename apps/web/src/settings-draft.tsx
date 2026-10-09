import {useState} from 'react';
import type {ReactNode} from 'react';
import type {FinanceState} from './finance-client';
import type {WorkspaceCommand,WorkspaceIntent} from './workspace-command';
import common from './App.module.css';
import styles from './Workspace.module.css';
export type EditorProps={state:FinanceState;command:WorkspaceCommand|null;disabled:boolean;close:()=>void};
export function useSettingsDraft(props:EditorProps){
 const [snapshot]=useState(()=>structuredClone(props.state)),[error,setError]=useState('');
 const stale=snapshot.generation!==props.state.generation||snapshot.revision!==props.state.revision;
 return {snapshot,error,stale,locked:props.disabled||stale,submit:(build:()=>WorkspaceIntent,title:string,confirm=true)=>{if(props.disabled||stale)return;try{const intent=build();setError('');void props.command?.begin(intent,title,confirm,snapshot);}catch(e){setError(e instanceof Error?e.message:'Проверьте поля.');}}};
}
export function DraftFrame({title,close,error,stale,children}:{title:string;close:()=>void;error:string;stale:boolean;children:ReactNode}){
 return <section className={styles.preview} aria-label={title}><h3>{title}</h3>{stale&&<p role="alert">Данные изменились после открытия формы. Эту форму больше нельзя отправить. Закройте редактор и откройте его заново с текущими данными.</p>}{error&&<p role="alert">{error}</p>}{children}<button type="button" className={common.button} onClick={close}>Закрыть редактор настроек</button></section>;
}
export function operationName(state:FinanceState,id:string){const op=state.operations.find(o=>o.id===id);return op?.classification.merchant.value||'Операция без названия';}
