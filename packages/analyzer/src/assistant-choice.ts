import type { AssistantPlan } from './assistant-plan.ts';
import { parseTaskBook } from './task-context.ts';
import type { ResolvedTask } from './task-context.ts';
import type { Conversation } from './assistant-conversation.ts';

/** A pending category choice is its own server state, never a successful task.
 * Only an explicitly named offered option can select it. An explicit restart
 * or reference bypasses it. All IDs/access are revalidated before execution. */
export function bindCategoryChoice(state: Conversation, plan: AssistantPlan, question: string) {
  const draft = state.categoryChoice;
  const changes = (plan.changes ?? []).filter(c => (c.source ?? 'current') === 'current');
  const names = changes.find(c => c.field === 'categories' && c.op === 'set')?.value as { names?: string[] } | undefined;
  const folded = (s: string) => s.normalize('NFKC').toLocaleLowerCase('ru-RU').replace(/ё/gu, 'е').trim();
  // A literal selection command plus an offered name is stronger than the
  // model's default new. Self-contained questions still use its normal route.
  const selection = /^(?:тогда|выбери(?:те)?|возьми(?:те)?|используй(?:те)?|оставь(?:те)?)(?=$|[^\p{L}\p{N}])/u.test(folded(question));
  if (!selection || !draft || plan.action !== 'read' || plan.context?.restart || plan.context?.mode === 'reference' ||
      !names?.names?.length || !names.names.every(n => folded(question).includes(folded(n)) && draft.options.some(o => folded(o) === folded(n)))) return { plan, book: state.book, draft: undefined };
  return { plan: { ...plan, context: { mode: 'continue' as const }, changes },
    book: parseTaskBook({ ...state.book, nodes: [...state.book.nodes, draft.node] }, state.book.scope), draft: draft.node };
}

/** Remove the draft from committed ancestry; no fake successful parent is
 * inserted. Conditions from the pending request belong to this calculation. */
export function collapseCategoryDraft(result: ResolvedTask, draftId: string, parent: string | null): ResolvedTask {
  if (result.node.parent !== draftId) return result;
  const node = structuredClone(result.node); node.parent = parent;
  for (const origin of Object.values(node.origins)) if (origin.messageId === draftId) origin.messageId = node.messageId;
  return { ...result, node, inheritedFrom: parent };
}
