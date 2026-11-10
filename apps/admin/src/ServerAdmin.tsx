import {useEffect,useState} from 'react';
import {Users,ClipboardList,CreditCard,Tag,MailPlus,Mail,History,RefreshCw,UserRound} from 'lucide-react';
import {LegalFooter} from '../../web/src/LegalPages';
import {Brand} from '../../web/src/Brand';
import {ServerAuth} from '../../web/src/ServerAuth';
import {useNewPasswordFields} from '../../web/src/NewPasswordFields';
import {SignOutConfirmation} from '../../web/src/SignOutConfirmation';
import {api,ApiError,readLink} from '../../web/src/server-client';
import type {Session} from '../../web/src/server-client';
import {ServerAdminHistory} from './ServerAdminHistory';
import {ServerCheckoutQueue} from './ServerCheckoutQueue';
import {ServerCommerceCatalog} from './ServerCommerceCatalog';
import {ServerManualAccess} from './ServerManualAccess';
import {ServerDeliveries} from './ServerDeliveries';
import {ServerRequests,initialRequestFilters} from './ServerRequests';
import {ServerInvitations} from './ServerInvitations';
import {ServerAdminAccount} from './ServerAdminAccount';
import {AdminTimezoneProvider,adminLink,readAdminLocation} from './admin-view';
import styles from '../../web/src/ServerAccess.module.css';
import common from '../../web/src/App.module.css';
import shell from './ServerAdmin.module.css';

