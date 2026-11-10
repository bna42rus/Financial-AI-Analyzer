import {useState} from 'react';
import {SearchField,foldSearch} from '../../web/src/SearchFilter';
import {SelectField} from '../../web/src/SelectField';
import {OperationDialog,OperationField} from '../../web/src/OperationDialog';
import {api,ApiError} from '../../web/src/server-client';
import {ResendInvitation} from './ResendInvitation';
import {adminLink,useAdminData,useAdminTime} from './admin-view';
import styles from '../../web/src/ServerAccess.module.css';
import common from '../../web/src/App.module.css';
import shell from './ServerAdmin.module.css';

type Invitation={id:string;email:string;createdAt:string;expiresAt:string;usedAt?:string;state:string;delivery:string;deliveryId?:string;origin:'paid'|'manual';requestId?:string;note?:string;purchaseState?:string};
const states:Record<string,string>={active:'Действует',expired:'Срок ссылки истёк',cancelled:'Отменено',superseded:'Заменено',used:'Использовано'};
const delivery:Record<string,string>={queued:'В очереди',sent:'Принято почтовым сервисом',failed:'Не отправлено'};

export function ServerInvitations({refresh,target}:{refresh:number;target?:string}){
 const {data,error,loading,reload}=useAdminData<{invitations:Invitation[]}>('/control/workspace-invitations'+(target?'?id='+encodeURIComponent(target):''),refresh);
 const [query,setQuery]=useState(''),[filter,setFilter]=useState('');
 const visible=data?.invitations.filter(row=>row.id===target||(!filter||row.state===filter)&&foldSearch(row.email+' '+row.id).includes(foldSearch(query.trim())));
 return <section className={styles.card}>
  <div className={shell.filters}><SearchField value={query} onValueChange={setQuery} placeholder="Почта или номер приглашения" aria-label="Поиск приглашений"/>
   <SelectField value={filter} aria-label="Статус приглашения" onChange={e=>setFilter(e.target.value)}><option value="">Все статусы</option>{Object.entries(states).map(([key,label])=><option key={key} value={key}>{label}</option>)}</SelectField></div>
  {error&&<p className={styles.error} role="alert">{error}</p>}{loading&&!data&&<p role="status">Загружаем приглашения…</p>}
  {visible?.length===0&&<p>Приглашения не найдены.</p>}
  <div className={shell.records}>{visible?.map(row=><InvitationRow key={row.id+':'+row.state} row={row} highlight={row.id===target} onChanged={reload}/>)}</div>
 </section>;
}
function InvitationRow({row,highlight,onChanged}:{row:Invitation;highlight:boolean;onChanged:()=>void}){
 const [action,setAction]=useState<''|'cancel'|'reissue'>(''),[link,setLink]=useState(''),[error,setError]=useState(''),[field,setField]=useState(''),[busy,setBusy]=useState(false);
 const time=useAdminTime(),active=row.state==='active';
 const canReissue=['active','expired','cancelled'].includes(row.state)&&(row.origin==='manual'||row.purchaseState==='paid_not_activated');
 function start(next:'cancel'|'reissue'){setField('');setError('');setAction(next);}
 async function showLink(){
  setBusy(true);setError('');setField('');
  try{
   const origin=import.meta.env.VITE_FINANCE_ORIGIN;
   if(!origin||new URL(origin).origin!==origin)throw Error('Адрес пользовательского сайта не настроен.');
   const result=await api<{token:string}>('/control/invitation-link',{invitationId:row.id});
   setLink(origin+'/#invite?token='+encodeURIComponent(result.token));
  }catch(e){setError(e instanceof Error?e.message:'Ссылка недоступна.');}finally{setBusy(false);}
 }
 async function save(data:FormData){
  const reason=String(data.get('reason')??'').trim(),hours=action==='cancel'?72:Number(data.get('hours'));
  if(!reason){setField('reason');setError('Добавьте заметку.');return;}
  if(!Number.isInteger(hours)||hours<1||hours>720){setField('hours');setError('Введите срок от 1 до 720 часов.');return;}
  setBusy(true);setError('');setField('');
  try{
   await api(row.origin==='manual'?'/control/manual-invitation-action':'/control/invitation-action',{actionId:crypto.randomUUID(),invitationId:row.id,decision:action,reason,inviteHours:hours});
   setAction('');setLink('');onChanged();
  }catch(e){setError(e instanceof Error?e.message:'Не удалось сохранить.');if(e instanceof ApiError&&e.code==='INVITATION_UNAVAILABLE')onChanged();}
  finally{setBusy(false);}
 }
 return <article data-highlight={highlight}>
  <div className={shell.paymentHead}><strong>{row.email}</strong><span className={active?shell.badge:row.state==='used'?shell.success:shell.mutedBadge}>{states[row.state]??row.state}</span></div>
  <p>Создано {time.format(row.createdAt)} · ссылка до {time.format(row.expiresAt)}{row.origin==='manual'?' · выдано вручную':''}</p>
  <details key={String(highlight)} open={highlight||undefined}><summary>Подробнее</summary><div>
   <dl className={shell.detailList}><div><dt>Номер приглашения</dt><dd>{row.id}</dd></div><div><dt>Письмо</dt><dd>{delivery[row.delivery]??'В очереди'}</dd></div>
   {row.usedAt&&<div><dt>Регистрация</dt><dd>{time.format(row.usedAt)}</dd></div>}{row.note&&<div><dt>Заметка</dt><dd>{row.note}</dd></div>}</dl>
   <div className={styles.actions}>
    {row.deliveryId&&<a className={styles.secondary} href={adminLink('deliveries',{id:row.deliveryId})}>Открыть письмо</a>}
    {row.requestId&&<a className={styles.secondary} href={adminLink('requests',{id:row.requestId})}>Открыть заявку</a>}
    {active&&<><button className={styles.secondary} disabled={busy} onClick={()=>void showLink()}>Показать ссылку</button><ResendInvitation invitationId={row.id} disabled={busy||row.delivery==='queued'} onResent={async()=>onChanged()}/></>}
    {canReissue&&<button className={styles.secondary} disabled={busy} onClick={()=>start('reissue')}>{active?'Заменить ссылку':'Выдать новую ссылку'}</button>}
    {active&&<button className={common.dangerButton} disabled={busy} onClick={()=>start('cancel')}>Отменить приглашение</button>}
   </div>
   {link&&<label>Ссылка приглашения<input className={styles.secret} readOnly value={link} onFocus={e=>e.currentTarget.select()}/></label>}
   {!action&&error&&<p className={styles.error} role="alert">{error}</p>}
  </div></details>
  {action&&<OperationDialog narrow title={action==='cancel'?'Отменить приглашение':active?'Заменить ссылку':'Выдать новую ссылку'} onClose={()=>{if(!busy)setAction('');}} footer={<>
   <button className={common.button} disabled={busy} onClick={()=>setAction('')}>Назад</button>
   <button form="admin-invitation-change" type="submit" className={action==='cancel'?common.dangerButton:common.primaryButton} disabled={busy}>{action==='cancel'?'Подтвердить отмену':'Отправить новую ссылку'}</button>
  </>}>
   <form className={styles.renewalBody} id="admin-invitation-change" onSubmit={e=>{e.preventDefault();void save(new FormData(e.currentTarget));}}>
    <p><strong>{row.email}</strong></p>
    <p>{action==='cancel'?'Эта ссылка перестанет действовать. Сразу после отмены здесь можно выдать новую ссылку.':active?'Старая ссылка станет недействительной. Новую отправим на эту же почту.':'Новую ссылку отправим на эту же почту.'}{row.origin==='paid'?' Оплата сохранится.':''}</p>
    {action==='reissue'&&<OperationField label="Срок новой ссылки, часов" error={field==='hours'?error:undefined}><input name="hours" inputMode="numeric" defaultValue="72" onChange={e=>{e.target.value=e.target.value.replace(/\D/g,'');setError('');}}/></OperationField>}
    <OperationField label="Заметка" error={field==='reason'?error:undefined}><textarea name="reason" rows={2} maxLength={1000} onChange={()=>setError('')}/></OperationField>
    {!field&&error&&<p className={styles.error} role="alert">{error}</p>}
   </form>
  </OperationDialog>}
 </article>;
}
