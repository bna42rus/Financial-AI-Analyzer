import {PaymentCards} from './PaymentCards';
import {RenewalSettings} from './TrialOnboarding';
import {SupportLink} from './SupportDialog';
import {SignOutConfirmation} from './SignOutConfirmation';
import {AccountDeletion} from './AccountDeletion';
import {useMailCooldown,mailAddressKey} from './use-mail-cooldown';
import type {MailSend} from './use-mail-cooldown';
import {useEffect,useState} from 'react';
import {ArrowLeft,CalendarDays,LogOut,Monitor,Pencil,ShieldCheck,UserRound} from 'lucide-react';
import {deviceZone,timezoneLabel} from './InterfaceSettings';
import {AccountProfileEditor} from './AccountProfileEditor';
import type {AccountProfileField} from './AccountProfileEditor';
import {OperationDialog} from './OperationDialog';
import {ServerRenewal} from './ServerRenewal';
import {api,ApiError} from './server-client';
import type {Session} from './server-client';
import common from './App.module.css';
import styles from './ServerAccess.module.css';

type Login={id:string;createdAt:string;expiresAt:string;current:boolean;device?:string};
function date(value:string,timezone?:string|null,withTime=false){return new Intl.DateTimeFormat('ru-RU',{dateStyle:'medium',...(withTime?{timeStyle:'short'}:{}),timeZone:timezone??Intl.DateTimeFormat().resolvedOptions().timeZone}).format(new Date(value));}
export function ServerAccount({session,refresh,signOut,back,busy,accountError,asDialog=false}:{session:Session;refresh:()=>Promise<void>;signOut:()=>void;back?:()=>void;busy:boolean;accountError?:string;asDialog?:boolean}){
 const [profile,setProfile]=useState<AccountProfileField|null>(null),[exitOpen,setExitOpen]=useState(false);
 const [panel,setPanel]=useState<'renew'|'sessions'|'password'|null>(null),[sessions,setSessions]=useState<Login[]|null>(null),[target,setTarget]=useState<Login|null>(null),[pending,setPending]=useState(false),[error,setError]=useState(''),[sent,setSent]=useState(false),[reload,setReload]=useState(0);
 const mail=useMailCooldown(mailAddressKey(session.email??''));
 useEffect(()=>{if(panel!=='sessions')return;const abort=new AbortController();setError('');
  void api<{sessions:Login[]}>('/security/sessions',undefined,abort.signal).then(r=>{if(!abort.signal.aborted)setSessions([...r.sessions].sort((a,b)=>Number(b.current)-Number(a.current)||b.createdAt.localeCompare(a.createdAt)));}).catch(e=>{if(!abort.signal.aborted)setError(e instanceof Error?e.message:'Не удалось загрузить сеансы.');});return()=>abort.abort();
 },[panel,reload]);
 function open(value:typeof panel){setError('');setSent(false);if(value==='sessions')setSessions(null);setPanel(value);}
 async function end(){if(!target||target.current||pending)return;setPending(true);setError('');
  try{await api('/security/revoke-session',{sessionId:target.id});setSessions(v=>v?.filter(s=>s.id!==target.id)??null);setTarget(null);}catch(e){if(e instanceof ApiError&&e.code==='NOT_FOUND'){setTarget(null);setReload(v=>v+1);}else setError(e instanceof Error?e.message:'Не удалось завершить сеанс.');}finally{setPending(false);}
 }
 async function reset(){if(pending||!session.email||mail.seconds)return;setError('');setPending(true);try{mail.remember(await api<MailSend>('/security/reset-request',{email:session.email}));setSent(true);}catch(e){mail.remember(e);setError(e instanceof Error?e.message:'Не удалось запросить письмо.');}finally{setPending(false);}}
 const content=<div className={styles.accountStack}>{accountError&&<p className={styles.error} role="alert">{accountError}</p>}
  <section className={styles.accountSection}><h2><UserRound size={18}/>Профиль</h2><dl>{([['name','Имя',session.name],['email','Почта',session.email],['timezone','Часовой пояс',timezoneLabel(session.timezone??deviceZone())]] as const).map(([field,label,value])=>value&&<div key={field}><dt>{label}</dt><dd className={styles.profileValue}><span>{value}</span><button className={common.iconButton} disabled={busy} aria-label={'Изменить: '+label.toLocaleLowerCase('ru')} onClick={()=>setProfile(field)}><Pencil size={16}/></button></dd></div>)}</dl></section>
  <section className={styles.accountSection}><h2><CalendarDays size={18}/>Доступ</h2><dl><div><dt>Статус</dt><dd>{session.blocked?'Заблокирован':session.scope==='active'?(session.trialState==='active'?'Пробный период':'Активен'):session.isNew?'Выберите тариф':session.accessEnd?'Срок истёк':'Не активен'}</dd></div><div><dt>Срок</dt><dd>{session.isNew?'—':session.indefinite?'Бессрочно':session.accessEnd?'До '+date(session.accessEnd,session.timezone):'—'}</dd></div></dl>{!session.blocked&&(session.isNew||session.accessWarning)&&<p className={styles.accountWarning}>{session.isNew?'Чтобы начать пользоваться финансовыми функциями, выберите тариф или попробуйте 7 дней бесплатно.':session.accessWarning}</p>}{session.blocked&&<p className={styles.accountWarning}>Доступ приостановлен. <SupportLink className={common.linkButton}>Написать в поддержку</SupportLink></p>}<div className={styles.accountActions}>{!session.indefinite&&!session.blocked&&<button className={common.primaryButton} disabled={busy} onClick={()=>open('renew')}>{session.isNew?'Выбрать тариф':'Продлить доступ'}</button>}{!session.blocked&&<RenewalSettings/>}</div></section>
  <PaymentCards/>
  <section className={styles.accountSection}><h2><ShieldCheck size={18}/>Безопасность</h2><div className={styles.accountActions}><button className={common.button} onClick={()=>open('sessions')}>Активные сеансы</button>{session.email&&<button className={common.button} onClick={()=>open('password')}>Сменить пароль</button>}</div></section>
  {session.email&&<AccountDeletion email={session.email}/>}
 </div>;
 const exit=<button className={common.dangerButton} disabled={busy} onClick={()=>setExitOpen(true)}><LogOut size={16}/>Выйти</button>;
 return <>
  {asDialog&&back?<OperationDialog title="Аккаунт" onClose={back} footer={<>{exit}<button className={common.button} onClick={back}>Готово</button></>}>{content}</OperationDialog>:<section className={styles.accountPage}><h1>Аккаунт</h1><div className={styles.accountPageBody}>{content}</div><div className={styles.accountPageFooter}>{back&&<button className={common.primaryButton} onClick={back}><ArrowLeft size={16}/>К финансам</button>}{exit}</div></section>}
  {profile&&<AccountProfileEditor field={profile} session={session} onClose={()=>setProfile(null)} onSaved={refresh}/>}
  {exitOpen&&<SignOutConfirmation busy={busy} onClose={()=>setExitOpen(false)} onConfirm={()=>{setExitOpen(false);signOut();}}/>}
  {panel==='renew'&&<OperationDialog compact footer={null} title="Продление доступа" onClose={()=>{open(null);void refresh();}}><ServerRenewal embedded onRefresh={refresh}/></OperationDialog>}
  {panel==='sessions'&&<OperationDialog compact title="Активные сеансы" onClose={()=>{if(!pending)open(null);}} footer={<button className={common.button} disabled={pending} onClick={()=>open(null)}>Закрыть</button>}>
   {error&&!target&&<div role="alert"><p className={styles.error}>{error}</p><button className={common.button} onClick={()=>setReload(v=>v+1)}>Повторить</button></div>}
   {!sessions&&!error&&<p role="status">Загружаем сеансы…</p>}
   {sessions?.length===0&&<p>Активных сеансов нет.</p>}
   <ul className={styles.sessions}>{sessions?.map(s=><li key={s.id}><Monitor size={18}/><div><strong>{s.device??(s.current?'Текущий сеанс':'Другой сеанс')}</strong><small>{s.current?'Текущий сеанс · ':''}{date(s.createdAt,session.timezone,true)}</small></div>{!s.current&&<button className={common.dangerButton} onClick={()=>{setError('');setTarget(s);}}>Завершить</button>}</li>)}</ul>
  </OperationDialog>}
  {target&&<OperationDialog compact title="Завершить сеанс?" narrow onClose={()=>{if(!pending)setTarget(null);}} footer={<><button className={common.button} disabled={pending} onClick={()=>setTarget(null)}>Отменить</button><button className={common.dangerButton} disabled={pending} onClick={()=>void end()}>Завершить сеанс</button></>}><p>Для входа в этом сеансе снова потребуется пароль.</p>{error&&<p className={styles.error} role="alert">{error}</p>}</OperationDialog>}
  {panel==='password'&&<OperationDialog compact title="Смена пароля" onClose={()=>{if(!pending)open(null);}} footer={<><button className={common.button} disabled={pending} onClick={()=>open(null)}>{sent?'Готово':'Отменить'}</button>{!sent&&<button className={common.primaryButton} disabled={pending||mail.seconds>0} onClick={()=>void reset()}>{mail.label??'Отправить ссылку'}</button>}</>}><p>{sent?'Ссылка запрошена. Проверьте почту.':<>Отправим ссылку на <strong>{session.email}</strong>. После смены пароля все сеансы завершатся.</>}</p>{error&&<p className={styles.error} role="alert">{error}</p>}</OperationDialog>}
 </>;
}
