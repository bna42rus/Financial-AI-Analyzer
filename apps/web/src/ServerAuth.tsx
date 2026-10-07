import {useState} from 'react';
import {api} from './server-client';
import styles from './ServerAccess.module.css';
export function ServerAuth({control=false,enrollment=false,onAuthenticated}:{control?:boolean;enrollment?:boolean;onAuthenticated:(codes?:string[])=>Promise<void>}) {
  const [mode,setMode]=useState(enrollment?'enroll':'login'),[email,setEmail]=useState(''),[password,setPassword]=useState(''),[code,setCode]=useState(''),[recovery,setRecovery]=useState(''),[uri,setUri]=useState(''),[error,setError]=useState(''),[message,setMessage]=useState(''),[busy,setBusy]=useState(false);
  async function submit(e:React.FormEvent){e.preventDefault();if(busy)return;setBusy(true);setError('');setMessage('');try{
    if(mode==='login'){const r=await api<{status:string}>('/auth/sign-in/email',{email,password});setPassword('');if(r.status==='totp_required')setMode('totp');else await onAuthenticated();}
    else if(mode==='totp'){const r=await api<{recoveryCodes?:string[]}>('/auth/two-factor/verify-totp',{code});setCode('');setUri('');await onAuthenticated(r.recoveryCodes);}
    else if(mode==='enroll'){const r=await api<{totpURI:string}>('/auth/two-factor/enable',{password});setPassword('');setUri(r.totpURI);setMode('totp');}
    else if(mode==='recover'){await api('/control/recovery',{email,password,recoveryCode:recovery});setPassword('');setRecovery('');await onAuthenticated();}
    else{await api('/security/reset-request',{email});setMessage('Если аккаунт существует, письмо поставлено в очередь отправки.');}
  }catch(e){setError(e instanceof Error?e.message:'Не удалось выполнить действие.');}finally{setBusy(false);}}
  const title=mode==='totp'?'Подтверждение входа':mode==='enroll'?'Настройка authenticator':mode==='recover'?'Восстановление администратора':mode==='reset'?'Сброс пароля':control?'Вход администратора':'Вход в аккаунт';
  return <section className={styles.card}><h2>{title}</h2>{uri&&<><p>Добавьте ключ в authenticator и введите его шестизначный код. Этот ключ показывается только при настройке.</p><label>Ключ для ручной настройки<input readOnly value={new URL(uri).searchParams.get('secret')??''}/></label></>}
    <form onSubmit={submit}>{['login','recover','reset'].includes(mode)&&<label>Почта<input type="email" autoComplete="username" required maxLength={254} value={email} onChange={e=>setEmail(e.target.value)}/></label>}{['login','enroll','recover'].includes(mode)&&<label>{mode==='enroll'?'Текущий пароль':'Пароль'}<input type="password" autoComplete="current-password" required maxLength={128} value={password} onChange={e=>setPassword(e.target.value)}/></label>}{mode==='totp'&&<label>Код authenticator<input autoComplete="one-time-code" inputMode="numeric" pattern="[0-9]{6}" maxLength={6} required value={code} onChange={e=>setCode(e.target.value)}/></label>}{mode==='recover'&&<label>Резервный код<input autoComplete="off" required value={recovery} onChange={e=>setRecovery(e.target.value)}/></label>}
    {error&&<p role="alert" className={styles.error}>{error}</p>}{message&&<p role="status" className={styles.success}>{message}</p>}<button className={styles.primary} disabled={busy}>{busy?'Проверяем…':mode==='enroll'?'Начать настройку':mode==='reset'?'Запросить письмо':'Продолжить'}</button></form>
    {!enrollment&&!uri&&<div className={styles.actions}>{mode!=='login'&&<button className={styles.secondary} disabled={busy} onClick={()=>{setMode('login');setCode('');setError('');}}>Войти с паролем</button>}{mode==='login'&&<><button className={styles.secondary} onClick={()=>setMode('reset')}>Забыли пароль?</button>{control&&<button className={styles.secondary} onClick={()=>setMode('recover')}>Резервное восстановление</button>}</>}</div>}
  </section>;
}
