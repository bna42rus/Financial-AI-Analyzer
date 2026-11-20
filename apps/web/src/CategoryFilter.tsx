import {ChoicePicker,choiceStyles,foldChoice} from './ChoicePicker';
import type {FinanceState} from './finance-client';
import styles from './CompactFilters.module.css';
type Category=FinanceState['categories'][number];
export function CategoryFilter({categories,value,onChange,disabled,emptyLabel,accountMode=false,flatLabel,single=false,fullWidth=false,'aria-label':ariaLabel,'aria-invalid':invalid,'aria-describedby':description}:{categories:Category[];value:string[];onChange:(ids:string[])=>void;disabled:boolean;emptyLabel?:string;accountMode?:boolean;flatLabel?:string;single?:boolean;fullWidth?:boolean;'aria-label'?:string;'aria-invalid'?:boolean;'aria-describedby'?:string}){
 const selected=new Set(value),byId=new Map(categories.map(c=>[c.id,c])),hidden=(c:Category)=>c.hidden||!!(c.parentId&&byId.get(c.parentId)?.hidden),available=categories.filter(c=>!hidden(c)||selected.has(c.id));
 const missing=value.filter(id=>!byId.has(id));
 const label=value.length>1?'Выбрано несколько':value.length===1?byId.get(value[0]!)?.name??'Недоступная категория':emptyLabel??(accountMode?'Все банки и счета':'Все категории');
 function toggle(c:Category,checked:boolean){
  if(single){onChange([c.id]);return;}
  const children=categories.filter(child=>child.parentId===c.id&&(!hidden(child)||selected.has(child.id))),parent=c.parentId?byId.get(c.parentId):undefined;
  // A root toggle is the same operation as checking each visible child by hand.
  // Expand a root ID from an older saved filter before changing one of its children.
  let next=new Set(value);
  if(parent&&next.has(parent.id)){next.delete(parent.id);categories.filter(child=>child.parentId===parent.id&&!hidden(child)).forEach(child=>next.add(child.id));}
  if(children.length){next.delete(c.id);children.forEach(child=>checked?next.add(child.id):next.delete(child.id));}
  else if(checked)next.add(c.id);else next.delete(c.id);
  onChange([...next]);
 }
 function choice(c:Category,close:()=>void,parent?:Category){
  const children=categories.filter(child=>child.parentId===c.id&&(!hidden(child)||selected.has(child.id))),inherited=!!parent&&selected.has(parent.id),checked=selected.has(c.id)||inherited||!!children.length&&children.every(child=>selected.has(child.id)),mixed=!c.parentId&&!checked&&children.some(child=>selected.has(child.id));
  return <label key={c.id} className={parent?choiceStyles.child:choiceStyles.choice}><input type={single?"radio":"checkbox"} data-choice-option={c.id} checked={checked} ref={node=>{if(node)node.indeterminate=mixed;}} disabled={disabled||hidden(c)&&!selected.has(c.id)} aria-label={flatLabel?c.name:parent?`${accountMode?'Счёт':'Подкатегория'} «${c.name}» в «${parent.name}»`:`${accountMode?'Банк':'Категория'} «${c.name}»`} onClick={()=>{if(single&&checked)close();}} onChange={e=>{toggle(c,e.target.checked);if(single)close();}}/><span>{c.name}{hidden(c)&&<small>Скрытая</small>}</span></label>;
 }
 const title=flatLabel??(accountMode?'Выбор банков и счетов':'Выбор категорий');
 const descriptionText=flatLabel?(single?'Выберите один вариант.':'Отметьте нужные варианты.'):accountMode?'Галочка банка выбирает все его счета. Любой счёт можно снять отдельно.':'Галочка категории выбирает все её подкатегории. Любую подкатегорию можно снять отдельно.';
 return <ChoicePicker label={label} title={title} description={descriptionText}
  className={fullWidth?styles.fullWidthTrigger:styles.categoryTrigger}
  aria-label={ariaLabel??flatLabel??(accountMode?'Банки и счета':'Категории')} aria-invalid={invalid} aria-describedby={description}
  closeLabel={flatLabel?'Закрыть список':accountMode?'Закрыть банки и счета':'Закрыть категории'}
  searchLabel={flatLabel?'Поиск: '+flatLabel:accountMode?'Поиск банков и счетов':'Поиск категорий и подкатегорий'}
  placeholder={flatLabel?'Поиск':accountMode?'Найти банк или счёт':'Найти категорию'} disabled={disabled}
  onReset={single?undefined:()=>onChange([])}>
  {(needle,close)=>{
   const matches=(c:Category)=>foldChoice(c.name).includes(needle);
   const branches=categories.filter(c=>!c.parentId).map(root=>({root,children:available.filter(c=>c.parentId===root.id)})).filter(b=>(!b.root.hidden||selected.has(b.root.id)||b.children.length)&&(matches(b.root)||b.children.some(matches)));
   const orphans=available.filter(c=>c.parentId&&!byId.has(c.parentId)&&matches(c));
   return <>
    {branches.map(({root,children})=><div className={choiceStyles.branch} key={root.id}>{choice(root,close)}{children.filter(child=>matches(root)||matches(child)).map(child=>choice(child,close,root))}</div>)}
    {orphans.map(c=>choice(c,close))}
    {!needle&&missing.map(id=><label className={choiceStyles.choice} key={id}><input type="checkbox" data-choice-option={id} checked disabled={disabled} onChange={()=>onChange(value.filter(v=>v!==id))}/><span>Недоступная категория</span></label>)}
    {!branches.length&&!orphans.length&&(needle||!missing.length)&&<p className={choiceStyles.empty}>{flatLabel?'Варианты не найдены':needle?accountMode?'Банки и счета не найдены':'Категории не найдены':accountMode?'Счетов пока нет':'Категорий пока нет'}</p>}
   </>;
  }}
 </ChoicePicker>;
}
