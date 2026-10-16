import type { TaskModel } from './analyzer-task-workflow.ts';
import { parseTaskIntent, compileTaskIntent, taskIntentVersion } from '../../../packages/analyzer/src/task-intent.ts';
import { safeQuestion } from '../../../packages/analyzer/src/yandex-contract.ts';

export { taskIntentVersion };
export type IntentExtractionInput = { question: string; hasFinancialTasks: boolean };
/** One extraction before finance access, followed by a local compilation. The
 * extractor cannot see task descriptors, filters, IDs, catalogs or old totals.
 * This adapter uses exactly the existing guarded/persisted financial workflow. */
export function intentTaskModel(extract: (input: IntentExtractionInput) => Promise<unknown>): TaskModel {
  let saved: { question: string; intent: ReturnType<typeof parseTaskIntent> } | undefined;
  return {
    async relevance(input) {
      if (saved) throw new TypeError('TASK_INTENT_MODEL_REUSED');
      const question = safeQuestion(input.question);
      const raw = await extract({ question, hasFinancialTasks: input.hasFinancialTasks });
      try {
        const intent = parseTaskIntent(raw, question); saved = { question, intent };
        return { relevance: intent.relevance };
      } catch { return {}; }
    },
    async proposal(input) {
      if (!saved || saved.question !== input.question) throw new TypeError('TASK_INTENT_INPUT_CHANGED');
      try { return compileTaskIntent(saved.intent, input.question, input.currentDate, input.tasks.map(t => t.metric)); } catch { return {}; }
    },
  };
}
