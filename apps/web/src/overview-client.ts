import {kindNames,roleNames,bankNames} from './finance-client';
import type {calculateOverview,OverviewView,Widget,OverviewPoint} from '../../../packages/finance-core/src/overview';
import type {Metric} from '../../../packages/finance-core/src/metrics';
import {formatMoney} from './demo/overview';
export type OverviewData=ReturnType<typeof calculateOverview>&{generation:string;revision:string;timezone:string;warnings?:string[];budgetOptions:{id:string;name:string}[]};
export type SavedOverviewView={id:string;name:string;definition:OverviewView;isDefault:boolean;dependencyStatus:'ready'|'needs_setup';revision:string;position:number;modifiedAt:string};
export type {OverviewView,Widget,OverviewPoint,Metric};
export const periodNames={global:'Общий период',all:'Вся история',fixed:'Фиксированные даты',current_month:'Текущий месяц',previous_month:'Прошлый месяц',last_30_days:'Последние 30 дней'};
export const groupingNames={time:'Время',category:'Категория',subcategory:'Подкатегория',account:'Счёт',bank:'Банк',kind:'Тип',role:'Финансовый смысл',counterparty:'Контрагент',merchant:'Получатель / магазин',operation:'Операция',none:'Без группировки'};
export const comparisonNames={none:'Не сравнивать',previous_same:'Предыдущий период той же длины',previous_month:'Предыдущий месяц',previous_year:'Предыдущий год',custom:'Другие даты'};
export const chartNames={bar:'Столбцы',line:'Линия',donut:'Кольцо',table:'Таблица'};
export const granularityNames={auto:'Автоматически',day:'День',week:'Неделя',month:'Месяц',quarter:'Квартал',year:'Год'};
export function metricValue(metric:Metric,value:string){return ['operation_count','attention'].includes(metric)?value+' операций':formatMoney(value);}

export function pointLabel(p:OverviewPoint,grouping:Widget['grouping'],granularity:string){if(grouping==='time'&&/^\d{4}-\d{2}-\d{2}$/.test(p.label)){const d=new Date(p.label+'T00:00:00Z');return granularity==='year'?p.label.slice(0,4):granularity==='quarter'?Math.floor((d.getUTCMonth())/3)+1+' квартал '+d.getUTCFullYear():new Intl.DateTimeFormat('ru-RU',granularity==='month'?{month:'long',year:'numeric',timeZone:'UTC'}:{day:'numeric',month:'short',year:'numeric',timeZone:'UTC'}).format(d);}return kindNames[p.label]??roleNames[p.label]??bankNames[p.label]??p.label;}
