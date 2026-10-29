import * as Dialog from '@radix-ui/react-dialog';
import {useLayoutEffect,useRef,useState} from 'react';
import type {ReactNode} from 'react';
import {ChevronDown,X} from 'lucide-react';
import common from './App.module.css';
import styles from './Overview.module.css';
export function OverviewPopover({label,children,icon}:{label:string;children:ReactNode;icon?:ReactNode}){
 const [open,setOpen]=useState(false),[position,setPosition]=useState({left:12,top:60,width:320}),trigger=useRef<HTMLButtonElement>(null);
 useLayoutEffect(()=>{if(!open)return;const place=()=>{const r=trigger.current?.getBoundingClientRect();if(r){const width=Math.min(340,innerWidth-24);setPosition({left:Math.max(12,Math.min(r.right-width,innerWidth-width-12)),top:r.bottom+6,width});}};place();addEventListener('resize',place);addEventListener('scroll',place,true);return()=>{removeEventListener('resize',place);removeEventListener('scroll',place,true);};},[open]);
 return <Dialog.Root open={open} onOpenChange={setOpen}><Dialog.Trigger asChild><button ref={trigger} className={common.button+' '+styles.viewTrigger} aria-label={label} title={label}>{icon??<><span>{label}</span><ChevronDown size={15}/></>}</button></Dialog.Trigger><Dialog.Portal><Dialog.Overlay className={styles.popoverOverlay}/><Dialog.Content className={styles.popover} style={position} aria-describedby={undefined}><div className={styles.popoverHead}><Dialog.Title>{label}</Dialog.Title><Dialog.Close asChild><button className={common.iconButton} aria-label={'Закрыть: '+label}><X size={17}/></button></Dialog.Close></div><div onClick={e=>{if((e.target as HTMLElement).closest('[data-close-popover]'))setOpen(false);}}>{children}</div></Dialog.Content></Dialog.Portal></Dialog.Root>;
}
export function OverviewDialog({title,children,onClose,description}:{title:string;children:ReactNode;onClose:()=>void;description?:string}){
 const opener=useRef<HTMLElement|null>(null);
 return <Dialog.Root open onOpenChange={open=>{if(!open)onClose();}}><Dialog.Portal><Dialog.Overlay className={common.overlay}/><Dialog.Content onOpenAutoFocus={()=>{opener.current=document.activeElement instanceof HTMLElement?document.activeElement:null;}} onCloseAutoFocus={e=>{e.preventDefault();const target=opener.current?.isConnected?opener.current:document.querySelector<HTMLButtonElement>('button[aria-label="Представления обзора"]');target?.focus({preventScroll:true});}} onInteractOutside={e=>e.preventDefault()} className={common.dialog+' '+styles.workspaceDialog} {...(!description?{'aria-describedby':undefined}:{})}><div className={common.dialogHead}><Dialog.Title>{title}</Dialog.Title><Dialog.Close asChild><button className={common.iconButton} aria-label={'Закрыть: '+title}><X size={20}/></button></Dialog.Close></div>{description&&<Dialog.Description>{description}</Dialog.Description>}{children}</Dialog.Content></Dialog.Portal></Dialog.Root>;
}
