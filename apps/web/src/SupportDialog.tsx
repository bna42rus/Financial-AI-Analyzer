import {useId,useState} from 'react';
import {Copy,LifeBuoy,Mail} from 'lucide-react';
import {OperationDialog} from './OperationDialog';
import common from './App.module.css';

export const supportEmail=String(import.meta.env.VITE_PUBLIC_SUPPORT_EMAIL||'support@cashneuro.ru').trim();

export function CopySupportAddress({iconOnly=false}:{iconOnly?:boolean}){
 const [status,setStatus]=useState('');
 async function copy(){
  try{await navigator.clipboard.writeText(supportEmail);setStatus('Адрес скопирован.');}
  catch{setStatus('Не удалось скопировать адрес.');}
 }
 return <>
  <button type="button" className={iconOnly?common.iconButton:common.button} aria-label={iconOnly?'Скопировать адрес':undefined} title={iconOnly?'Скопировать адрес':undefined} onClick={()=>void copy()}>
   {iconOnly?<Copy size={16} aria-hidden="true"/>:'Скопировать адрес'}
  </button>
  {status&&<span role="status">{status}</span>}
 </>;
}

const recipient=encodeURIComponent(supportEmail);
const mailOptions=[
 ['Gmail','https://mail.google.com/mail/?view=cm&fs=1&to='+recipient],
 ['Яндекс Почта','https://mail.yandex.ru/compose?to='+recipient],
 ['Mail','https://e.mail.ru/compose/?To='+recipient],
] as const;

export function SupportLink({className=common.button,children='Поддержка',showIcon=false}:{className?:string;children?:string;showIcon?:boolean}){
 const [open,setOpen]=useState(false),[mail,setMail]=useState(false),optionsId=useId();
 return <>
  <button type="button" className={className} aria-label={showIcon?children:undefined} onClick={()=>{setMail(false);setOpen(true);}}>{showIcon?<><LifeBuoy size={17} aria-hidden="true"/><span>{children}</span></>:children}</button>
  {open&&<OperationDialog compact title="Поддержка CashNeuro" onClose={()=>setOpen(false)} footer={<>
   <CopySupportAddress/>
   <button type="button" className={common.primaryButton} aria-expanded={mail} aria-controls={optionsId} onClick={()=>setMail(v=>!v)}><Mail size={16}/>Написать письмо</button>
  </>}>
   <p>Напишите нам — поможем разобраться.</p>
   <strong>{supportEmail}</strong>
   {mail&&<ul id={optionsId}>
    {mailOptions.map(([label,href])=><li key={label}><a href={href} target="_blank" rel="noreferrer">{label}</a></li>)}
    <li><a href={'mailto:'+supportEmail}>Почтовое приложение</a></li>
   </ul>}
  </OperationDialog>}
 </>;
}
