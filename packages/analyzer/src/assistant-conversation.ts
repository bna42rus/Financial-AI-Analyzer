import type {ReportRequest,Fact} from './report.ts';
import {parseReport} from './report.ts';
import {reportRequestSchema} from './assistant-plan.ts';
import {parseCalculatorInput} from './calculators.ts';
import type {CalculatorInput} from './calculators.ts';
import { object, uuid } from '../../finance-core/src/model.ts';
import { parseTaskBook, emptyTaskBook, globalSnapshot } from './task-context.ts';
import type { TaskNode, TaskBook, TaskScope, GlobalSnapshot } from './task-context.ts';
import { parseCalendar, cleanAssistantQuestion, AssistantError, assistantGrouping } from './assistant-plan.ts';
import type { Calendar, SourceContext } from './assistant-plan.ts';
import {assistantDisplayText} from './assistant-text.ts';

export const conversationVersion = 'cashneuro-assistant-conversation/2';
export type ConversationTurn = { response?:string; report?:{request:ReportRequest;facts:Fact[]}; calculation?:CalculatorInput; messageId: string; question: string; calendar: Calendar; global: GlobalSnapshot;
  status: 'query' | 'answer' | 'redirect' | 'clarification' | 'unsupported' | 'error'; code: string; pending: boolean };
export type CategoryChoice = { node: TaskNode; options: string[] };
export type Conversation = { version: typeof conversationVersion; book: TaskBook; turns: ConversationTurn[]; pendingMessageId: string | null; categoryChoice: CategoryChoice | null };
export function emptyConversation(scope: TaskScope): Conversation {
  return { version: conversationVersion, book: emptyTaskBook(scope), turns: [], pendingMessageId: null, categoryChoice: null };
}
export function parseConversation(value: unknown, scope: TaskScope): Conversation {
  const r = object(value, ['version', 'book', 'turns', 'pendingMessageId', 'categoryChoice']);
  if (r.version !== conversationVersion || !Array.isArray(r.turns) || r.turns.length > 100) throw new AssistantError('ASSISTANT_CONTEXT_INVALID');
  const book = parseTaskBook(r.book, scope), seen = new Set<string>();
  const turns = r.turns.map(raw => {
    const v = object(raw, ['messageId', 'question', 'calendar', 'global', 'status', 'code', 'pending','calculation','report','response']);
    if(v.response!==undefined&&assistantDisplayText(v.response,1200)!==v.response)throw new AssistantError('ASSISTANT_CONTEXT_INVALID');
    const messageId = uuid(v.messageId);
    if (seen.has(messageId) || cleanAssistantQuestion(v.question) !== v.question || typeof v.pending !== 'boolean' ||
        typeof v.code !== 'string' || !/^[A-Z][A-Z0-9_]{0,80}$/.test(v.code) || !['query', 'answer', 'redirect', 'clarification', 'unsupported', 'error'].includes(String(v.status))) throw new AssistantError('ASSISTANT_CONTEXT_INVALID');
    if ((v.status === 'query') !== book.nodes.some(n => n.messageId === messageId) || v.pending && ['query', 'answer', 'redirect'].includes(String(v.status))) throw new AssistantError('ASSISTANT_CONTEXT_INVALID');
    if(v.report){const report=object(v.report,['request','facts']);parseReport(report.request,reportRequestSchema);if(!Array.isArray(report.facts)||report.facts.length>150)throw new AssistantError('ASSISTANT_CONTEXT_INVALID');for(const f of report.facts){const fact=object(f,['ref','label','value','display','unit','flow','periodMonths']);if(typeof fact.ref!=='string'||!/^s[1-5]\.[a-z][a-z0-9_]*$/u.test(fact.ref)||typeof fact.value!=='string'||fact.value.length>3000||fact.unit!=='text'&&!/^-?\d+$/u.test(fact.value)||typeof fact.label!=='string'||typeof fact.display!=='string'||!['money','count','percent','text'].includes(String(fact.unit)))throw new AssistantError('ASSISTANT_CONTEXT_INVALID');}}
    seen.add(messageId); return { ...v,...(v.calculation?{calculation:parseCalculatorInput(v.calculation)}:{}), messageId, calendar: parseCalendar(v.calendar), global: globalSnapshot(v.global) } as ConversationTurn;
  });
  if (book.nodes.some(n => !seen.has(n.messageId))) throw new AssistantError('ASSISTANT_CONTEXT_INVALID');
  const pendingMessageId = r.pendingMessageId === null ? null : uuid(r.pendingMessageId);
  if (pendingMessageId && !turns.some(t => t.messageId === pendingMessageId && t.pending)) throw new AssistantError('ASSISTANT_CONTEXT_INVALID');
  let categoryChoice: CategoryChoice | null = null;
  if (r.categoryChoice !== null) {
    const choice = object(r.categoryChoice, ['node', 'options']);
    const draft = parseTaskBook({ ...book, nodes: [...book.nodes, choice.node] }, scope).nodes.at(-1)!;
    if (draft.messageId !== pendingMessageId || !turns.some(t => t.messageId === draft.messageId && t.code === 'CATEGORY_CHOICE_REQUIRED') ||
        !Array.isArray(choice.options) || choice.options.length > 3 || choice.options.some(n => typeof n !== 'string' || n.length > 160 || cleanAssistantQuestion(n) !== n)) throw new AssistantError('ASSISTANT_CONTEXT_INVALID');
    categoryChoice = { node: draft, options: choice.options as string[] };
  }
  return { version: conversationVersion, book, turns, pendingMessageId, categoryChoice };
}

