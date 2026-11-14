import {ArrowRight} from 'lucide-react';
import {demoPreview} from './demo/workspace-data';
import {formatMoney} from './demo/overview';
import styles from './ServerAccess.module.css';

export function LandingDemoPreview(){
 const {total,rows}=demoPreview();
 return <section className={styles.landingPreview} aria-label="Пример отчёта о расходах">
  <div className={styles.landingPreviewHead}><strong>Расходы за месяц</strong><span>Пример отчёта</span></div>
  <p className={styles.landingTotal}>{formatMoney(String(total))}</p>
  <ul className={styles.landingBreakdown}>{rows.map(({name,amount})=><li key={name}>
   <div><span>{name}</span><strong>{formatMoney(String(amount))}</strong></div>
   <span className={styles.landingTrack} aria-hidden="true"><span style={{width:(total>0n?Number(amount*10000n/total)/100:0)+'%'}}/></span>
  </li>)}</ul>
  <a className={styles.secondary+' '+styles.landingDemoButton} href="/demo">Попробовать демо <ArrowRight size={16} aria-hidden="true"/></a>
 </section>;
}
