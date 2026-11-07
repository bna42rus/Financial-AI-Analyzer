import {useState} from 'react';
import {Mail} from 'lucide-react';
import {OperationDialog} from './OperationDialog';
import common from './App.module.css';

export const supportEmail=String(import.meta.env.VITE_PUBLIC_SUPPORT_EMAIL||'support@cashneuro.ru').trim();
export function SupportLink({className=common.button,children='Поддержка'}:{className?:string;children?:string}){
 const [open,setOpen]=useState(false),[copied,setCopied]=useState(false);
 return <><button type="button" className={className} onClick={()=>{setCopied(false);setOpen(true);}}>{children}</button>{open&&<OperationDialog compact title="Поддержка CashNeuro" onClose={()=>setOpen(false)} footer={<><button type="button" className={common.button} onClick={()=>void navigator.clipboard.writeText(supportEmail).then(()=>setCopied(true)).catch(()=>setCopied(false))}>Скопировать адрес</button><a className={common.primaryButton} href={'mailto:'+supportEmail}><Mail size={16}/>Написать письмо</a></>}><p>Напишите, если возникли вопросы об аккаунте, оплате или персональных данных либо если что-то не работает.</p><strong>{supportEmail}</strong>{copied&&<p role="status">Адрес скопирован.</p>}</OperationDialog>}</>;
}
