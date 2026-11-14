import {useState} from 'react';
import {ServerFinance} from './ServerFinance';
import {OperationDialog} from './OperationDialog';
import {demoTimezone} from './demo/workspace-data';
import {demoApi,resetDemo} from './demo/workspace-api';
import {registerDemoApi} from './server-client';
import styles from './App.module.css';

registerDemoApi(demoApi);

export function PublicDemo(){
 const [open,setOpen]=useState(false),[version,setVersion]=useState(0);
 return <>
  <ServerFinance key={version} demo session={{name:'Демо CashNeuro',scope:'active',capabilities:['finance'],indefinite:true,timezone:demoTimezone}} onAccount={()=>setOpen(true)} onAccessLost={()=>setOpen(true)}/>
  {open&&<OperationDialog title="Демонстрационный режим" narrow onClose={()=>setOpen(false)} footer={<>
   <button className={styles.button} onClick={()=>{resetDemo();window.history.replaceState(null,'','/demo#overview');setVersion(n=>n+1);setOpen(false);}}>Начать заново</button>
   <a href="/#access" className={styles.primaryButton}>Получить доступ</a>
  </>}>
   <p>В демо 573 вымышленные операции. Попробуйте отчёты, фильтры, бюджеты, правила и расчёты Анализатора.</p>
   <p>Загрузка своих выписок, управление аккаунтом, оплата и ответы ИИ доступны после входа. Изменения в демо действуют до перезагрузки страницы.</p>
  </OperationDialog>}
 </>;
}
