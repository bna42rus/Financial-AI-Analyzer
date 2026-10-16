import { object, uuid } from '../../finance-core/src/model.ts';
import { parseTaskBook, emptyTaskBook, globalSnapshot } from './task-context.ts';
import type { TaskBook, TaskScope, GlobalSnapshot } from './task-context.ts';
import { parseCalendar, cleanAssistantQuestion, AssistantError, assistantGrouping } from './assistant-plan.ts';
import type { Calendar, SourceContext } from './assistant-plan.ts';

export const conversationVersion = 'cashneuro-assistant-conversation/1';
export type ConversationTurn = { messageId: string; question: string; calendar: Calendar; global: GlobalSnapshot;
  status: 'query' | 'answer' | 'redirect' | 'clarification' | 'unsupported' | 'error'; code: string; pending: boolean };
export type Conversation = { version: typeof conversationVersion; book: TaskBook; turns: ConversationTurn[]; pendingMessageId: string | null };
export function emptyConversation(scope: TaskScope): Conversation {
  return { version: conversationVersion, book: emptyTaskBook(scope), turns: [], pendingMessageId: null };
}
export function parseConversation(value: unknown, scope: TaskScope): Conversation {
  const r = object(value, ['version', 'book', 'turns', 'pendingMessageId']);
  if (r.version !== conversationVersion || !Array.isArray(r.turns) || r.turns.length > 100) throw new AssistantError('ASSISTANT_CONTEXT_INVALID');
  const book = parseTaskBook(r.book, scope), seen = new Set<string>();
  const turns = r.turns.map(raw => {
    const v = object(raw, ['messageId', 'question', 'calendar', 'global', 'status', 'code', 'pending']);
    const messageId = uuid(v.messageId);
    if (seen.has(messageId) || cleanAssistantQuestion(v.question) !== v.question || typeof v.pending !== 'boolean' ||
        typeof v.code !== 'string' || !/^[A-Z][A-Z0-9_]{0,80}$/.test(v.code) || !['query', 'answer', 'redirect', 'clarification', 'unsupported', 'error'].includes(String(v.status))) throw new AssistantError('ASSISTANT_CONTEXT_INVALID');
    if ((v.status === 'query') !== book.nodes.some(n => n.messageId === messageId) || v.pending && ['query', 'answer', 'redirect'].includes(String(v.status))) throw new AssistantError('ASSISTANT_CONTEXT_INVALID');
    seen.add(messageId); return { ...v, messageId, calendar: parseCalendar(v.calendar), global: globalSnapshot(v.global) } as ConversationTurn;
  });
  if (book.nodes.some(n => !seen.has(n.messageId))) throw new AssistantError('ASSISTANT_CONTEXT_INVALID');
  const pendingMessageId = r.pendingMessageId === null ? null : uuid(r.pendingMessageId);
  if (pendingMessageId && !turns.some(t => t.messageId === pendingMessageId && t.pending)) throw new AssistantError('ASSISTANT_CONTEXT_INVALID');
  return { version: conversationVersion, book, turns, pendingMessageId };
}

/** Only cleaned user requests and coarse outcomes leave the server. No model
 * payloads, UUIDs, filters, totals or private transaction/catalog dumps. */
export function conversationInput(raw: Conversation, scope: TaskScope, question: string, calendar: Calendar) {
  const state = parseConversation(raw, scope), head = state.book.nodes.at(-1)?.messageId;
  const lastQuery = state.turns.findLastIndex(t => t.status === 'query');
  const unresolved = (turn: ConversationTurn, index: number) => state.pendingMessageId !== null && turn.pending && index > lastQuery;
  const selected = state.turns.map((turn, index) => ({ turn, index })).filter(({ turn, index }) => index >= state.turns.length - 12 || unresolved(turn, index) || turn.messageId === head);
  const history = selected.map(({ turn, index }) => {
    const node = state.book.nodes.find(n => n.messageId === turn.messageId);
    return { ref: 'h' + (index + 1), question: turn.question, calendar: turn.calendar, status: turn.status, pending: unresolved(turn, index),
      ...(node ? { task: { metric: node.query.metric, grouping: assistantGrouping[node.query.grouping], comparison: node.query.comparison } } : {}) };
  });
  const sources: Record<string, SourceContext> = Object.fromEntries(selected.map(({ turn, index }) => ['h' + (index + 1), { calendar: turn.calendar, global: turn.global, pending: unresolved(turn, index) }]));
  const pending = state.turns.findIndex(t => t.messageId === state.pendingMessageId);
  const active = state.book.nodes.at(-1)?.query;
  return { input: { question: cleanAssistantQuestion(question), calendar: parseCalendar(calendar),
    activeTask: active ? { metric: active.metric, grouping: assistantGrouping[active.grouping], comparison: active.comparison, omittedChanges: 'preserve' } : null,
    history, omittedHistoryCount: state.turns.length - history.length },
    sources, pendingSource: pending < 0 ? undefined : 'h' + (pending + 1) };
}

export function appendConversation(state: Conversation, scope: TaskScope, turn: ConversationTurn, book = state.book): Conversation {
  const next = { version: conversationVersion, book, turns: [...state.turns, turn],
    pendingMessageId: turn.status === 'query' ? null : turn.pending ? turn.messageId : state.pendingMessageId };
  return parseConversation(next, scope);
}
