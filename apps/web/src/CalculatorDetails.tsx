import {useState} from 'react';
import type {CalculatorResult} from '../../../packages/analyzer/src/calculators';
import {formatMoney} from './demo/overview';
import base from './App.module.css';
import styles from './ServerAnalyzer.module.css';

export function CalculatorDetails({value}:{value:CalculatorResult}){
 const [limit,setLimit]=useState(12),rows=value.kind==='real_return'?[]:value.rows;
 return <details><summary>Условия и расчётная модель</summary>
  <p>Этот расчёт не меняет операции, счета и обязательства. Значения взяты из условий вопроса.</p>
  <ul>{value.assumptions.map(s=><li key={s}>{s}</li>)}</ul>
  {value.kind==='loan'&&<><p>Сумма кредита: {formatMoney(value.principalMinor)}. Исходная ставка: {value.input.annualRatePercent}%. Срок по условиям: {value.input.months} мес. {value.input.payment==='annuity'?'Аннуитетный':'Дифференцированный'} платёж.</p>
   {!!value.unappliedPrepayments.length&&<p role="status">После полного погашения не использованы досрочные платежи за месяцы: {value.unappliedPrepayments.join(', ')}.</p>}
   <div className={styles.tableWrap} tabIndex={0} role="region" aria-label="Расчётный график кредита"><table><thead><tr><th>Месяц</th><th>Платёж</th><th>Основной долг</th><th>Проценты</th><th>Досрочно</th><th>Не использовано</th><th>Остаток</th></tr></thead><tbody>{value.rows.slice(0,limit).map(r=><tr key={r.month}><td>{r.month}</td><td>{formatMoney(r.paymentMinor)}</td><td>{formatMoney(r.principalMinor)}</td><td>{formatMoney(r.interestMinor)}</td><td>{formatMoney(r.extraMinor)}</td><td>{formatMoney(r.unusedExtraMinor)}</td><td>{formatMoney(r.closingMinor)}</td></tr>)}</tbody></table></div></>}
  {value.kind==='deposit'&&<><p>Начальная сумма: {value.input.principalRubles} ₽. Ставка по условиям: {value.input.annualRatePercent}%. {value.input.capitalization?'С капитализацией':'Без капитализации'}. Пополнение в конце каждого месяца: {value.input.monthlyAdditionRubles??'0'} ₽.</p><div className={styles.tableWrap} tabIndex={0} role="region" aria-label="Расчётный график накоплений"><table><thead><tr><th>Месяц</th><th>Начало</th><th>Проценты</th><th>Пополнение</th><th>Остаток</th></tr></thead><tbody>{value.rows.slice(0,limit).map(r=><tr key={r.month}><td>{r.month}</td><td>{formatMoney(r.openingMinor)}</td><td>{formatMoney(r.interestMinor)}</td><td>{formatMoney(r.additionMinor)}</td><td>{formatMoney(r.closingMinor)}</td></tr>)}</tbody></table></div></>}
  {rows.length>limit&&<button type="button" className={base.button} onClick={()=>setLimit(n=>n+24)}>Показать ещё месяцы · {Math.min(limit,rows.length)} из {rows.length}</button>}
  <small>Версия модели: {value.version}</small>
 </details>;
}
