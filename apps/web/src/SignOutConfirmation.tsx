import {OperationDialog} from './OperationDialog';
import common from './App.module.css';

export function SignOutConfirmation({onClose,onConfirm,busy=false}:{onClose:()=>void;onConfirm:()=>void;busy?:boolean}){
 return <OperationDialog narrow title="Выйти из аккаунта?" onClose={onClose} footer={<>
  <button type="button" className={common.button} onClick={onClose}>Отмена</button>
  <button type="button" className={common.dangerButton} disabled={busy} onClick={onConfirm}>Выйти</button>
 </>}><p>Для продолжения работы в этом браузере потребуется войти снова.</p></OperationDialog>;
}
