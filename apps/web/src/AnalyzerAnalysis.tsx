import type {AnalysisResult} from '../../../packages/analyzer/src/analysis';
import type {OperationsFilter} from '../../../packages/finance-core/src/operations';
import {formatMoney} from './demo/overview';
import styles from './ServerAnalyzer.module.css';
import base from './App.module.css';
export function AnalyzerAnalysis({value,onOpen}:{value:AnalysisResult;onOpen:(filter:OperationsFilter,name:string)=>void}){
 return <section className={styles.analysis} aria-label="Пояснения к расчёту">
  {value.savings&&<><h3>Где оценить возможность экономии</h3><div className={styles.tableWrap} tabIndex={0} role="region" aria-label="Сценарии экономии"><table><thead><tr><th>Категория</th><th>Расходы за период</th><th>При сокращении на {value.savings[0]?.reductionPercent??10}%</th></tr></thead><tbody>{value.savings.map(s=><tr key={s.label}><td><button className={base.linkButton} onClick={()=>onOpen(s.filter,s.label)}>{s.label}</button></td><td>{formatMoney(s.baseMinor)}</td><td>{formatMoney(s.savingMinor)}</td></tr>)}</tbody></table></div></>}
  {value.recurring&&<><h3>Повторные платежи для проверки</h3>{!value.recurring.length?<p>В выбранных данных повторных платежей одному магазину не найдено.</p>:<div className={styles.tableWrap} tabIndex={0} role="region" aria-label="Повторные платежи"><table><thead><tr><th>Получатель</th><th>Платежей</th><th>Медианная сумма</th><th>Наблюдение</th></tr></thead><tbody>{value.recurring.map(r=><tr key={r.merchant}><td><button className={base.linkButton} onClick={()=>onOpen(r.filter,r.merchant)}>{r.merchant}</button></td><td>{r.count}</td><td>{formatMoney(r.typicalMinor)}</td><td>{r.regular?'Похожий интервал: '+r.intervalDays+' дн.':'Регулярность не подтверждена'}</td></tr>)}</tbody></table></div>}</>}
  {value.notes.map((n,i)=><p key={i} className={styles.analysisNote}>{n}</p>)}
 </section>;
}
