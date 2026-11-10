import {SignOutConfirmation} from './SignOutConfirmation';
import {useNewPasswordFields} from './NewPasswordFields';
import {LandingDemoPreview} from './LandingDemoPreview';
import {SelectField} from './SelectField';
import {useMailCooldown,mailAddressKey} from './use-mail-cooldown';
import type {MailSend} from './use-mail-cooldown';
import {useCallback,useEffect,useState} from 'react';
import {ArrowRight,CalendarDays,CheckCircle2,CreditCard,LockKeyhole,Mail,ShieldCheck,X} from 'lucide-react';
import {OperationDialog,OperationField} from './OperationDialog';
import {LegalFooter,LegalUpdate,usePublicTariffs} from './LegalPages';
import {legalDocuments} from '../../../packages/access/src/legal';
import {Brand} from './Brand';
import {SupportLink} from './SupportDialog';
import {api,ApiError,readLink} from './server-client';
import type {Session} from './server-client';
import {deviceZone} from './InterfaceSettings';
import {ServerAccount} from './ServerAccount';
import {ServerRenewal} from './ServerRenewal';
import {FirstAccessBilling,FirstPaidRenewal} from './AccessBilling';
import {ServerAuth} from './ServerAuth';
import {ServerFinance} from './ServerFinance';
import {durationLabel,moneyLabel,statusLabel} from '../../../packages/access/src/model';
import type {AccessRequest} from '../../../packages/access/src/model';
import styles from './ServerAccess.module.css';

const initialLink=readLink();
const getRoute=()=>location.hash.slice(1).split('?')[0]??'';
const isPublic=(route:string)=>['','account','access','invite','reset','verify','login'].includes(route);
const hasCode=(e:unknown,...codes:string[])=>e instanceof ApiError&&codes.includes(e.code);
function setRouteHash(route:string,replace=false){if(replace){history.replaceState(null,'','#'+route);window.dispatchEvent(new Event('hashchange'));}else location.hash='#'+route;}
function AccessCard({icon:Icon,title,children}:{icon:typeof Mail;title:string;children:React.ReactNode}){
 return <section className={styles.card+' '+styles.entryCard}><div className={styles.entryIcon}><Icon size={22}/></div><h1>{title}</h1>{children}</section>;
}

