import {useState} from 'react';
import {SearchField,foldSearch} from '../../web/src/SearchFilter';
import {SelectField} from '../../web/src/SelectField';
import {OperationDialog,OperationField} from '../../web/src/OperationDialog';
import {api,ApiError} from '../../web/src/server-client';
import {ResendInvitation} from './ResendInvitation';
import {adminLink,useAdminData,useAdminTime,useAdminNotice} from './admin-view';
import styles from '../../web/src/ServerAccess.module.css';
import common from '../../web/src/App.module.css';
import shell from './ServerAdmin.module.css';

type Invitation={id:string;email:string;createdAt:string;expiresAt:string;usedAt?:string;state:string;delivery:string;deliveryId?:string;origin:'paid'|'manual';requestId?:string;note?:string;purchaseState?:string};
const states:Record<string,string>={active:'Действует',expired:'Срок ссылки истёк',cancelled:'Отменено',superseded:'Заменено',used:'Использовано'};
const delivery:Record<string,string>={queued:'В очереди',sent:'Принято почтовым сервисом',failed:'Не отправлено'};

export function ServerInvitations({refresh,target}:{refresh:number;target?:string}){
 const {data,error,loading,reload}=useAdminData<{invitations:Invitation[]}>('/control/workspace-invitations'+(target?'?id='+encodeURIComponent(target):''),refresh);
 const [query,setQuery]=useState(''),[filter,setFilter]=useState('');
 const visible=data?.invitations.filter(row=>row.id===target||row.origin==='manual'&&(!filter||row.state===filter)&&foldSearch(row.email+' '+row.id).includes(foldSearch(query.trim())));
 return <section className={styles.card}>
  <div className={shell.filters}><SearchField value={query} onValueChange={setQuery} placeholder="Почта или номер приглашения" aria-label="Поиск приглашений"/>
   <SelectField value={filter} aria-label="Статус приглашения" onChange={e=>setFilter(e.target.value)}><option value="">Все статусы</option>{Object.entries(states).map(([key,label])=><option key={key} value={key}>{label}</option>)}</SelectField></div>
  {error&&<p className={styles.error} role="alert">{error}</p>}{loading&&!data&&<p role="status">Загружаем приглашения…</p>}
  {visible?.length===0&&<p>Приглашения не найдены.</p>}
  <div className={shell.records+' '+shell.recordCards}>{visible?.map(row=><InvitationRow key={row.id+':'+row.state} row={row} highlight={row.id===target} onChanged={reload}/>)}</div>
 </section>;
}
function InvitationRow({row,highlight,onChanged}:{row:Invitation;highlight:boolean;onChanged:()=>void}){
 const [action,setAction]=useState<''|'cancel'|'reissue'>(''),[link,setLink]=useState(''),[error,setError]=useState(''),[field,setField]=useState(''),[busy,setBusy]=useState(false),[linkOpen,setLinkOpen]=useState(false),[review,setReview]=useState<{reason:string;hours:number;actionId:string}|null>(null);
 const time=useAdminTime(),notify=useAdminNotice(),active=row.state==='active';
 const canReissue=['active','expired','cancelled'].includes(row.state)&&(row.origin==='manual'||row.purchaseState==='paid_not_activated');
 function start(next:'cancel'|'reissue'){setField('');setError('');setReview(null);setAction(next);}
 async function showLink(){
  setLink('');setLinkOpen(true);setBusy(true);setError('');setField('');
  try{
   const origin=import.meta.env.VITE_FINANCE_ORIGIN;
   if(!origin||new URL(origin).origin!==origin)throw Error('Адрес пользовательского сайта не настроен.');
   const result=await api<{token:string}>('/control/invitation-link',{invitationId:row.id});
   setLink(origin+'/#invite?token='+encodeURIComponent(result.token));
  }catch(e){setError(e instanceof Error?e.message:'Ссылка недоступна.');}finally{setBusy(false);}
 }
 function preview(data:FormData){
  const reason=String(data.get('reason')??'').trim(),hours=action==='cancel'?72:Number(data.get('hours'));
  if(!Number.isInteger(hours)||hours<1||hours>720){setField('hours');setError('Введите срок от 1 до 720 часов.');return;}
  setError('');setField('');setReview({reason,hours,actionId:crypto.randomUUID()});
 }
 async function save(){
  if(!review||busy)return;
  setBusy(true);setError('');
  try{
   await api(row.origin==='manual'?'/control/manual-invitation-action':'/control/invitation-action',{actionId:review.actionId,invitationId:row.id,decision:action,reason:review.reason,inviteHours:review.hours});
   notify(action==='cancel'?'Приглашение отменено.':'Новая ссылка поставлена в очередь отправки.');
   setAction('');setReview(null);onChanged();
  }catch(e){setError(e instanceof Error?e.message:'Не удалось сохранить.');if(e instanceof ApiError&&e.code==='INVITATION_UNAVAILABLE')onChanged();}
  finally{setBusy(false);}
 }
 return <article data-highlight={highlight}>
  <div className={shell.paymentHead}><strong>{row.email}</strong><span className={active?shell.badge:row.state==='used'?shell.success:shell.mutedBadge}>{states[row.state]??row.state}</span></div>
  <p>Создано {time.format(row.createdAt)} · ссылка до {time.format(row.expiresAt)}{row.origin==='manual'?' · выдано вручную':''}</p>
  <details key={String(highlight)} open={highlight||undefined}><summary>Подробнее</summary><div>
   <dl className={shell.detailList}><div><dt>Номер приглашения</dt><dd>{row.id}</dd></div><div><dt>Письмо</dt><dd>{delivery[row.delivery]??'В очереди'}</dd></div>
   {row.usedAt&&<div><dt>Регистрация</dt><dd>{time.format(row.usedAt)}</dd></div>}{row.note&&<div><dt>Заметка</dt><dd>{row.note}</dd></div>}</dl>
   <div className={shell.detailActions}>
    {row.deliveryId&&<a className={styles.secondary} href={adminLink('deliveries',{id:row.deliveryId})}>Открыть письмо</a>}
    {row.requestId&&<a className={styles.secondary} href={adminLink('requests',{id:row.requestId})}>Открыть заявку</a>}
    {active&&<><button className={styles.secondary} disabled={busy} onClick={()=>void showLink()}>Показать ссылку</button><ResendInvitation invitationId={row.id} disabled={busy||row.delivery==='queued'} onResent={async()=>onChanged()}/></>}
    {canReissue&&<button className={styles.secondary} disabled={busy} onClick={()=>start('reissue')}>{active?'Заменить ссылку':'Выдать новую ссылку'}</button>}
    {active&&<button className={common.dangerButton} disabled={busy} onClick={()=>start('cancel')}>Отменить приглашение</button>}
   </div>
  </div></details>
  {linkOpen&&<OperationDialog narrow title="Ссылка приглашения" onClose={()=>{if(!busy){setLinkOpen(false);setLink('');setError('');}}} footer={link&&<button className={common.primaryButton} onClick={async()=>{try{await navigator.clipboard.writeText(link);notify('Ссылка скопирована.');}catch{setError('Не удалось скопировать ссылку.');}}}>Скопировать ссылку</button>}>
   <div className={styles.renewalBody}>{busy&&<p role="status">Открываем ссылку…</p>}
   {link&&<input className={styles.secret} aria-label="Ссылка приглашения" readOnly value={link} onFocus={e=>e.currentTarget.select()}/>}
   {error&&<p className={styles.error} role="alert">{error}</p>}</div>
  </OperationDialog>}
  {action&&<OperationDialog narrow title={review?'Подтверждение изменений':action==='cancel'?'Отменить приглашение':active?'Заменить ссылку':'Выдать новую ссылку'} onClose={()=>{if(!busy)setAction('');}} footer={<>
   <button className={common.button} disabled={busy} onClick={()=>{if(review){setReview(null);setError('');}else setAction('');}}>{review?'Назад':'Отмена'}</button>
   {review?<button className={action==='cancel'?common.dangerButton:common.primaryButton} disabled={busy} onClick={()=>void save()}>Подтвердить</button>:<button form="admin-invitation-change" type="submit" className={common.primaryButton}>Продолжить</button>}
  </>}>
   {review&&<div className={styles.renewalBody}><p><strong>{row.email}</strong></p><p>{action==='cancel'?'Ссылка станет недействительной.':'Новая ссылка будет действовать ' + review.hours + ' ч.'}</p><p>Заметка: {review.reason}</p>{error&&<p role="alert" className={styles.error}>{error}</p>}</div>}
   <form className={styles.renewalBody} style={review?{display:'none'}:undefined} id="admin-invitation-change" onSubmit={e=>{e.preventDefault();preview(new FormData(e.currentTarget));}}>
    <p><strong>{row.email}</strong></p>
    <p>{action==='cancel'?'Эта ссылка перестанет действовать. Сразу после отмены здесь можно выдать новую ссылку.':active?'Старая ссылка станет недействительной. Новую отправим на эту же почту.':'Новую ссылку отправим на эту же почту.'}{row.origin==='paid'?' Оплата сохранится.':''}</p>
    {action==='reissue'&&<OperationField label="Срок новой ссылки, часов" error={field==='hours'?error:undefined}><input name="hours" inputMode="numeric" defaultValue="72" onChange={e=>{e.target.value=e.target.value.replace(/\D/g,'');setError('');}}/></OperationField>}
    <OperationField label="Заметка (необязательно)" error={field==='reason'?error:undefined}><textarea name="reason" rows={2} maxLength={1000} onChange={()=>setError('')}/></OperationField>
    {!field&&error&&<p className={styles.error} role="alert">{error}</p>}
   </form>
  </OperationDialog>}
 </article>;
}
