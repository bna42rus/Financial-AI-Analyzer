import {useEffect,useState} from 'react';
import type {Category,Link} from '../../../packages/finance-core/src/model';
import {linkKinds} from '../../../packages/finance-core/src/model';
import {api} from './server-client';
import {displayBankDate,displayRole,kindNames,minorToRubles,rublesToMinor} from './finance-client';
import type {FinanceDetail,FinanceState} from './finance-client';
import {purchaseDrafts,purchaseBalance,purchaseRemainder,purchaseSplitIntent,newPurchasePart,componentDrafts,componentNames,componentsIntent,endpointKey,endpoints,linkIntent,linkNames,linkStatusNames,newComponent} from './operation-relations';
import type {ComponentDraft,ComponentsIntent,LinkIntent} from './operation-relations';
import {formatMoney} from './demo/overview';
import {OperationDialog,OperationField} from './OperationDialog';
import common from './App.module.css';
import styles from './ServerOperation.module.css';

export type RelationEditor={kind:'components';purchase:boolean}|{kind:'link';link?:Link};
export function OperationParts({detail,purchase,categories,staged,onApply,onClose,serverError}:{detail:FinanceDetail;purchase:boolean;categories:Category[];staged?:ComponentsIntent;onApply:(v:ComponentsIntent)=>void;onClose:()=>void;serverError?:string}){
 const [initial]=useState(()=>staged?.parts.length?staged.parts.map(p=>({id:p.id,type:p.type,amount:minorToRubles(purchase?(-BigInt(p.amountMinor)).toString():p.amountMinor),role:p.role??'auto' as const,categoryId:p.categoryId??null,subcategoryId:p.subcategoryId??null,categoryConfirmed:p.categoryId!==undefined,subcategoryConfirmed:p.subcategoryId!==undefined})):purchase?purchaseDrafts(detail):componentDrafts(detail));
 const [drafts,setDrafts]=useState(initial),[checked,setChecked]=useState(false),[error,setError]=useState(serverError??''),[whole,setWhole]=useState(!purchase&&staged?.parts.length===0);
 const total=BigInt(detail.projection.amountMinor),balance=purchase?purchaseBalance(detail,drafts):null;
 const errors=drafts.map(d=>{try{const n=BigInt(rublesToMinor(d.amount));if(purchase&&n<=0n)return 'Укажите положительную сумму.';return undefined;}catch(e){return (e as Error).message;}});
 const compatible=(d:ComponentDraft,c:Category)=>d.role==='auto'||!['expense','income'].includes(d.role)||c.role==='both'||c.role===d.role;
 const categoryErrors=drafts.map(d=>d.categoryId&&!categories.some(c=>c.id===d.categoryId&&compatible(d,c))?'Выберите подходящую категорию.':undefined);
 function change(index:number,patch:Partial<ComponentDraft>){setError('');setDrafts(parts=>parts.map((p,i)=>i===index?{...p,...patch}:p));}
 function apply(){
  setChecked(true);setError('');
  if(!whole&&(errors.some(Boolean)||categoryErrors.some(Boolean)))return;
  try{onApply(whole?componentsIntent(detail,[]):purchase?purchaseSplitIntent(detail,drafts):componentsIntent(detail,drafts));}
  catch(e){setError(e instanceof Error?e.message:'Проверьте состав операции.');}
 }
 const title=purchase?'Разделение покупки по категориям':'Распределение операции';
 return <OperationDialog title={title} onClose={onClose} footer={<><button className={styles.quietButton} onClick={()=>{setDrafts(initial);setWhole(!purchase&&staged?.parts.length===0);setChecked(false);setError('');}}>Сбросить</button><button className={common.primaryButton+' '+styles.rightAction} onClick={apply}>Применить</button></>}>
  {!whole&&<fieldset className={styles.form}>
  {drafts.map((d,index)=><fieldset key={d.id} className={styles.partForm}>
   <legend>Часть {index+1}</legend>
   {!purchase&&<label>Тип части<select aria-label={`Тип части ${index+1}`} value={d.type} onChange={e=>change(index,{type:e.target.value as ComponentDraft['type']})}>{Object.entries(componentNames).map(([v,n])=><option key={v} value={v}>{n}</option>)}</select></label>}
   <OperationField label={`Сумма части ${index+1}, ₽`} error={checked?errors[index]:undefined}><input inputMode="decimal" value={d.amount} onChange={e=>change(index,{amount:e.target.value})}/></OperationField>
   {!purchase&&<label>Смысл части<select aria-label={`Смысл части ${index+1}`} value={d.role} onChange={e=>change(index,{role:e.target.value as ComponentDraft['role']})}>{(!detail.components.find(c=>c.id===d.id)?.role.userVerified)&&<option value="auto">По сохранённой логике</option>}{['expense','income','neutral','unresolved'].map(r=><option key={r} value={r}>{displayRole(r,'0')}</option>)}</select></label>}
   <OperationField label={`Категория части ${index+1}`} error={checked?categoryErrors[index]:undefined}><select value={d.categoryId??''} onChange={e=>change(index,{categoryId:e.target.value||null,subcategoryId:null,categoryConfirmed:true,subcategoryConfirmed:true})}><option value="">Без категории</option>{categories.filter(c=>!c.parentId&&((!c.hidden&&compatible(d,c))||c.id===d.categoryId)).map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select></OperationField>
   <label>Подкатегория части {index+1}<select disabled={!d.categoryId} value={d.subcategoryId??''} onChange={e=>change(index,{subcategoryId:e.target.value||null,subcategoryConfirmed:true})}><option value="">Без подкатегории</option>{categories.filter(c=>d.categoryId&&c.parentId===d.categoryId&&((!c.hidden&&compatible(d,c))||c.id===d.subcategoryId)).map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
   <div className={styles.actions}>
    {purchase&&<button className={common.button} onClick={()=>{try{change(index,{amount:purchaseRemainder(detail,drafts,d.id)});}catch(e){setError((e as Error).message);}}}>Заполнить остатком часть {index+1}</button>}
    <button className={common.button} disabled={drafts.length<=1} onClick={()=>{setError('');setDrafts(parts=>parts.filter(p=>p.id!==d.id));}}>Убрать часть {index+1}</button>
   </div>
  </fieldset>)}
  <div className={styles.actions}><button className={common.button} disabled={drafts.length>=50} onClick={()=>{setError('');setDrafts(parts=>[...parts,purchase?newPurchasePart():newComponent()]);}}>Добавить часть</button>
  {!purchase&&detail.components.length>0&&<button className={common.button} onClick={()=>{setWhole(true);setError('');}}>Вернуться к целой операции</button>}</div>
  <div className={styles.balance} aria-invalid={!!error||undefined} role="status" aria-label="Остаток распределения">{balance?<>Всего: {formatMoney(balance.total)} · Распределено: {formatMoney(balance.assigned)} · {BigInt(balance.remaining)<0n?'Превышение':'Осталось'}: {formatMoney((BigInt(balance.remaining)<0n?-BigInt(balance.remaining):BigInt(balance.remaining)).toString())}</>:<>Сумма операции: {formatMoney(total.toString())}</>}</div>
  {error&&<small className={styles.fieldError} role="alert">{error}</small>}
  </fieldset>}
  {whole&&<><p>В расчётах снова будет учитываться целая операция.</p><button className={common.button} onClick={()=>setWhole(false)}>Оставить распределение</button></>}
 </OperationDialog>;
}

const roles:Record<Link['kind'],[string,string]>={refund:['Возврат','Исходная покупка'],expense_reimbursement:['Компенсация','Исходный расход'],reversal:['Отмена','Исходная операция'],own_transfer:['Первая сторона перевода','Встречный перевод'],credit_card_repayment:['Погашение карты','Вторая сторона платежа'],debt_repayment:['Возврат долга','Встречная операция']};
const opposite=(a:string,b:string)=>BigInt(a)*BigInt(b)<0n;
const abs=(s:string)=>{const n=BigInt(s);return n<0n?-n:n;};
export function OperationLink({detail,existing,onApply,onClose,onReload,onAccessError,serverError,serverErrorCode}:{detail:FinanceDetail;existing?:Link;onApply:(v:LinkIntent)=>void;onClose:()=>void;onReload:()=>void;onAccessError:(e:unknown)=>void;serverError?:string;serverErrorCode?:string}){
 const [snapshot,setSnapshot]=useState<FinanceState|null>(null),[loadError,setLoadError]=useState(''),[reload,setReload]=useState(0);
 const [initial]=useState(()=>({kind:existing?.kind??(detail.semantics.kind.value==='refund'?'refund':['transfer_in','transfer_out','own_transfer'].includes(detail.semantics.kind.value)?'own_transfer':'reversal') as Link['kind'],status:existing?.status??'confirmed' as const,amount:existing?minorToRubles(existing.amountMinor):'',reverse:existing?existing.targetId===detail.id:detail.semantics.kind.value==='purchase',otherId:existing?(existing.sourceId===detail.id?existing.targetId:existing.sourceId):'',sourceKey:existing?endpointKey(existing.sourceComponentId,existing.sourceAllocationId):'',targetKey:existing?endpointKey(existing.targetComponentId,existing.targetAllocationId):''}));
 const [draft,setDraft]=useState(initial),[search,setSearch]=useState(''),[checked,setChecked]=useState(false),[id]=useState(()=>existing?.id??crypto.randomUUID()),[error,setError]=useState(serverError??'');
 const {kind,status,amount,reverse,otherId,sourceKey,targetKey}=draft;
 const set=(patch:Partial<typeof draft>)=>{setError('');setDraft(d=>({...d,...patch}));};
 useEffect(()=>{let live=true;setLoadError('');void api<FinanceState>('/finance/state').then(s=>{if(live)setSnapshot(s);}).catch(e=>{onAccessError(e);if(live)setLoadError(e instanceof Error?e.message:'Не удалось загрузить операции.');});return()=>{live=false;};},[reload]);
 const stale=!!snapshot&&(snapshot.generation!==detail.generation||snapshot.revision!==detail.revision);
 const own=detail.projection,other=snapshot?.operations.find(o=>o.id===otherId),source=reverse?other:own,target=reverse?own:other;
 const options=(op:typeof source,side:'source'|'target')=>op?endpoints(op,existing&&(side==='source'?existing.sourceId:existing.targetId)===op.id?{componentId:side==='source'?existing.sourceComponentId:existing.targetComponentId,allocationId:side==='source'?existing.sourceAllocationId:existing.targetAllocationId}:undefined).filter(e=>e.allocationId!==id):[];
 const sources=options(source,'source'),targets=options(target,'target');
 const se=sources.find(e=>e.key===sourceKey)??(sources.length===1?sources[0]:undefined),te=targets.find(e=>e.key===targetKey)??(targets.length===1?targets[0]:undefined);
 const name=(o:NonNullable<typeof other>)=>`${o.displayName?.compositeLabel||o.classification.merchant.value||kindNames[o.classification.kind.value]} · ${displayBankDate(o.date,'UTC')} · ${formatMoney(o.amountMinor)} · ${snapshot?.accounts.find(a=>a.id===o.accountId)?.name??'Счёт'}`;
 const errorField=serverErrorCode==='CAPACITY_CONFLICT'?'amount':serverErrorCode==='DEPENDENCY_CONFLICT'||serverErrorCode==='AMBIGUOUS_ENDPOINT'?'target':'kind';
 const fieldError=(field:string,problem?:string)=>error&&field===errorField?error:checked?problem:undefined;
 const problems:{other?:string;source?:string;target?:string;amount?:string;kind?:string}={};
 if(!other)problems.other='Выберите вторую операцию.';
 if(source&&!se)problems.source='Выберите часть операции.';
 if(target&&!te)problems.target='Выберите часть операции.';
 try{
  const n=BigInt(rublesToMinor(amount));
  if(n<=0n)problems.amount='Укажите положительную сумму связи.';
  if(status==='confirmed'&&se&&te&&!existing&&[se,te].some(e=>n>abs(e.amountMinor)))problems.amount='Сумма превышает доступный остаток выбранной части.';
 }catch(e){problems.amount=(e as Error).message;}
 if(status==='confirmed'&&se&&te&&!se.current&&!te.current){
  if(['refund','expense_reimbursement'].includes(kind)&&(BigInt(se.amountMinor)<=0n||BigInt(te.amountMinor)>=0n||te.role!=='expense'))problems.kind='Нужны поступление и исходный расход. Проверьте порядок операций.';
  else if(['reversal','own_transfer','debt_repayment'].includes(kind)&&!opposite(se.amountMinor,te.amountMinor))problems.kind='Для такой связи нужны суммы с противоположными знаками.';
 }
 function apply(){setChecked(true);if(!source||!target||!se||!te||Object.keys(problems).length)return;onApply(linkIntent(id,kind,status,amount,source,target,se,te));}
 const endpoint=(side:'source'|'target',items:typeof sources,chosen:typeof se)=> <OperationField label={'Часть: '+roles[kind][side==='source'?0:1]} error={fieldError(side,problems[side])}><select aria-label={side==='source'?'Часть первой операции':'Часть второй операции'} disabled={!items.length} value={chosen?.key??''} onChange={e=>set(side==='source'?{sourceKey:e.target.value}:{targetKey:e.target.value})}><option value="">Выберите часть</option>{items.map((e,i)=><option key={e.key} value={e.key}>{e.current?'Сохранённая часть связи':`${e.allocationId?'По другой связи':e.componentId?'Часть '+(i+1):'Целая операция или остаток'} · ${formatMoney(e.amountMinor)}${e.categoryId?' · '+(snapshot?.categories.find(c=>c.id===e.categoryId)?.name??''):''}`}</option>)}</select></OperationField>;
 return <OperationDialog title={existing?'Изменение связи':'Связь с другой операцией'} onClose={onClose} footer={<><button className={styles.quietButton} onClick={()=>{setDraft(initial);setChecked(false);setSearch('');setError('');}}>Сбросить</button><button className={common.primaryButton+' '+styles.rightAction} disabled={!snapshot||stale} onClick={apply}>Применить</button></>}>
  {!snapshot&&!loadError&&<p role="status">Загружаем операции…</p>}
  {loadError&&<><p role="alert" className={common.error}>{loadError}</p><button className={common.button} onClick={()=>setReload(n=>n+1)}>Повторить загрузку</button></>}
  {stale&&<><p role="alert" className={common.error}>Список изменился. Обновите карточку перед настройкой связи.</p><button className={common.button} onClick={onReload}>Обновить карточку</button></>}
  <fieldset className={styles.form} disabled={!snapshot||stale}>
   <OperationField label="Вид связи" error={fieldError('kind',problems.kind)}><select value={kind} onChange={e=>set({kind:e.target.value as Link['kind']})}>{linkKinds.map(k=><option key={k} value={k}>{linkNames[k]}</option>)}</select></OperationField>
   <label>Роль открытой операции<select aria-label="Роль открытой операции" value={reverse?'target':'source'} onChange={e=>set({reverse:e.target.value==='target',sourceKey:'',targetKey:''})}><option value="source">{roles[kind][0]}</option><option value="target">{roles[kind][1]}</option></select></label>
   <label>Найти связанную операцию<input aria-label="Найти связанную операцию" type="search" value={search} onChange={e=>setSearch(e.target.value)}/></label>
   <OperationField label="Связанная операция" error={checked?problems.other:undefined}><select value={otherId} onChange={e=>set({otherId:e.target.value,sourceKey:'',targetKey:''})}><option value="">Выберите операцию</option>{snapshot?.operations.filter(o=>o.id!==detail.id&&(o.id===otherId||name(o).toLocaleLowerCase('ru').includes(search.trim().toLocaleLowerCase('ru')))).map(o=><option key={o.id} value={o.id}>{name(o)}</option>)}</select></OperationField>
   {other&&<>{endpoint('source',sources,se)}{endpoint('target',targets,te)}</>}
   <OperationField label="Сумма связи, ₽" error={fieldError('amount',problems.amount)}><input inputMode="decimal" value={amount} onChange={e=>set({amount:e.target.value})}/></OperationField>
   <label>Статус связи<select aria-label="Статус связи" value={status} onChange={e=>set({status:e.target.value as Link['status']})}>{(['confirmed','candidate','rejected'] as const).map(s=><option key={s} value={s}>{linkStatusNames[s]}</option>)}</select></label>
  </fieldset>
 </OperationDialog>;
}
