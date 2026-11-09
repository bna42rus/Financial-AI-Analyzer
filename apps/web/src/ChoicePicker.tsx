import * as Dialog from '@radix-ui/react-dialog';
import {ChevronDown,X} from 'lucide-react';
import {useEffect,useId,useLayoutEffect,useRef,useState} from 'react';
import type {ButtonHTMLAttributes,KeyboardEvent,ReactNode} from 'react';
import styles from './ChoicePicker.module.css';

export const foldChoice=(value:string)=>value.normalize('NFKC').toLocaleLowerCase('ru-RU').replaceAll('ё','е').trim();

type Props=Pick<ButtonHTMLAttributes<HTMLButtonElement>,'id'|'className'|'disabled'|'style'|'aria-label'|'aria-invalid'|'aria-describedby'|'aria-labelledby'|'aria-required'|'role'|'value'|'autoFocus'|'tabIndex'> & {
 label:string;
 title:string;
 searchLabel?:string;
 closeLabel?:string;
 placeholder?:string;
 description?:string;
 onReset?:()=>void;
 triggerRef?:React.Ref<HTMLButtonElement>;
 children:(query:string,close:()=>void)=>ReactNode;
};

export function ChoicePicker({label,title,searchLabel,closeLabel='Закрыть список',placeholder='Поиск',description,onReset,triggerRef,children,className,style,disabled,...button}:Props){
 const [open,setOpen]=useState(false),[query,setQuery]=useState(''),[panel,setPanel]=useState<HTMLDivElement|null>(null);
 const trigger=useRef<HTMLButtonElement>(null),search=useRef<HTMLInputElement>(null);
 const hint=useId();

 useEffect(()=>{if(disabled||trigger.current?.matches(':disabled'))setOpen(false);});
 useLayoutEffect(()=>{
  if(!open||!panel)return;
  const place=()=>{
   const anchor=trigger.current?.getBoundingClientRect(),viewport=window.visualViewport;
   if(!anchor)return;
   const offsetTop=viewport?.offsetTop??0,offsetLeft=viewport?.offsetLeft??0;
   const viewHeight=viewport?.height??window.innerHeight,viewWidth=viewport?.width??window.innerWidth;
   const width=Math.max(0,Math.min(360,viewWidth-24));
   const left=Math.max(offsetLeft+12,Math.min(anchor.left,offsetLeft+viewWidth-width-12));
   const below=offsetTop+viewHeight-anchor.bottom-18,above=anchor.top-offsetTop-18;
   const down=below>=200||below>=above;
   panel.style.width=width+'px';
   panel.style.left=left+'px';
   panel.style.maxHeight=Math.min(440,Math.max(0,down?below:above))+'px';
   panel.style.top=(down?anchor.bottom+6:Math.max(offsetTop+12,anchor.top-panel.offsetHeight-6))+'px';
  };
  place();
  const observer=new ResizeObserver(place);
  observer.observe(panel);
  window.addEventListener('resize',place);
  window.addEventListener('scroll',place,true);
  window.visualViewport?.addEventListener('resize',place);
  window.visualViewport?.addEventListener('scroll',place);
  return()=>{
   observer.disconnect();
   window.removeEventListener('resize',place);
   window.removeEventListener('scroll',place,true);
   window.visualViewport?.removeEventListener('resize',place);
   window.visualViewport?.removeEventListener('scroll',place);
  };
 },[open,panel]);

 function navigate(event:KeyboardEvent){
  if(!['ArrowDown','ArrowUp','Enter'].includes(event.key))return;
  const options=Array.from(panel?.querySelectorAll<HTMLInputElement>('input[data-choice-option]:not(:disabled)')??[]);
  if(!options.length)return;
  const index=options.findIndex(option=>option===event.target);
  if(event.target!==search.current&&index<0)return;
  event.preventDefault();
  if(event.key==='Enter'){(options[index]??options[0])?.click();return;}
  const next=event.key==='ArrowDown'?index+1:index<0?options.length-1:index-1;
  (options[next]??search.current)?.focus();
 }

 return <Dialog.Root open={open} onOpenChange={next=>{if(!disabled){setOpen(next);if(next)setQuery('');}}}>
  <Dialog.Trigger asChild>
   <button {...button} ref={node=>{
    trigger.current=node;
    if(typeof triggerRef==='function')triggerRef(node);
    else if(triggerRef)triggerRef.current=node;
   }} type="button" data-select-trigger className={[styles.trigger,className].filter(Boolean).join(' ')} style={{...style,fontSize:'var(--select-font-size)'}} disabled={disabled} title={label}
    onKeyDown={event=>{if(!disabled&&(event.key==='ArrowDown'||event.key==='ArrowUp')){event.preventDefault();setQuery('');setOpen(true);}}}>
    <span className={styles.value}>{label}</span><ChevronDown size={15} aria-hidden="true"/>
   </button>
  </Dialog.Trigger>
  <Dialog.Portal>
   <Dialog.Overlay className={styles.overlay}/>
   <Dialog.Content ref={setPanel} className={styles.menu} data-choice-picker aria-describedby={description?hint:undefined} onKeyDown={navigate}
    onOpenAutoFocus={event=>{event.preventDefault();search.current?.focus({preventScroll:true});}}>
    <Dialog.Title className={styles.srOnly}>{title}</Dialog.Title>
    {description&&<Dialog.Description id={hint} className={styles.srOnly}>{description}</Dialog.Description>}
    <div className={styles.searchRow}>
     <input ref={search} type="search" aria-label={searchLabel??'Поиск: '+title} placeholder={placeholder} value={query} onChange={event=>setQuery(event.target.value)}/>
     {onReset&&<button type="button" className={styles.reset} onClick={()=>{onReset();setQuery('');search.current?.focus();}}>Сбросить</button>}
     <Dialog.Close asChild><button type="button" className={styles.close} aria-label={closeLabel}><X size={17} aria-hidden="true"/></button></Dialog.Close>
    </div>
    <div className={styles.options}>{children(foldChoice(query),()=>setOpen(false))}</div>
   </Dialog.Content>
  </Dialog.Portal>
 </Dialog.Root>;
}

export const choiceStyles=styles;