/** Send cleaned questions, short public explanations and checked semantic
 * summaries. UUIDs and complete transaction/catalog dumps stay on the server. */
export function conversationInput(raw: Conversation, scope: TaskScope, question: string, calendar: Calendar) {
  const state = parseConversation(raw, scope), head = state.book.nodes.at(-1)?.messageId;
  const lastQuery = state.turns.findLastIndex(completedTask);
  const unresolved = (turn: ConversationTurn, index: number) => state.pendingMessageId !== null && turn.pending && index > lastQuery;
  const calculationTurn=state.turns.findLast(t=>t.calculation||t.report?.request.steps.some(s=>s.kind==='calculate'));
  const reportTurn=state.turns.findLast(t=>t.report);
  const recentTasks=new Set(state.book.nodes.slice(-8).map(n=>n.messageId));
  const selected = state.turns.map((turn, index) => ({ turn, index })).filter(({ turn, index }) => index >= state.turns.length - 12 || unresolved(turn, index) || turn.messageId === head || recentTasks.has(turn.messageId) || turn===calculationTurn || turn===reportTurn);
  const history = selected.map(({ turn, index }) => {
    const node = state.book.nodes.find(n => n.messageId === turn.messageId);
    return { ...(turn.response?{response:turn.response}:{}),...(turn.report?{report:{steps:turn.report.request.steps.map(s=>({kind:s.kind,label:s.label,...(s.kind==='calculate'?{calculation:s.calculation}:{})}))}}:{}),...(turn.calculation?{calculation:turn.calculation}:{}),ref: 'h' + (index + 1), question: turn.question, calendar: turn.calendar, status: turn.status, pending: unresolved(turn, index),
      ...(node ? { task: taskSummary(node) } : {}) };
  });
  const sources: Record<string, SourceContext> = Object.fromEntries(selected.map(({ turn, index }) => {
    const taskIndex=state.book.nodes.findIndex(n=>n.messageId===turn.messageId),node=state.book.nodes[taskIndex];
    return ['h' + (index + 1), { calendar: turn.calendar, global: turn.global, pending: unresolved(turn, index),...(node?{taskHandle:'t'+(taskIndex+1),query:node.query}:{}) }];
  }));
  const pending = state.turns.findIndex(t => t.messageId === state.pendingMessageId);
  const active = state.book.nodes.at(-1)?.query;
  return { input: { question: cleanAssistantQuestion(question), calendar: parseCalendar(calendar),
    activeReport:reportTurn?.report??null,
    activeCalculation:calculationTurn?.calculation??calculationTurn?.report?.request.steps.findLast(s=>s.kind==='calculate')?.calculation??null,
    activeCalculations:calculationTurn?.calculation?[{calculation:calculationTurn.calculation}]:calculationTurn?.report?.request.steps.filter(s=>s.kind==='calculate').map(s=>({label:s.label,calculation:s.calculation}))??[],
    activeTask: active ? { ...taskSummary(state.book.nodes.at(-1)!), omittedChanges: 'preserve' } : null,
    categoryChoice: state.categoryChoice ? { options: state.categoryChoice.options, omittedChanges: 'preserve' } : null,
    pendingRequest: pending < 0 ? null : history.find(t => t.ref === 'h' + (pending + 1)) ?? null,
    history, omittedHistoryCount: state.turns.length - history.length },
    sources, pendingSource: pending < 0 ? undefined : 'h' + (pending + 1) };
}

export function appendConversation(state: Conversation, scope: TaskScope, turn: ConversationTurn, book = state.book, categoryChoice: CategoryChoice | null = null): Conversation {
  const next = { version: conversationVersion, book, turns: [...state.turns, turn],
    pendingMessageId: completedTask(turn) ? null : turn.pending ? turn.messageId : state.pendingMessageId,
    categoryChoice: completedTask(turn) ? null : categoryChoice ?? (turn.pending ? null : state.categoryChoice) };
  return parseConversation(next, scope);
}

function completedTask(t:ConversationTurn){return t.status==='query'||t.status==='answer'&&['FINANCIAL_CALCULATION','FINANCIAL_REPORT','CHANGE_PROPOSED'].includes(t.code);}
function taskSummary(node:TaskNode){const q=node.query;return {metric:q.metric,grouping:assistantGrouping[q.grouping],comparison:q.comparison,period:{...(q.filter.from?{from:q.filter.from}:{}),...(q.filter.through?{through:q.filter.through}:{})},...(q.options?{options:q.options}:{})};}

export function conversationCalculation(state:Conversation,source:string,variant?:number):CalculatorInput|undefined{
  const turn=source==='active'?state.turns.findLast(t=>t.calculation||t.report?.request.steps.some(s=>s.kind==='calculate')):/^h(?:100|[1-9][0-9]?)$/u.test(source)?state.turns[Number(source.slice(1))-1]:undefined;
  const values=turn?.calculation?[turn.calculation]:turn?.report?.request.steps.filter(s=>s.kind==='calculate').map(s=>s.calculation)??[];
  return variant?values[variant-1]:values.length===1?values[0]:undefined;
}
