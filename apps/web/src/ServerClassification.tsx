import {useEffect,useRef,useState} from 'react';
import {api,ApiError} from './server-client';
import common from './App.module.css';
type Status={enabled:boolean;state:'idle'|'queued'|'completed'|'blocked';calls:number;applied:number;uncertain:number};
export function ServerClassification({revision,disabled,onChanged,onAccessError}:{revision:string;disabled:boolean;onChanged:()=>void;onAccessError:(e:unknown)=>void}){
 const [status,setStatus]=useState<Status|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const callbacks=useRef({onChanged,onAccessError});callbacks.current={onChanged,onAccessError};
 const previous=useRef<number|null>(null),mounted=useRef(false);
 async function read(start=false){
  try{const value=await api<Status>('/finance/classification',start?{start:true}:{});if(!mounted.current)return;
   setStatus(value);if(previous.current!==null&&value.applied!==previous.current)callbacks.current.onChanged();previous.current=value.applied;
  }catch(e){if(!mounted.current)return;if(e instanceof ApiError&&['AUTH_REQUIRED','FINANCE_ACCESS_REQUIRED'].includes(e.code))callbacks.current.onAccessError(e);else setError(start?'Не удалось запустить категоризацию. Повторите позже.':'Не удалось проверить состояние категоризации.');}
 }
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
 useEffect(()=>{void read();},[revision]);
 useEffect(()=>{if(status?.state!=='queued')return;const timer=window.setInterval(()=>void read(),2000);return()=>window.clearInterval(timer);},[status?.state]);
 if(!status?.enabled)return null;
 async function start(){setBusy(true);setError('');try{await read(true);}finally{if(mounted.current)setBusy(false);}}
 return <section className={common.panel} aria-label="Категории с помощью AI"><h2>Категории с помощью AI</h2>
 <p>AI распределяет операции по вашим категориям, используя безопасные признаки магазина. Ручные решения и правила сохраняются. Неоднозначные покупки остаются на проверке.</p>
 <p>Пользовательская квота чата не расходуется.</p>
 {status.state==='queued'?<p role="status">Подбираем категории… Назначения обновляются по мере обработки.</p>:<button className={common.button} disabled={disabled||busy||status.uncertain>0} onClick={()=>void start()}>Разобрать категории загруженных операций</button>}
 {status.applied>0&&<p role="status">Обработано операций: {status.applied}.</p>}
 {status.state==='completed'&&<p>Проход завершён. Если категории остались пустыми, безопасных сведений недостаточно: проверьте эти операции вручную.</p>}
 {status.state==='blocked'&&<p role="status">AI-обработка приостановлена. Импортированные операции сохранены; категории можно назначить вручную. {status.uncertain>0?'Есть запрос с неподтверждённым результатом. Повторная отправка заблокирована до проверки.':'Проверьте доступность AI и лимиты тестового этапа.'}</p>}
 {error&&<p role="alert">{error}</p>}</section>;
}
