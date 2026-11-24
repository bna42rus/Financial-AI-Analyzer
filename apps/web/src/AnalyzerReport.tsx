import {lazy,Suspense} from 'react';
import type {ReportResult} from '../../../packages/analyzer/src/report';
import type {OperationsFilter} from '../../../packages/finance-core/src/operations';
import type {FinanceState} from './finance-client';
import {metricNames} from '../../../packages/finance-core/src/overview';
import {countMetric} from '../../../packages/analyzer/src/analysis';
import {CalculatorDetails} from './CalculatorDetails';
import {FinancialSourcesDetails} from './FinancialSourcesDetails';
import {AnalyzerAnswerRows} from './AnalyzerAnswerRows';
import {AnalyzerAnalysis} from './AnalyzerAnalysis';
import {FilterContext} from './FilterContext';
import {formatMoney} from './demo/overview';
import base from './App.module.css';
import styles from './ServerAnalyzer.module.css';
const Chart=lazy(()=>import('./OverviewChart'));
export function AnalyzerReport({id,value,state,onOpen}:{id:string;value:ReportResult;state:FinanceState;onOpen:(filter:OperationsFilter,name:string)=>void}){
 const loans=value.sections.flatMap(s=>s.calculation?.kind==='loan'?[{label:s.label,value:s.calculation}]:[]);
 const comparable=loans.length>1&&loans.every(s=>s.value.principalMinor===loans[0]!.value.principalMinor);
 const sorted=[...loans].sort((a,b)=>BigInt(a.value.interestMinor)<BigInt(b.value.interestMinor)?-1:BigInt(a.value.interestMinor)>BigInt(b.value.interestMinor)?1:0);
 return <section className={styles.analysis} aria-label="Связанный финансовый ответ">
  {value.narrative.map((b,i)=><p key={i} className={b.kind==='limitation'?styles.analysisNote:undefined}>{b.text}</p>)}
  {loans.length>1&&<><div className={styles.tableWrap} tabIndex={0} role="region" aria-label="Сравнение кредитных расчётов"><table><thead><tr><th>Вариант</th><th>Первый платёж</th><th>Последний платёж</th><th>Проценты за весь срок</th><th>Всего выплат</th><th>Месяцев</th></tr></thead><tbody>{loans.map((s,i)=><tr key={i}><th scope="row">{s.label}</th><td>{formatMoney(s.value.regularPaymentMinor)}</td><td>{formatMoney(s.value.rows.at(-1)!.paymentMinor)}</td><td>{formatMoney(s.value.interestMinor)}</td><td>{formatMoney(s.value.totalPaidMinor)}</td><td>{s.value.months}</td></tr>)}</tbody></table></div>{comparable&&<p>{sorted[0]!.value.interestMinor===sorted.at(-1)!.value.interestMinor?'Сумма процентов в этих вариантах одинакова.':<>Наименьшая сумма процентов — «{sorted[0]!.label}». Разница с вариантом «{sorted.at(-1)!.label}» — {formatMoney((BigInt(sorted.at(-1)!.value.interestMinor)-BigInt(sorted[0]!.value.interestMinor)).toString())}.</>}</p>}</>}
  {value.sections.filter(s=>s.budgets||s.answer||s.calculation||s.derived||s.sources||s.error).map(s=>{const a=s.answer,q=a?.query,r=a?.result;return <section key={s.index} className={styles.reportSection} aria-label={s.label}><h3>{s.label}</h3>
   {s.error&&<p className={base.error} role="alert">{s.error.text}</p>}
   {s.budgets&&<>{!s.budgets.items.length?<p>По условиям бюджетов нет.</p>:<div className={styles.tableWrap} tabIndex={0} role="region" aria-label="План и факт бюджетов"><table><thead><tr><th>Бюджет</th><th>Лимит</th><th>Учтено</th><th>Остаток</th></tr></thead><tbody>{s.budgets.items.map(b=><tr key={b.id}><td><button className={base.linkButton} onClick={()=>onOpen(b.filter,b.name)}>{b.name}</button>{!b.enabled&&<small> · выключен</small>}<small> · {b.period.from} — {b.period.through}</small></td><td>{b.indicator?formatMoney(b.indicator.limitMinor):b.upcomingLimit?formatMoney(b.upcomingLimit.limitMinor)+' с '+b.upcomingLimit.from:'Не задан'}</td><td>{b.indicator?formatMoney(b.indicator.usedMinor):'—'}</td><td>{b.indicator?formatMoney(b.indicator.remainingMinor):'—'}</td></tr>)}</tbody></table></div>}<p className={styles.analysisNote}>{s.budgets.notice}</p></>}
   {s.calculation&&<CalculatorDetails value={s.calculation}/>}
   {s.sources&&<><p>{s.sources.sources.flatMap(s=>s.facts.filter(f=>!['Номинал','Курс в рублях за номинал'].includes(f.label)).map(f=>f.label+' — '+f.value)).join('; ')}</p><FinancialSourcesDetails value={s.sources}/></>}
   {s.derived&&<><p className={styles.derivedValue}>{s.derived.display}</p><details><summary>Как рассчитано</summary>{s.derivation&&<p>{s.derivation.left} {({sum:'+',difference:'−',multiply:'×',divide:'÷',ratio:'÷',percentage:'×'} as Record<string,string>)[s.derivation.operation]} {s.derivation.right}{s.derivation.operation==='ratio'?' × 100%':''} = {s.derived.display}.</p>}<p>Использованы проверенные результаты предыдущих шагов и явно заданные параметры. Округление до ближайшей копейки; проценты — до сотой доли.</p></details></>}
   {a&&q&&r&&<><p className={styles.derivedValue}>{a.analysis?.value===null?'Нет данных':countMetric(q.metric)?a.analysis?.value??r.totals[q.metric]??'0':formatMoney(a.analysis?.value??r.totals[q.metric]??'0')}</p>{a.analysis&&<AnalyzerAnalysis value={a.analysis} onOpen={onOpen}/>} {a.widget&&r.chart!=='table'&&q.grouping!=='none'&&r.points.length>1&&<Suspense fallback={<p role="status">Загружаем график…</p>}><Chart widget={a.widget} result={r} onPoint={p=>onOpen(p.filter,p.label)}/></Suspense>}{q.grouping!=='none'&&<AnalyzerAnswerRows id={id} section={s.index} query={q} result={r} onOpen={onOpen}/>}<details><summary>Как рассчитано</summary><p>{metricNames[q.metric]}. {r.analysis}</p><FilterContext filter={r.filter} state={state}/><p>На основе {r.operationCount} операций · {a.accountCount??0} счетов. {a.computedAt?'Рассчитано '+new Date(a.computedAt).toLocaleString('ru-RU'):''}</p></details><button type="button" className={base.linkButton} onClick={()=>onOpen({...r.filter,metric:q.metric},s.label)}>Открыть в Операциях</button></>}
  </section>;})}
 </section>;
}
