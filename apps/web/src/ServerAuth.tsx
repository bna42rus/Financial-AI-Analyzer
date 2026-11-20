import {useMailCooldown,mailAddressKey} from './use-mail-cooldown';
import type {MailSend} from './use-mail-cooldown';
import {useState} from 'react';
import {api,ApiError} from './server-client';
import styles from './ServerAccess.module.css';
import {OperationField} from './OperationDialog';
export function ServerAuth({control=false,enrollment=false,onAuthenticated}:{control?:boolean;enrollment?:boolean;onAuthenticated:(codes?:string[])=>Promise<void>}) {
  const [mode,setMode]=useState(enrollment?'enroll':'login'),[email,setEmail]=useState(''),[password,setPassword]=useState(''),[code,setCode]=useState(''),[recovery,setRecovery]=useState(''),[uri,setUri]=useState(''),[error,setError]=useState(''),[errorField,setErrorField]=useState(''),[busy,setBusy]=useState(false);
  const mail=useMailCooldown(mailAddressKey(email));
  async function submit(e:React.FormEvent){e.preventDefault();if(busy||mode==='reset'&&mail.seconds)return;setBusy(true);setError('');setErrorField('');try{
    if(mode==='login'){const r=await api<{status:string}>('/auth/sign-in/email',{email,password});setPassword('');if(r.status==='totp_required')setMode('totp');else await onAuthenticated();}
    else if(mode==='totp'){const r=await api<{recoveryCodes?:string[]}>('/auth/two-factor/verify-totp',{code});setCode('');setUri('');await onAuthenticated(r.recoveryCodes);}
    else if(mode==='enroll'){const r=await api<{totpURI:string}>('/auth/two-factor/enable',{password});setPassword('');setUri(r.totpURI);setMode('totp');}
    else if(mode==='recover'){await api('/control/recovery',{email,password,recoveryCode:recovery});setPassword('');setRecovery('');await onAuthenticated();}
    else{mail.remember(await api<MailSend>('/security/reset-request',{email}));}
  }catch(e){
    if(mode==='reset')mail.remember(e);
    if(e instanceof ApiError&&e.code==='INVALID_CREDENTIALS'&&!e.retryAfterSeconds){
      if(mode==='totp'){setErrorField('code');setError('Проверьте код из приложения.');}
      else if(mode==='enroll'){setErrorField('password');setError('Проверьте текущий пароль.');}
      else setError(mode==='recover'?'Проверьте почту, пароль и резервный код.':'Проверьте почту и пароль.');
    }else setError(e instanceof Error?e.message:'Не удалось выполнить действие.');
  }finally{setBusy(false);}}
  function switchMode(next:string){setMode(next);setPassword('');setCode('');setError('');setErrorField('');}
  const title=mode==='totp'?'Подтверждение входа':mode==='enroll'?'Настройка двухфакторной защиты':mode==='recover'?'Восстановление администратора':mode==='reset'?'Сброс пароля':control?'Вход администратора':'Вход в аккаунт';
  return <section className={styles.card}><h2>{title}</h2>{control&&mode==='login'&&<p>После ввода пароля понадобится код из приложения-аутентификатора.</p>}{uri&&<><p>Добавьте ключ в приложение для кодов и введите его шестизначный код. Этот ключ показывается только при настройке.</p><label>Ключ для ручной настройки<input readOnly value={new URL(uri).searchParams.get('secret')??''}/></label></>}
    <form onSubmit={submit}>{['login','recover','reset'].includes(mode)&&<label>Почта<input type="email" autoComplete="username" required maxLength={254} value={email} onChange={e=>setEmail(e.target.value)}/></label>}{['login','enroll','recover'].includes(mode)&&<OperationField label={mode==='enroll'?'Текущий пароль':'Пароль'} error={errorField==='password'?error:undefined}><input type="password" autoComplete="current-password" required maxLength={128} value={password} onChange={e=>{setPassword(e.target.value);if(errorField==='password')setError('');}}/></OperationField>}{mode==='totp'&&<OperationField label="Код из приложения" error={errorField==='code'?error:undefined}><input autoComplete="one-time-code" inputMode="numeric" pattern="[0-9]{6}" maxLength={6} required value={code} onChange={e=>{setCode(e.target.value);if(errorField==='code')setError('');}}/></OperationField>}{mode==='recover'&&<label>Резервный код<input autoComplete="off" required value={recovery} onChange={e=>setRecovery(e.target.value)}/></label>}
    {error&&!errorField&&<p role="alert" className={styles.error}>{error}</p>}<div className={styles.authActions}><button type="submit" className={styles.primary} disabled={busy||mode==='reset'&&mail.seconds>0}>{busy?'Проверяем…':mode==='enroll'?'Начать настройку':mode==='reset'?(mail.label??'Отправить письмо'):mode==='login'?'Войти':'Подтвердить'}</button>
    {!enrollment&&!uri&&(mode!=='login'?<button type="button" className={styles.secondary} disabled={busy} onClick={()=>switchMode(mode==='totp'&&control?'recover':'login')}>{mode==='totp'&&control?'Использовать резервный код':'Ко входу'}</button>:<><button type="button" className={styles.secondary} disabled={busy} onClick={()=>switchMode('reset')}>Забыли пароль?</button></>)}
    </div>{control&&mode==='login'&&<button type="button" className={styles.authRecovery} disabled={busy} onClick={()=>switchMode('recover')}>Резервное восстановление</button>}</form>
  </section>;
}
