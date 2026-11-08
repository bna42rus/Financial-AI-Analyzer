import {useState} from 'react';
import {LifeBuoy} from 'lucide-react';
import {OperationDialog} from './OperationDialog';
import common from './App.module.css';

export const supportEmail=String(import.meta.env.VITE_PUBLIC_SUPPORT_EMAIL||'support@cashneuro.ru').trim();

function CopySupportAddress(){
 const [status,setStatus]=useState('');
 async function copy(){
  try{await navigator.clipboard.writeText(supportEmail);setStatus('Адрес скопирован.');}
  catch{setStatus('Не удалось скопировать адрес.');}
 }
 return <>
  <button type="button" className={common.button} onClick={()=>void copy()}>Скопировать адрес</button>
  {status&&<span role="status">{status}</span>}
 </>;
}

export function SupportLink({className=common.button,children='Поддержка',showIcon=false}:{className?:string;children?:string;showIcon?:boolean}){
 const [open,setOpen]=useState(false);
 return <>
  <button type="button" className={className} aria-label={showIcon?children:undefined} onClick={()=>setOpen(true)}>{showIcon?<><LifeBuoy size={17} aria-hidden="true"/><span>{children}</span></>:children}</button>
  {open&&<OperationDialog compact title="Поддержка CashNeuro" onClose={()=>setOpen(false)} footer={<CopySupportAddress/>}>
   <p>Напишите нам — поможем разобраться.</p>
   <strong>{supportEmail}</strong>
  </OperationDialog>}
 </>;
}
