import {describe,it,expect} from 'vitest';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {CalculatorDetails} from './CalculatorDetails';
import {AnalyzerReport} from './AnalyzerReport';
import {calculateFinancial} from '../../../packages/analyzer/src/calculators';
import type {FinanceState} from './finance-client';
import type {ReportResult} from '../../../packages/analyzer/src/report';
const input={kind:'loan' as const,principalRubles:'1200',annualRatePercent:'12',months:2,payment:'differentiated' as const};
const text=(html:string)=>html.replace(/<[^>]*>/g,' ').replace(/\s+/g,' ');
describe('calculator presentation',()=>{
 it('shows monthly payments and their composition with exact independently checkable two-month values',()=>{
  const value=calculateFinancial(input),html=renderToStaticMarkup(createElement(CalculatorDetails,{value})),content=text(html);
  expect(content).toContain('Ежемесячные платежи: основной долг и проценты');expect(content).toContain('612 ₽');expect(content).toContain('606 ₽');expect(content).toContain('18 ₽');expect(content).toContain('1 218 ₽');
  expect(content).not.toContain('Остаток долга по месяцам');expect(content).not.toContain('Версия');expect(content).not.toContain('Экономия');expect(content).not.toContain('Не использовано');expect(content).not.toContain('Досрочно');expect(html).toContain('role="img"');
 });
 it('keeps prepayment amounts and a genuine zero saving visible when the scenario actually includes prepayment',()=>{
  const value=calculateFinancial({...input,annualRatePercent:'0',prepayments:[{month:1,amountRubles:'600',strategy:'reduce_term'}]}),content=text(renderToStaticMarkup(createElement(CalculatorDetails,{value})));
  expect(content).toContain('Экономия процентов');expect(content).toContain('Досрочно');
 });
 it('compares verified interest separately from payment load and does not rank different loan principals',()=>{
  const render=(principalRubles:string)=>{
   const value:ReportResult={version:'cashneuro-report/1',facts:[],narrative:[],sections:[{index:1,label:'Аннуитетный',calculation:calculateFinancial({...input,payment:'annuity'})},{index:2,label:'Дифференцированный',calculation:calculateFinancial({...input,principalRubles})}]};
   return text(renderToStaticMarkup(createElement(AnalyzerReport,{id:'synthetic-report',value,state:{} as FinanceState,onOpen:()=>{}})));
  };
  const same=render('1200');expect(same).toContain('Проценты за весь срок');expect(same).toContain('Наименьшая сумма процентов — «Дифференцированный»');expect(same).toContain('0,03 ₽');expect(render('2400')).not.toContain('Наименьшая сумма процентов');
 });
});
