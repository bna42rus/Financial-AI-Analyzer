import {useId,useState} from 'react';
import {passwordMaximum,passwordRule,validNewPassword} from '../../../packages/access/src/password';
import {OperationField} from './OperationDialog';

export function useNewPasswordFields(){
 const [errors,setErrors]=useState<{password?:string;confirmation?:string}>({});
 const hint=useId();
 function read(data:FormData){
  const password=data.get('password'),confirmation=data.get('passwordConfirmation');
  const next={
   password:validNewPassword(password)?undefined:passwordRule,
   confirmation:password===confirmation?undefined:'Пароли не совпадают.',
  };
  setErrors(next);
  return next.password||next.confirmation||typeof password!=='string'?null:password;
 }
 const fields=<>
  <OperationField label="Новый пароль" error={errors.password}><input name="password" type="password" autoComplete="new-password" maxLength={passwordMaximum} aria-describedby={hint} onChange={()=>setErrors({})}/></OperationField>
  <p id={hint}>{passwordRule}</p>
  <OperationField label="Подтвердите пароль" error={errors.confirmation}><input name="passwordConfirmation" type="password" autoComplete="new-password" maxLength={passwordMaximum} onChange={()=>setErrors(previous=>({...previous,confirmation:undefined}))}/></OperationField>
 </>;
 return {fields,read};
}
