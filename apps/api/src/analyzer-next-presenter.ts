import {isDeepStrictEqual} from 'node:util';
import {registryVersion} from '../../../packages/analyzer/src/registry.ts';
import type {Answer} from '../../../packages/analyzer/src/types.ts';
import type {TurnResult} from '../../../packages/analyzer/src/next/workflow.ts';
import type {Prepared} from '../../../packages/analyzer/src/next/tasks.ts';
import {factDisplay} from '../../../packages/analyzer/src/report.ts';

const unavailable=(text:string,code:string,clarify=false):Answer=>({registryVersion,mode:clarify?'clarification':'unavailable',text,notice:{kind:clarify?'clarification':'error',code}});
const fields:Record<string,string>={principalRubles:'сумму кредита',annualRatePercent:'годовую ставку',months:'срок в месяцах',metric:'что посчитать: расходы, доходы или другой показатель',loan_conditions:'совместимые условия кредита',payment:'тип платежа',prepayments:'условия досрочных платежей',rateChanges:'изменения ставки'};
export function presentNextResult(result:TurnResult,prepared:Prepared|undefined,readAnswer?:Answer):Answer{
 if(result.status==='completed'){
  const out=result.outcome;
  if(out.kind==='read'){
   if(!readAnswer||!isDeepStrictEqual(readAnswer.result,out.result))throw new TypeError('NEXT_RESULT_INVALID');
   return structuredClone(readAnswer);
  }
  if(!prepared||prepared.kind==='read'||!out.results.length)throw new TypeError('NEXT_RESULT_INVALID');
  const text=out.kind==='loan'?'Расчёт кредита по указанным условиям.':
   (out.winnerIndexes.length===out.results.length?'По выбранному показателю варианты равны.':
    (prepared.kind==='loan_comparison'&&prepared.objective==='max'?'Наибольшее':'Наименьшее')+' значение показателя «'+
    (prepared.kind==='loan_comparison'?{interest:'проценты за весь срок',total_paid:'всего выплат',payment:'первый платёж'}[prepared.criterion]:'проценты')+'» — '+out.winnerIndexes.map(i=>'вариант '+(i+1)).join(', ')+'.')+
    ' Сравниваются только выбранные варианты; точные суммы приведены ниже.';
  if(out.results.length===1)return {registryVersion,mode:'ai',text,calculation:structuredClone(out.results[0]!)};
  return {registryVersion,mode:'ai',text,report:{version:'cashneuro-report/1',facts:[],narrative:[],sections:out.results.map((calculation,i)=>({index:i+1,label:'Вариант '+(i+1)+' · '+(calculation.input.payment==='annuity'?'аннуитетный':'дифференцированный'),calculation:structuredClone(calculation)}))}};
 }
 if(result.status==='waiting'&&result.preparation.status==='waiting')return unavailable('Для расчёта уточните: '+result.preparation.missing.map(f=>fields[f]??'условие расчёта').join(', ')+'.',result.preparation.code,true);
 if(result.status==='explanation'&&result.preparation.status==='explanation'){
  const p=result.preparation;
  if(p.subject.kind==='result'&&p.historical?.kind==='loan')return {registryVersion,mode:'ai',text:'Это сохранённый расчёт по условиям того вопроса. '+p.historical.results.map((r,i)=>'Вариант '+(i+1)+': проценты за весь срок '+factDisplay(r.interestMinor,'money')+', всего выплат '+factDisplay(r.totalPaidMinor,'money')+'.').join(' ')};
  if(p.subject.kind==='result'&&p.historical?.kind==='read')return {registryVersion,mode:'ai',text:'Это сохранённый результат по выбранным тогда условиям. '+p.historical.result.analysis+' При новом расчёте используются актуальные операции.'};
  if(p.subject.kind==='concept'&&/аннуитет|дифференц|тип.{0,15}плат[её]ж/iu.test(p.subject.question))return {registryVersion,mode:'ai',text:'При аннуитетном кредите регулярный платёж обычно одинаковый: сначала больше процентов, затем больше погашение долга. При дифференцированном основной долг гасится равными частями, а проценты и общий платёж уменьшаются. Тип платежа указан в кредитном договоре и графике банка. Для сравнения нужны одинаковые сумма, ставка, срок и дополнительные условия.'};
  return unavailable('Уточните, какой термин или сохранённый результат нужно объяснить. Сейчас доступны объяснения типов кредитных платежей и выполненных расчётов.','NEXT_EXPLANATION_UNSUPPORTED',true);
 }
 if(result.status==='unrelated')return {registryVersion,mode:'redirect',text:'Я помогаю разбираться в финансах. Спросите о расходах, доходах или кредитном расчёте.'};
 if(result.status==='ambiguous')return unavailable('Уточните, что нужно посчитать или сравнить и за какой период.','MEANING_UNCLEAR',true);
 const code='code'in result?result.code:result.preparation.status==='unsupported'?result.preparation.code:'NEXT_RESULT_INVALID';
 if(/DELIVERY_UNKNOWN|RECONCILIATION_REQUIRED/.test(code))return unavailable('Не удалось подтвердить расход по обращению к ИИ. Сохранённый резерв требует сверки; новая отправка заблокирована.',code);
 if(/COST_EXHAUSTED|BUDGET_EXHAUSTED/.test(code))return unavailable('Доступный лимит расходов исчерпан. Проверьте лимит Анализатора.',code);
 return unavailable(result.status==='unsupported'?'Эта просьба пока не поддерживается целиком. Уточните задачу.':'Не удалось подтвердить полный и корректный результат. Уточните условия вопроса.',code);
}
