import {useId,useState} from 'react';
import type {ReactNode} from 'react';
import type {FinanceState} from './finance-client';
import {ChevronDown,FolderTree,Search} from 'lucide-react';
import styles from './CategoryTree.module.css';
type Category=FinanceState['categories'][number];
export function categoryGroups(categories:readonly Category[],query:string,role:string,showHidden:boolean){
 const fold=(s:string)=>s.normalize('NFKC').toLocaleLowerCase('ru').replaceAll('ё','е').trim(),q=fold(query),allowed=(c:Category)=>(showHidden||!c.hidden)&&(role==='all'||c.role===role||c.role==='both');
 const rootIds=new Set(categories.filter(c=>c.parentId===null).map(c=>c.id)),roots=categories.filter(c=>c.parentId===null).sort((a,b)=>a.name.localeCompare(b.name,'ru',{numeric:true})||a.id.localeCompare(b.id));
 const groups=roots.flatMap(root=>{const children=categories.filter(c=>c.parentId===root.id&&allowed(c)),parentMatches=allowed(root)&&(!q||fold(root.name).includes(q)),shown=children.filter(c=>parentMatches||!q||fold(c.name).includes(q));return parentMatches||shown.length?[{root,children:shown}]:[];});
 const orphans=categories.filter(c=>c.parentId!==null&&!rootIds.has(c.parentId)&&allowed(c)&&(!q||fold(c.name).includes(q)));
 return {groups,orphans};
}
export function CategoryTree({categories,renderItem}:{categories:readonly Category[];renderItem:(category:Category)=>ReactNode}){
 const id=useId(),[query,setQuery]=useState(''),[role,setRole]=useState('all'),[showHidden,setShowHidden]=useState(true),[expanded,setExpanded]=useState<Set<string>>(()=>new Set());
 const {groups,orphans}=categoryGroups(categories,query,role,showHidden),toggle=(key:string)=>setExpanded(before=>{const next=new Set(before);if(next.has(key))next.delete(key);else next.add(key);return next;});
 return <section className={styles.tree} aria-label="Дерево категорий"><div className={styles.tools}><label className={styles.search}><Search size={17} aria-hidden="true"/><input aria-label="Поиск категорий" type="search" placeholder="Найти категорию" value={query} onChange={e=>setQuery(e.target.value)}/></label><label>Показывать<select aria-label="Смысл категорий" value={role} onChange={e=>setRole(e.target.value)}><option value="all">Все категории</option><option value="expense">Расходы</option><option value="income">Доходы</option></select></label></div><div className={styles.caption}><p>Категорий: {categories.length}. Скрытых: {categories.filter(c=>c.hidden).length}.</p><label><input type="checkbox" checked={showHidden} onChange={e=>setShowHidden(e.target.checked)}/>Показывать скрытые</label></div>
 <div className={styles.groups}>{groups.map(({root,children})=>{const open=!!query.trim()||expanded.has(root.id),region=id+'-'+root.id;return <div className={styles.group} key={root.id}><button type="button" className={styles.heading} aria-expanded={open} aria-controls={region} onClick={()=>toggle(root.id)}><FolderTree size={19} aria-hidden="true"/><span><strong>{root.name}{root.hidden?' · Скрыта':''}</strong><small>{root.role==='income'?'Доходы':root.role==='expense'?'Расходы':'Общая категория'} · Подкатегорий: {children.length}</small></span><ChevronDown size={18} className={open?styles.rotate:undefined} aria-hidden="true"/></button>{open&&<div id={region} className={styles.content} role="region" aria-label={'Категория: '+root.name}>{renderItem(root)}{children.map(c=><div className={styles.child} key={c.id}>{renderItem(c)}</div>)}</div>}</div>;})}</div>
 {!!orphans.length&&<section><h3>Проверьте структуру категорий</h3><p>Для этих категорий не найдена родительская группа. Они сохранены; выберите подходящую структуру.</p>{orphans.map(c=>renderItem(c))}</section>}{!groups.length&&!orphans.length&&<p role="status">Категории по этим условиям не найдены. Измените поиск или фильтр.</p>}
 </section>;
}