const initialLink=readLink();
const sections=[
 {id:'users',name:'Пользователи и доступ',Icon:Users},{id:'requests',name:'Заявки',Icon:ClipboardList},
 {id:'payments',name:'Платежи',Icon:CreditCard},{id:'tariffs',name:'Тарифы',Icon:Tag},
 {id:'invitations',name:'Приглашения',Icon:MailPlus},{id:'deliveries',name:'Письма',Icon:Mail},{id:'history',name:'История',Icon:History}
];
export function ServerAdmin(){
 const newPassword=useNewPasswordFields();
 const [session,setSession]=useState<Session|null>(null),[loaded,setLoaded]=useState(false),[route,setRoute]=useState(readAdminLocation);
 const [refresh,setRefresh]=useState(0),[timezone,setTimezone]=useState('device'),[codes,setCodes]=useState<string[]>([]);
 const [error,setError]=useState(''),[busy,setBusy]=useState(false),[resetDone,setResetDone]=useState(false),[exit,setExit]=useState(false);
 const [requestFilters,setRequestFilters]=useState(initialRequestFilters);
 const signedIn=session?.scope==='admin';
 useEffect(()=>{
  const controller=new AbortController();
  void api<Session>('/session',undefined,controller.signal).then(s=>{if(!controller.signal.aborted)setSession(s);})
   .catch(e=>{if(!controller.signal.aborted&&(!(e instanceof ApiError)||!['AUTH_REQUIRED','TOTP_REQUIRED'].includes(e.code)))setError(e.message);})
   .finally(()=>{if(!controller.signal.aborted)setLoaded(true);});
  return()=>controller.abort();
 },[]);
 useEffect(()=>{const update=()=>setRoute(readAdminLocation());window.addEventListener('hashchange',update);return()=>window.removeEventListener('hashchange',update);},[]);
 useEffect(()=>{if(!signedIn)return;const controller=new AbortController();
  void api<{timezone:string}>('/control/admin-preferences',undefined,controller.signal).then(r=>{if(!controller.signal.aborted)setTimezone(r.timezone);}).catch(e=>{if(!controller.signal.aborted)setError(e.message);});
  return()=>controller.abort();
 },[signedIn]);
 async function authenticated(next?:string[]){setSession(await api<Session>('/session'));if(next)setCodes(next);}
 async function run(work:()=>Promise<void>){
  if(busy)return;setBusy(true);setError('');try{await work();}catch(e){setError(e instanceof Error?e.message:'Не удалось выполнить действие.');}finally{setBusy(false);}
 }
 return <AdminTimezoneProvider value={timezone}><div className={styles.page+' '+styles.entryPage+' '+shell.page} data-admin-shell>
 <header className={shell.header}>
  <div className={shell.headerBar}><div className={shell.identity}><Brand/><span>Управление</span></div>
   {signedIn&&<div className={shell.headerActions}>
    <button className={common.iconButton} aria-label="Обновить данные" title="Обновить данные" onClick={()=>setRefresh(n=>n+1)}><RefreshCw size={18}/></button>
    <a className={common.button} href={adminLink('account')} aria-current={route.tab==='account'?'page':undefined}><UserRound size={17}/>Аккаунт</a>
    <button className={common.button} disabled={busy} onClick={()=>setExit(true)}>Выйти</button>
   </div>}
  </div>
  {signedIn&&<nav className={shell.nav} aria-label="Разделы админки">{sections.map(({id,name,Icon})=><a key={id} href={adminLink(id)} aria-current={route.tab===id?'page':undefined}><Icon size={17}/>{name}</a>)}</nav>}
 </header>
 {error&&<p role="alert" className={styles.error}>{error}</p>}
 {!loaded?<p role="status">Проверяем сессию…</p>:initialLink.kind==='reset'&&!resetDone?<section className={styles.card}><h1>Новый пароль администратора</h1>
 <form onSubmit={e=>{e.preventDefault();const password=newPassword.read(new FormData(e.currentTarget));if(password===null)return;void run(async()=>{await api('/security/reset',{token:initialLink.token,newPassword:password});setResetDone(true);setSession(null);});}}>
 {newPassword.fields}<button className={styles.primary} disabled={busy||!initialLink.token}>Сохранить пароль</button></form></section>:!session?
 <main className={styles.landing+' '+shell.entry}><div><p className={styles.eyebrow}>Для администраторов</p><h1>Панель управления CashNeuro</h1><p>Управляйте доступом пользователей, заявками и платежами.</p></div><ServerAuth control onAuthenticated={authenticated}/></main>:
 !signedIn?<ServerAuth key={session.scope} control enrollment onAuthenticated={authenticated}/>:<>
 {codes.length>0&&<section className={styles.card}><h2>Сохраните резервные коды</h2><p>Коды показываются один раз. Для восстановления потребуется текущий пароль и один неиспользованный код.</p><pre className={styles.codes}>{codes.join('\n')}</pre><button className={styles.secondary} onClick={()=>setCodes([])}>Коды сохранены</button></section>}
 <main className={shell.main}><h1>{route.tab==='account'?'Аккаунт':sections.find(s=>s.id===route.tab)?.name}</h1>
  {route.tab==='users'&&<ServerManualAccess refresh={refresh} target={route.id}/>}
  {route.tab==='requests'&&<ServerRequests refresh={refresh} target={route.id} initialSearch={route.search} filters={requestFilters} onFilters={setRequestFilters}/>}
  {route.tab==='payments'&&<ServerCheckoutQueue refresh={refresh} target={route.id} initialSearch={route.search}/>}
  {route.tab==='tariffs'&&<ServerCommerceCatalog refresh={refresh}/>}
  {route.tab==='invitations'&&<ServerInvitations refresh={refresh} target={route.id}/>}
  {route.tab==='deliveries'&&<ServerDeliveries refresh={refresh} target={route.id}/>}
  {route.tab==='history'&&<ServerAdminHistory refresh={refresh} initialSearch={route.search}/>}
  {route.tab==='account'&&<ServerAdminAccount email={session.email??''} timezone={timezone} onTimezone={setTimezone}/>}
 </main>
 </>}
 {exit&&<SignOutConfirmation busy={busy} onClose={()=>setExit(false)} onConfirm={()=>{setExit(false);void run(async()=>{await api('/auth/sign-out',{});setSession(null);setCodes([]);setRequestFilters(initialRequestFilters);});}}/>}
 <LegalFooter origin={import.meta.env.VITE_FINANCE_ORIGIN}/></div></AdminTimezoneProvider>;
}
