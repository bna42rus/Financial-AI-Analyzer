import { createOverview } from './overview';
import type { DemoOperation, OverviewFilters } from './overview';

/** A finite, local preview of the interface. Not an AI intent/relevance classifier. */
export const exampleQuestions = [
  { key:'expenses', text:'Сколько я потратил за выбранный период?', note:'Общая сумма с учётом возвратов' },
  { key:'categories', text:'На что ушли деньги?', note:'Расходы по категориям' },
  { key:'attention', text:'Какие операции требуют внимания?', note:'Список для проверки' },
  { key:'largest', text:'Покажи крупные расходы за сентябрь 2026', note:'Другой период прямо в вопросе' },
] as const;
export type ExampleKey = typeof exampleQuestions[number]['key'];
export interface AnswerSnapshot {
  readonly key: ExampleKey;
  readonly filters: OverviewFilters;
  readonly operationCount: number;
  readonly accountCount: number;
  readonly expenseMinor: string;
  readonly grossMinor: string;
  readonly offsetsMinor: string;
  readonly excludedCount: number;
  readonly neutralCount: number;
  readonly unresolvedCount: number;
  readonly categories: readonly {name:string;amountMinor:string}[];
  readonly operationIds: readonly string[];
  readonly preview: readonly Pick<DemoOperation,'id'|'merchant'|'date'|'amountMinor'>[];
}
export interface ChatMessage { readonly id:string; readonly question:string; readonly text:string; readonly result?:AnswerSnapshot }
export interface Conversation { readonly id:string; readonly title:string; readonly createdAt:string; readonly pinned:boolean; readonly draft:string; readonly messages:readonly ChatMessage[] }
export interface ChatBook { readonly activeId:string; readonly conversations:readonly Conversation[] }
export function newConversation():Conversation { return {id:crypto.randomUUID(),title:'Новый диалог',createdAt:new Date().toISOString(),pinned:false,draft:'',messages:[]}; }
export function newChatBook():ChatBook { const chat=newConversation();return {activeId:chat.id,conversations:[chat]}; }
const normalize=(s:string)=>s.normalize('NFKC').toLocaleLowerCase('ru-RU').replace(/ё/g,'е').replace(/\s+/g,' ').trim();
export function recognizeExample(question:string, hasContext:boolean):ExampleKey|undefined {
  const exact=exampleQuestions.find(item=>normalize(item.text)===normalize(question));
  if(exact)return exact.key;
  return hasContext&&normalize(question)==='а по категориям?'?'categories':undefined;
}
export function makeDemoReply(question:string,rows:readonly DemoOperation[],globalFilters:OverviewFilters,context?:AnswerSnapshot):ChatMessage {
  const id=crypto.randomUUID(),key=recognizeExample(question,!!context);
  if(!key)return {id,question,text:'AI ещё не подключён. В этой демонстрации доступны четыре вопроса из примеров; произвольные запросы пока не обрабатываются.'};
  if(!rows.length)return {id,question,text:'Чтобы посмотреть демонстрационный ответ, включите пример с вымышленными операциями.'};
  const baseFilters=normalize(question)==='а по категориям?'&&context?context.filters:globalFilters;
  const filters:OverviewFilters={...baseFilters,categories:[...baseFilters.categories],...(key==='largest'?{start:'2026-09-01',end:'2026-09-30'}:{})};
  if(filters.start>filters.end)return {id,question,text:'Проверьте период: начальная дата должна быть раньше конечной или совпадать с ней.'};
  const summary=createOverview(rows,filters);
  const resultRows=key==='attention'?summary.matching.filter(row=>row.requiresAttention):key==='largest'?summary.largest:summary.matching.filter(row=>row.role==='expense'&&!row.excluded);
  return {id,question,text:summary.matching.length?'Расчёт по вымышленным операциям.':'По этим фильтрам операций нет. Измените период или другие условия.',result:{
    key,filters,operationCount:summary.matching.length,accountCount:new Set(summary.matching.map(row=>JSON.stringify([row.bank,row.account]))).size,
    expenseMinor:summary.expenseMinor,grossMinor:summary.grossMinor,offsetsMinor:summary.offsetsMinor,excludedCount:summary.excludedCount,neutralCount:summary.neutralCount,unresolvedCount:summary.unresolvedCount,
    categories:summary.categories,operationIds:resultRows.map(row=>row.id),preview:resultRows.slice(0,3).map(({id,merchant,date,amountMinor})=>({id,merchant,date,amountMinor})),
  }};
}
export function historyGroup(createdAt:string,now:Date):string {
  const day=(date:Date)=>Date.UTC(date.getFullYear(),date.getMonth(),date.getDate());
  const days=(day(now)-day(new Date(createdAt)))/86_400_000;
  return days<=0?'Сегодня':days===1?'Вчера':days<7?'Последние 7 дней':'Ранее';
}
