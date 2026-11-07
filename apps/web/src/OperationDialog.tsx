import * as Dialog from '@radix-ui/react-dialog';
import {X} from 'lucide-react';
import {useId,useRef} from 'react';
import type {ReactElement,ReactNode} from 'react';
import {cloneElement} from 'react';
import common from './App.module.css';
import styles from './ServerOperation.module.css';

export function OperationDialog({title,onClose,children,footer,compact=false,narrow=false}:{title:string;onClose:()=>void;children:ReactNode;footer:ReactNode;compact?:boolean;narrow?:boolean}){
 const opener=useRef<HTMLElement|null>(null);
 return <Dialog.Root open onOpenChange={open=>{if(!open)onClose();}}><Dialog.Portal>
  <Dialog.Overlay className={common.overlay}/>
  <Dialog.Content aria-describedby={undefined} data-notifications-inline="true" className={common.dialog+' '+styles.operationDialog+(narrow?' '+styles.narrowDialog:compact?' '+styles.subDialog:'')} onInteractOutside={e=>e.preventDefault()} onOpenAutoFocus={()=>{opener.current=document.activeElement as HTMLElement;}} onCloseAutoFocus={e=>{e.preventDefault();if(opener.current?.isConnected)opener.current.focus({preventScroll:true});}}>
   <header className={common.dialogHead+' '+styles.operationHead}><Dialog.Title>{title}</Dialog.Title><Dialog.Close asChild><button type="button" className={common.iconButton} aria-label={'Закрыть: '+title}><X size={20}/></button></Dialog.Close></header>
   <div className={styles.operationBody}>{children}</div>
   {footer!=null&&<footer className={styles.operationFooter}>{footer}</footer>}
  </Dialog.Content>
 </Dialog.Portal></Dialog.Root>;
}
export function OperationField({label,error,children}:{label:string;error?:string;children:ReactElement<{'aria-label'?:string;'aria-invalid'?:boolean;'aria-describedby'?:string}>}){
 const id=useId();
 return <label>{label}{cloneElement(children,{'aria-label':children.props['aria-label']??label,'aria-invalid':!!error||undefined,'aria-describedby':error?[children.props['aria-describedby'],id].filter(Boolean).join(' '):children.props['aria-describedby']})}{error&&<small className={styles.fieldError} id={id} role="alert">{error}</small>}</label>;
}