export function ServerAccess(){
 const newPassword=useNewPasswordFields();
 const [route,setRoute]=useState(getRoute),[link,setLink]=useState(initialLink),[session,setSession]=useState<Session|null>(null),[loaded,setLoaded]=useState(false),[sessionError,setSessionError]=useState('');
 const [row,setRow]=useState<AccessRequest|null>(null),[applicationLoaded,setApplicationLoaded]=useState(false),[applicationError,setApplicationError]=useState('');
 const [error,setError]=useState(''),[message,setMessage]=useState(''),[busy,setBusy]=useState(false),[submittedEmail,setSubmittedEmail]=useState(''),[linkInvalid,setLinkInvalid]=useState(false);
 const [accountOpen,setAccountOpen]=useState(false),[renewalOpen,setRenewalOpen]=useState(false),[dismissed,setDismissed]=useState<string|null>(null),[registrationCodeSent,setRegistrationCodeSent]=useState(false);
 const [applicationEmail,setApplicationEmail]=useState('');
 const registrationMail=useMailCooldown(link.token),applicationMail=useMailCooldown(mailAddressKey(applicationEmail));
 async function sendRegistrationCode(){
  try{registrationMail.remember(await api<MailSend>('/access/registration-proof',{invitationToken:link.token}));}
  catch(e){registrationMail.remember(e);throw e;}
 }
 const publicCatalog=usePublicTariffs(),tariffs=publicCatalog.tariffs??[];
 const [tariffId,setTariffId]=useState(()=>new URLSearchParams(location.hash.split('?')[1]).get('tariff')??'');
 const selected=tariffs.find(t=>t.id===tariffId)??tariffs[0];
 const renewalTariff=route==='access'?new URLSearchParams(location.hash.split('?')[1]).get('tariff')??'':'';
 const refresh=useCallback(async()=>{try{
  const next=await api<Session>('/session',undefined,AbortSignal.timeout(10000)),zone=deviceZone();
  if(next.scope==='active'&&(next.followsDevice||!next.timezone)&&next.timezone!==zone){
   try{Object.assign(next,await api<Pick<Session,'timezone'|'followsDevice'>>('/access/profile/timezone',{timezone:zone,syncDevice:true},AbortSignal.timeout(6000)));}catch{/* Keep the last server calendar and retry on the next refresh. */}
  }
  setSession(next);setSessionError('');
 }catch(e){if(hasCode(e,'AUTH_REQUIRED')){setSession(null);setSessionError('');}else{setSessionError('Не удалось проверить доступ. Проверьте соединение и повторите.');throw e;}}finally{setLoaded(true);}},[]);
 const reloadApplication=useCallback(async()=>{try{setRow((await api<{request:AccessRequest}>('/access/request')).request);setApplicationError('');}catch(e){if(hasCode(e,'APPLICATION_SESSION_REQUIRED')){setRow(null);setApplicationError('');}else{setApplicationError('Не удалось загрузить заявку. Повторите проверку.');throw e;}}finally{setApplicationLoaded(true);}},[]);
 useEffect(()=>{
  void refresh().catch(()=>{});void reloadApplication().catch(()=>{});
  const change=()=>{setRoute(getRoute());setTariffId(new URLSearchParams(location.hash.split('?')[1]).get('tariff')??'');setLink(readLink());setError('');setMessage('');setLinkInvalid(false);setRegistrationCodeSent(false);
   if(getRoute()==='account'&&new URLSearchParams(location.hash.split('?')[1]).has('payment'))setRenewalOpen(true);
  };
  if(getRoute()==='account'&&new URLSearchParams(location.hash.split('?')[1]).has('payment'))setRenewalOpen(true);
  window.addEventListener('hashchange',change);window.addEventListener('popstate',change);return()=>{window.removeEventListener('hashchange',change);window.removeEventListener('popstate',change);};
 },[refresh,reloadApplication]);
 useEffect(()=>{if(!session)return;const tick=()=>{if(document.visibilityState!=='hidden')void refresh().catch(()=>{});};const t=window.setInterval(tick,60000);window.addEventListener('focus',tick);return()=>{window.clearInterval(t);window.removeEventListener('focus',tick);};},[!!session,refresh]);
 useEffect(()=>{if(!row||!['under_review','needs_topup','paid_not_activated','awaiting_payment'].includes(row.status)||route!=='access')return;
  const tick=()=>{if(document.visibilityState!=='hidden')void reloadApplication().catch(()=>{});};
  const t=window.setInterval(tick,15000);window.addEventListener('focus',tick);return()=>{window.clearInterval(t);window.removeEventListener('focus',tick);};
 },[row?.id,row?.status,route,reloadApplication]);
 async function run(work:()=>Promise<void>){if(busy)return;setBusy(true);setError('');setMessage('');try{await work();}catch(e){if(hasCode(e,'INVALID_TOKEN','INVALID_INVITATION'))setLinkInvalid(true);else setError(e instanceof Error?e.message:'Не удалось выполнить действие.');}finally{setBusy(false);}}
 const [exitOpen,setExitOpen]=useState(false);
 function signOut(){void run(async()=>{await api('/auth/sign-out',{});setAccountOpen(false);setRenewalOpen(false);setSession(null);setDismissed(null);setRouteHash('login');});}
 function enter(){setAccountOpen(false);setRouteHash('overview');}
 const showFinance=loaded&&session?.scope==='active'&&(!isPublic(route)||!!renewalTariff);
 const closeRenewal=()=>{setRenewalOpen(false);if(renewalTariff)setRouteHash(session?.scope==='active'?'overview':'account',true);else if(getRoute()==='account'&&location.hash.includes('payment='))setRouteHash('account',true);void refresh().catch(()=>{});};
 const renewal=(renewalOpen||!!renewalTariff)&&session&&!session.blocked&&<OperationDialog compact footer={null} title="Продление доступа" onClose={closeRenewal}><ServerRenewal embedded onRefresh={refresh} initialTariffId={renewalTariff}/></OperationDialog>;
 if(showFinance&&session)return <><LegalUpdate signedIn/>{session.accessWarning&&dismissed!==session.accessWarning&&<div className={styles.warningBar}><span role="status">{session.accessWarning}</span><button className={styles.secondary} onClick={()=>setRenewalOpen(true)}>Продлить доступ</button><button className={styles.dismissWarning} aria-label="Скрыть уведомление" onClick={()=>setDismissed(session.accessWarning??null)}><X size={17}/></button></div>}<ServerFinance session={session} onAccount={()=>{setError('');setAccountOpen(true);}} onAccessLost={()=>{setAccountOpen(false);setSession(s=>s?{...s,scope:'restricted'}:null);setRouteHash('account');void refresh().catch(()=>{});}}/>{accountOpen&&<ServerAccount asDialog session={session} accountError={error} busy={busy} refresh={refresh} signOut={signOut} back={()=>setAccountOpen(false)}/>} {renewal}</>;
 const returning=route==='access'&&new URLSearchParams(location.hash.split('?')[1]).has('payment');
 const restartApplication=()=>{setRow(null);setSubmittedEmail('');setLinkInvalid(false);setRouteHash('access',true);};
 const notices=<>{error&&<p role="alert" className={styles.error}>{error}</p>}{message&&<p role="status" className={styles.success}>{message}</p>}</>;
 return <div className={styles.page+' '+styles.entryPage}><header className={styles.header}><a className={styles.brand} href="/" aria-label="CashNeuro"><Brand/></a><nav className={styles.entryNav} aria-label="Доступ">{session?<>{!route&&<a className={styles.secondary} href="#workspace">Открыть кабинет</a>}<SupportLink className={styles.secondary}/><button className={styles.secondary} disabled={busy} onClick={()=>setExitOpen(true)}>Выйти</button></>:<a className={styles.secondary} href="#login">Войти</a>}</nav></header>
 <div className={styles.entryContent}>{!loaded?<AccessCard icon={ShieldCheck} title="Проверяем вход"><p role="status">Открываем CashNeuro…</p></AccessCard>:
 sessionError&&!session?<AccessCard icon={ShieldCheck} title="CashNeuro недоступен"><p role="alert">{sessionError}</p><div className={styles.actions}><button className={styles.primary} onClick={()=>void refresh().catch(()=>{})}>Повторить</button><a className={styles.secondary} href="/demo">Попробовать демо</a></div></AccessCard>:
 session&&route?<><LegalUpdate signedIn/>{notices}{session.scope==='restricted'&&!accountOpen?<AccessCard icon={LockKeyhole} title={session.blocked?'Доступ приостановлен':session.accessEnd?'Срок доступа закончился':'Доступ ещё не активен'}>
  <p>{session.blocked?'Операции, отчёты и Анализатор временно недоступны. Чтобы уточнить причину и восстановить доступ, напишите в поддержку.':session.accessEnd?'Продлите доступ, чтобы снова открыть операции, отчёты и Анализатор. Финансовые данные сохранены.':'Финансовые разделы откроются после подтверждения доступа.'}</p>
  <div className={styles.actions}>{session.blocked?<SupportLink className={styles.primary}>Написать в поддержку</SupportLink>:<button className={styles.primary} onClick={()=>setRenewalOpen(true)}>Продлить доступ</button>}<button className={styles.secondary} onClick={()=>setAccountOpen(true)}>Открыть аккаунт</button></div>
 </AccessCard>:<ServerAccount session={session} busy={busy} refresh={refresh} signOut={signOut} back={session.scope==='active'?enter:undefined}/>} {renewal}</>:
 route==='login'||route==='account'||(!isPublic(route)&&!!route)?<div className={styles.authWrap}>{notices}<ServerAuth onAuthenticated={async()=>{await refresh();if(route==='login'||route==='account')setRouteHash('workspace',true);}}/><p className={styles.entryFootnote}>Ещё нет аккаунта? <a href="#access">Получить доступ</a> · <a href="/demo">Попробовать демо</a></p></div>:
 route==='invite'?<AccessCard icon={ShieldCheck} title={linkInvalid||!link.token?'Приглашение недоступно':'Создайте аккаунт'}>
  {notices}{linkInvalid||!link.token?<><p>Ссылка могла истечь или уже использоваться. Если вы оплатили доступ, попросите новую ссылку в поддержке.</p><div className={styles.actions}><SupportLink className={styles.primary}>Написать в поддержку</SupportLink><a className={styles.secondary} href="#login">Войти</a></div></>:<>
  <ol className={styles.registrationSteps}><li aria-current={registrationCodeSent?undefined:'step'}>1. Получить код</li><li aria-current={registrationCodeSent?'step':undefined}>2. Создать аккаунт</li></ol>
  {!registrationCodeSent?<><p>Отправим код на почту, на которую пришло приглашение.</p><div className={styles.actions}><button className={styles.primary} disabled={busy||registrationMail.seconds>0} onClick={()=>run(async()=>{await sendRegistrationCode();setRegistrationCodeSent(true);})}>{registrationMail.label??'Отправить код'}</button><button className={styles.secondary} disabled={busy} onClick={()=>{setError('');setRegistrationCodeSent(true);}}>У меня уже есть код</button></div></>:<form onSubmit={e=>{e.preventDefault();const data=new FormData(e.currentTarget),password=newPassword.read(data);if(password===null)return;void run(async()=>{await api('/access/register',{invitationToken:link.token,proofToken:String(data.get('proof')).trim(),name:String(data.get('name')).trim(),password,termsVersion:legalDocuments.terms.version});setRouteHash('login',true);setMessage('Аккаунт создан. Войдите с новым паролем.');});}}>
   <OperationField label="Код из письма"><input name="proof" required autoComplete="one-time-code" maxLength={100}/></OperationField><OperationField label="Имя"><input name="name" autoComplete="name" required maxLength={100}/></OperationField>{newPassword.fields}
   <div className={styles.legalChoice}><input type="checkbox" name="terms" required id="registration-terms"/><label htmlFor="registration-terms">Принимаю <a href="/terms" target="_blank" rel="noreferrer">условия использования</a>.</label></div><p className={styles.legalLink}><a href="/privacy" target="_blank" rel="noreferrer">Политика обработки персональных данных</a></p><div className={styles.actions}><button type="button" className={styles.secondary} disabled={busy||registrationMail.seconds>0} onClick={()=>run(async()=>{await sendRegistrationCode();setMessage('Запрошен новый код.');})}>{registrationMail.label??'Отправить код повторно'}</button><button className={styles.primary} disabled={busy}>Создать аккаунт</button></div>
  </form>}</>}
 </AccessCard>:
 route==='reset'?<AccessCard icon={LockKeyhole} title={linkInvalid||!link.token?'Ссылка на сброс недоступна':'Задайте новый пароль'}>{notices}
  {linkInvalid||!link.token?<><p>Запросите новую ссылку на странице входа.</p><a className={styles.primary} href="#login">На страницу входа</a></>:<form onSubmit={e=>{e.preventDefault();const password=newPassword.read(new FormData(e.currentTarget));if(password===null)return;void run(async()=>{await api('/security/reset',{token:link.token,newPassword:password});setRouteHash('login',true);setMessage('Пароль изменён. Войдите с новым паролем.');});}}>{newPassword.fields}<p className={styles.muted}>Прежние сеансы завершатся.</p><button className={styles.primary} disabled={busy}>Сохранить пароль</button></form>}
 </AccessCard>:
 route==='verify'?<AccessCard icon={Mail} title={linkInvalid||!link.token?'Ссылка подтверждения недоступна':'Подтвердите почту'}>{notices}{linkInvalid||!link.token?<><p>Запросите новое письмо на тот же адрес, чтобы продолжить заявку.</p><button className={styles.primary} onClick={restartApplication}>Запросить новое письмо</button></>:<><p>Подтвердите адрес, чтобы открыть свою заявку и перейти к оплате.</p><button className={styles.primary} disabled={busy} onClick={()=>run(async()=>{await api('/access/verify',{token:link.token});await reloadApplication();setRouteHash('access',true);})}>Подтвердить почту</button></>}</AccessCard>:
 route==='access'?<>{notices}{!applicationLoaded?<AccessCard icon={CreditCard} title="Открываем заявку"><p role="status">Проверяем состояние доступа…</p></AccessCard>:
 applicationError?<AccessCard icon={CreditCard} title="Не удалось открыть заявку"><p role="alert">{applicationError}</p><button className={styles.primary} onClick={()=>void reloadApplication().catch(()=>{})}>Повторить</button></AccessCard>:
 row?<AccessCard icon={row.status==='paid_not_activated'?CheckCircle2:CreditCard} title={row.status==='awaiting_payment'?'Оплатите доступ':row.status==='paid_not_activated'?'Оплата подтверждена':statusLabel[row.status]}>
   <dl className={styles.checkoutFacts}><div><dt>Почта</dt><dd>{row.email}</dd></div><div><dt>Тариф</dt><dd>{row.tariff.name} · {durationLabel(row.tariff.duration)}</dd></div><div><dt>Стоимость</dt><dd>{moneyLabel(row.tariff.priceMinor)}</dd></div></dl>
   {['awaiting_payment','needs_topup'].includes(row.status)?<FirstAccessBilling row={row} onPaid={reloadApplication} onRestart={restartApplication} fallback={<>{row.remainingMinor&&<p>Осталось доплатить: {moneyLabel(row.remainingMinor)}.</p>}<p>Оплата через сайт сейчас недоступна.</p><SupportLink className={styles.secondary}>Связаться с поддержкой</SupportLink></>}/>:
   row.status==='paid_not_activated'?<><p>Откройте письмо с приглашением и создайте аккаунт. Оплаченный период начнётся после регистрации.</p><FirstPaidRenewal/><div className={styles.actions}><a href="#login" className={styles.primary}>Уже создали аккаунт? Войти</a><SupportLink className={styles.secondary}>Письмо не пришло</SupportLink></div></>:
   row.status==='rejected'?<><p>{row.decisionNote==='Оплата возвращена. Приглашение закрыто.'?row.decisionNote:'Платёж не подтверждён. Если деньги списались, обратитесь в поддержку.'}</p><SupportLink className={styles.primary}>Написать в поддержку</SupportLink></>:<p role="status">Проверяем платёж. После подтверждения пришлём приглашение. Повторно платить пока не нужно.</p>}
 </AccessCard>:
 submittedEmail?<AccessCard icon={Mail} title="Проверьте почту"><p>Если заявку можно продолжить, письмо придёт на <strong>{submittedEmail}</strong>. Откройте его и следуйте инструкции.</p><p>Проверьте также папку «Спам».</p><button className={styles.secondary} onClick={()=>setSubmittedEmail('')}>Изменить адрес или запросить снова</button></AccessCard>:
 <AccessCard icon={CalendarDays} title={returning?'Восстановите доступ к заявке':'Получить доступ'}>
  <p>{returning?'Не удалось открыть заявку после возврата с оплаты. Укажите ту же почту: пришлём ссылку для проверки заявки.':'Выберите период и подтвердите почту. После подтверждения оплаты пришлём приглашение для регистрации.'}</p>
  <form onSubmit={e=>{e.preventDefault();if(!selected||applicationMail.seconds)return;const d=new FormData(e.currentTarget),email=String(d.get('email')).trim();void run(async()=>{try{applicationMail.remember(await api<MailSend>('/access/requests',{email,tariffId:selected.id,priceMinor:selected.priceMinor,catalogVersion:selected.catalogVersion??0,consentVersion:legalDocuments.consent.version}));setSubmittedEmail(email);}catch(e){applicationMail.remember(e);throw e;}});}}>
   <label>Период доступа<SelectField name="tariff" value={selected?.id??''} onChange={e=>setTariffId(e.target.value)} required disabled={!tariffs.length}>{!tariffs.length&&<option value="">Нет доступных тарифов</option>}{tariffs.map(t=><option key={t.id} value={t.id}>{t.name} — {moneyLabel(t.priceMinor)}</option>)}</SelectField></label>
   {publicCatalog.failed&&<p role="alert" className={styles.error}>Не удалось загрузить тарифы. <a href="/price">Открыть страницу тарифов</a></p>}{selected&&<p className={styles.muted}>{selected.aiQuota.toLocaleString('ru-RU')} единиц Анализатора {selected.duration.kind==='days'?'за период':'в месяц'}.</p>}
   <label>Почта<input name="email" type="email" required autoComplete="email" maxLength={254} value={applicationEmail} onChange={e=>setApplicationEmail(e.target.value)}/></label><div className={styles.legalChoice}><input type="checkbox" name="consent" required id="application-consent"/><label htmlFor="application-consent">Даю <a href="/data-consent" target="_blank" rel="noreferrer">согласие на обработку персональных данных</a>.</label></div><p className={styles.legalLink}><a href="/privacy" target="_blank" rel="noreferrer">Политика обработки персональных данных</a></p><button className={styles.primary} disabled={busy||!tariffs.length||applicationMail.seconds>0}>{applicationMail.label??'Получить ссылку на почту'}</button>
  </form>
 </AccessCard>}</>:
 <main className={styles.landing}><div><p className={styles.eyebrow}>Финансовый анализатор</p><h1>Поймите, куда уходят деньги</h1><p>Операции из разных банков — в одном месте. Спросите Анализатор с ИИ, почему этот месяц обошёлся дороже прошлого, и увидите, какие покупки и платежи изменили итог.</p><div className={styles.actions}><a className={styles.primary} href="#access">Получить доступ <ArrowRight size={17}/></a><a className={styles.secondary} href="/price">Посмотреть тарифы</a></div></div>
 <LandingDemoPreview/>
 </main>}</div>
 <LegalFooter/>{exitOpen&&<SignOutConfirmation busy={busy} onClose={()=>setExitOpen(false)} onConfirm={()=>{setExitOpen(false);signOut();}}/>}</div>;
}
