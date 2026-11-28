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

it('shows comparison differences and the largest changes in a public answer',async()=>{
 const {AnalyzerAnalysis}=await import('./AnalyzerAnalysis');
 const value={version:'cashneuro-analysis/1' as const,statistic:'sum' as const,unit:'money' as const,value:'16000',sum:'16000',count:2,mean:'8000',median:null,minimum:'6000',maximum:'10000',notes:[],comparison:{previousValue:'18000',difference:'-2000',largestIncrease:{label:'Beta',difference:'6000',filter:{}},largestDecrease:{label:'Gamma',difference:'-9000',filter:{}}}};
 const content=text(renderToStaticMarkup(createElement(AnalyzerAnalysis,{value,onOpen:()=>{}})));
 expect(content).toContain('Изменение относительно периода сравнения: −20 ₽');expect(content).toContain('Наибольший рост — Beta : +60 ₽');expect(content).toContain('Наибольшее снижение — Gamma : −90 ₽');
});

it('renders both V2 payment schedules with their charts; number/table mode can hide charts',()=>{
 const inputs=['annuity','differentiated'].map(payment=>({...input,months:24,payment})) as Parameters<typeof calculateFinancial>[0][];
 const results=inputs.map(v=>calculateFinancial(v)) as Extract<ReturnType<typeof calculateFinancial>,{kind:'loan'}>[];
 const report:ReportResult={version:'cashneuro-report/1',facts:[],narrative:[],sections:results.map((calculation,i)=>({index:i+1,label:'Вариант '+(i+1)+' · '+(calculation.input.payment==='annuity'?'аннуитетный':'дифференцированный'),calculation}))};
 const render=(showCharts:boolean)=>renderToStaticMarkup(createElement(AnalyzerReport,{id:'synthetic-v2',value:report,state:{} as FinanceState,onOpen:()=>{},showCharts}));
 const html=render(true);expect((html.match(/role="img"/g)??[]).length).toBe(2);expect((html.match(/Расчётный график кредита/g)??[]).length).toBe(2);
 expect(text(html)).toContain('Основной долг');expect(text(html)).toContain('Проценты');expect(text(html)).toContain('12 из 24');expect(text(html)).toContain('Вариант 1 · аннуитетный');expect(text(html)).toContain('Вариант 2 · дифференцированный');
 expect(render(false)).not.toContain('role="img"');
});
