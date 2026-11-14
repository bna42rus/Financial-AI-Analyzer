import {useEffect,useState} from 'react';
import {safeText,sanitizeText} from '../../../packages/privacy/src/text';
import common from './App.module.css';
import workspace from './Workspace.module.css';
/** A refresh may change the saved name, but must never replace a local draft. */
export function nameRefresh(draft:{value:string;baseline:string;conflict:boolean},saved:string){
 if(saved===draft.baseline)return draft;
 if(draft.value===draft.baseline||draft.value===saved)return {value:saved,baseline:saved,conflict:false};
 return {...draft,baseline:saved,conflict:true};
}
export function NameField({id,name,disabled,save}:{id:string;name:string;disabled:boolean;save:(name:string)=>void}){
 const [draft,setDraft]=useState({value:name,baseline:name,conflict:false}),[error,setError]=useState('');
 useEffect(()=>setDraft(d=>nameRefresh(d,name)),[name]);
 return <form className={workspace.form} onSubmit={e=>{e.preventDefault();if(draft.conflict)return;try{const text=safeText(sanitizeText(draft.value),160);if(!text.trim())throw new Error('Укажите название.');setError('');if(text!==name)save(text);}catch(e){setError(e instanceof Error?e.message:'Проверьте название.');}}}>
  <label>Название<input aria-label={`Название: ${name}`} value={draft.value} maxLength={160} disabled={disabled} onChange={e=>setDraft(d=>({...d,value:e.target.value}))}/></label>
  {draft.conflict&&<div role="alert"><p>Сохранённое название изменилось: «{name}». Ваш черновик сохранён. Выберите, какое название оставить.</p><button type="button" className={common.button} disabled={disabled} onClick={()=>setDraft({value:name,baseline:name,conflict:false})}>Использовать сохранённое название</button><button type="button" className={common.button} disabled={disabled} onClick={()=>setDraft(d=>({...d,baseline:name,conflict:false}))}>Продолжить с моим черновиком</button></div>}
  <button className={common.button} disabled={disabled||draft.conflict||draft.value===name}>Сохранить название</button>{error&&<p role="alert">{error}</p>}<input type="hidden" value={id} readOnly/>
 </form>;
}
