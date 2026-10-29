import * as Dialog from '@radix-ui/react-dialog';
import {useEffect,useId,useLayoutEffect,useRef,useState} from 'react';
import {ChevronDown,X} from 'lucide-react';
import type {FinanceState} from './finance-client';
import styles from './CompactFilters.module.css';
type Category=FinanceState['categories'][number];
const fold=(s:string)=>s.normalize('NFKC').toLocaleLowerCase('ru').replace(/ё/g,'е').trim();
export function CategoryFilter({categories,value,onChange,disabled}:{categories:Category[];value:string[];onChange:(ids:string[])=>void;disabled:boolean}){
 const [open,setOpen]=useState(false),[query,setQuery]=useState(''),[position,setPosition]=useState({left:12,top:12,width:340,height:420});
 const trigger=useRef<HTMLButtonElement>(null),search=useRef<HTMLInputElement>(null),hint=useId();
 const selected=new Set(value),byId=new Map(categories.map(c=>[c.id,c])),available=categories.filter(c=>!c.hidden||selected.has(c.id)),needle=fold(query);
 const matches=(c:Category)=>!needle||fold(c.name).includes(needle);
 const branches=categories.filter(c=>!c.parentId).map(root=>({root,children:available.filter(c=>c.parentId===root.id)})).filter(b=>(!b.root.hidden||selected.has(b.root.id)||b.children.length)&&(matches(b.root)||b.children.some(matches)));
 const orphans=available.filter(c=>c.parentId&&!byId.has(c.parentId)&&matches(c)),missing=value.filter(id=>!byId.has(id));
 const label=value.length>1?'Выбрано несколько':value.length===1?byId.get(value[0]!)?.name??'Недоступная категория':'Все категории';
 useEffect(()=>{if(disabled)setOpen(false);},[disabled]);
 useLayoutEffect(()=>{
  if(!open)return;
  const place=()=>{const r=trigger.current?.getBoundingClientRect();if(!r)return;const width=Math.min(360,window.innerWidth-24),below=window.innerHeight-r.bottom-18,above=r.top-18,down=below>=200||below>=above,height=Math.min(440,Math.max(120,down?below:above));setPosition({width,height,left:Math.max(12,Math.min(r.left,window.innerWidth-width-12)),top:down?r.bottom+6:Math.max(12,r.top-height-6)});};
  place();window.addEventListener('resize',place);window.addEventListener('scroll',place,true);
  return()=>{window.removeEventListener('resize',place);window.removeEventListener('scroll',place,true);};
 },[open]);
 function toggle(c:Category,checked:boolean){const children=categories.filter(child=>child.parentId===c.id).map(child=>child.id),next=value.filter(id=>id!==c.id&&!children.includes(id));onChange(checked?[...next,c.id]:next);}
 function choice(c:Category,parent?:Category){
  const inherited=!!parent&&selected.has(parent.id),checked=selected.has(c.id)||inherited,mixed=!c.parentId&&!checked&&categories.some(child=>child.parentId===c.id&&selected.has(child.id));
  return <label key={c.id} className={parent?styles.child:styles.choice}><input type="checkbox" checked={checked} ref={node=>{if(node)node.indeterminate=mixed;}} disabled={disabled||inherited||c.hidden&&!selected.has(c.id)} aria-label={parent?`Подкатегория «${c.name}» в «${parent.name}»`:`Категория «${c.name}»`} aria-describedby={!c.parentId?hint:undefined} onChange={e=>toggle(c,e.target.checked)}/><span>{c.name}{c.hidden&&<small>Скрытая</small>}</span></label>;
 }
 return <Dialog.Root open={open} onOpenChange={next=>{if(!disabled){setOpen(next);if(next)setQuery('');}}}>
  <Dialog.Trigger asChild><button ref={trigger} type="button" className={styles.categoryTrigger} aria-label="Категории" disabled={disabled} title={label}><span>{label}</span><ChevronDown size={15} aria-hidden="true"/></button></Dialog.Trigger>
  <Dialog.Portal><Dialog.Overlay className={styles.overlay}/><Dialog.Content className={styles.menu} aria-describedby={hint} style={{left:position.left,top:position.top,width:position.width,maxHeight:position.height}} onOpenAutoFocus={e=>{e.preventDefault();search.current?.focus();}}>
   <Dialog.Title className={styles.srOnly}>Выбор категорий</Dialog.Title><Dialog.Description id={hint} className={styles.srOnly}>Родительская категория включает все её подкатегории.</Dialog.Description>
   <div className={styles.searchRow}><input ref={search} type="search" aria-label="Поиск категорий и подкатегорий" placeholder="Найти категорию" value={query} onChange={e=>setQuery(e.target.value)} disabled={disabled}/><button type="button" className={styles.clear} disabled={disabled} onClick={()=>{onChange([]);setQuery('');search.current?.focus();}}>Сбросить</button><Dialog.Close asChild><button type="button" className={styles.close} aria-label="Закрыть категории"><X size={17} aria-hidden="true"/></button></Dialog.Close></div>
   <div className={styles.menuBody}>{branches.map(({root,children})=><div className={styles.branch} key={root.id}>{choice(root)}{children.filter(child=>matches(root)||matches(child)).map(child=>choice(child,root))}</div>)}{orphans.map(c=>choice(c))}{!needle&&missing.map(id=><label className={styles.choice} key={id}><input type="checkbox" checked disabled={disabled} onChange={()=>onChange(value.filter(v=>v!==id))}/><span>Недоступная категория</span></label>)}{!branches.length&&!orphans.length&&(needle||!missing.length)&&<p className={styles.noMatches}>{needle?'Категории не найдены':'Категорий пока нет'}</p>}</div>
  </Dialog.Content></Dialog.Portal>
 </Dialog.Root>;
}
