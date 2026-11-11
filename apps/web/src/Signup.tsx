import {useState} from 'react';
import {api} from './server-client';
import {useNewPasswordFields} from './NewPasswordFields';
import {OperationField} from './OperationDialog';
import {legalDocuments} from '../../../packages/access/src/legal';
import styles from './ServerAccess.module.css';
export function Signup({onRegistered}:{onRegistered:()=>Promise<void>}){
 const pw=useNewPasswordFields(),[pending,setPending]=useState<{id:string;email:string;password:string}|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
 async function submit(e:React.FormEvent<HTMLFormElement>){e.preventDefault();if(busy)return;const data=new FormData(e.currentTarget);setError('');setBusy(true);
 try{if(pending){await api('/access/signup-complete',{id:pending.id,code:String(data.get('code'))});await api('/auth/sign-in/email',{email:pending.email,password:pending.password});setPending(null);await onRegistered();}
 else{const password=pw.read(data);if(!password)return;const email=String(data.get('email')).trim();const r=await api<{id:string}>('/access/signup-start',{email,name:String(data.get('name')).trim(),password,confirmPassword:String(data.get('passwordConfirmation')),termsVersion:legalDocuments.terms.version,consentVersion:legalDocuments.consent.version});setPending({id:r.id,email,password});}}
 catch(e){setError(e instanceof Error?e.message:'Не удалось создать аккаунт.');}finally{setBusy(false);}}
 return <section className={styles.card+' '+styles.entryCard}><h1>{pending?'Подтвердите почту':'Создайте аккаунт'}</h1><form onSubmit={e=>void submit(e)}>{pending?<><p>Введите шестизначный код из письма на {pending.email}. Код действует 15 минут.</p><OperationField label="Код из письма"><input key={pending.id} name="code" type="text" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required/></OperationField></>:<>
 <OperationField label="Почта"><input name="email" type="email" autoComplete="email" maxLength={254} required/></OperationField>{pw.fields}<OperationField label="Имя в профиле"><input name="name" autoComplete="name" maxLength={100} required/></OperationField>
 <div className={styles.legalChoice}><input type="checkbox" id="signup-consent" required/><label htmlFor="signup-consent">Принимаю <a href="/terms" target="_blank" rel="noreferrer">условия использования</a> и даю <a href="/data-consent" target="_blank" rel="noreferrer">согласие на обработку данных</a>.</label></div><p><a href="/privacy" target="_blank" rel="noreferrer">Политика обработки персональных данных</a></p><p>После регистрации выберите тариф или попробуйте 7 дней с 2 500 единицами Анализатора.</p></>}
 {error&&<p role="alert" className={styles.error}>{error}</p>}<div className={styles.actions}>{pending&&<button type="button" className={styles.secondary} disabled={busy} onClick={()=>{setPending(null);setError('');}}>Изменить данные или запросить код снова</button>}<button className={styles.primary} disabled={busy}>{pending?'Зарегистрироваться':'Продолжить'}</button></div></form></section>;
}
