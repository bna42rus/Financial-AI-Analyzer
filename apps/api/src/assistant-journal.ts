import { constants } from 'node:fs';
import { open, lstat, realpath, readdir, rename, unlink } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { FileHandle } from 'node:fs/promises';
import { uuid, object } from '../../../packages/finance-core/src/model.ts';
import { AssistantError } from '../../../packages/analyzer/src/assistant-plan.ts';
import type { AssistantJournal, AssistantRequest, RunReceipt } from './assistant-workflow.ts';
import { assistantRequestFingerprint, assistantWorkflowVersion } from './assistant-workflow.ts';
import type { DispatchBound, Usage } from '../../../packages/analyzer/src/cost.ts';
import { usageTokens } from '../../../packages/analyzer/src/cost.ts';

export type AssistantAccounting = {
  // Must reserve against the separately authorized experiment/project budget.
  // Unknown usage retains its reservation; settlement is idempotent.
  reserve(requestId: string, index: number, bound: DispatchBound): Promise<void>;
  settle(requestId: string, index: number, usage?: Usage): Promise<void>;
};
export async function readAssistantPrivateFile(path: string) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const s = await file.stat();
    if (!s.isFile() || s.nlink !== 1 || s.uid !== process.getuid?.() || (s.mode & 0o777) !== 0o600 || s.size > 2097152) throw Error();
    return JSON.parse(await file.readFile('utf8'));
  } catch { throw new AssistantError('ASSISTANT_JOURNAL_INVALID'); } finally { await file.close(); }
}
async function syncDirectory(directory: string) {
  const fd = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); try { await fd.sync(); } finally { await fd.close(); }
}
function checkedReceipt(raw: unknown, fingerprint: string): RunReceipt {
  const r = object(raw, ['version', 'receipt']);
  if (r.version !== assistantWorkflowVersion) throw new AssistantError('ASSISTANT_JOURNAL_INVALID');
  const v = object(r.receipt, ['fingerprint', 'calls', 'result', 'conversation']);
  if (v.fingerprint !== fingerprint) throw new AssistantError('ASSISTANT_REQUEST_CHANGED');
  if (!Array.isArray(v.calls) || v.calls.length > 3) throw new AssistantError('ASSISTANT_JOURNAL_INVALID');
  if (Boolean(v.result) !== Boolean(v.conversation)) throw new AssistantError('ASSISTANT_JOURNAL_INVALID');
  for (const call of v.calls) {
    const c = object(call, ['fingerprint', 'phase', 'state', 'value', 'usage', 'code']);
    if (typeof c.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(c.fingerprint) || !['understand', 'repair', 'check_changes', 'categories', 'explain'].includes(String(c.phase)) ||
        !['sent', 'received', 'unknown', 'failed'].includes(String(c.state)) || c.state === 'received' && (!c.usage || !('value' in c))) throw new AssistantError('ASSISTANT_JOURNAL_INVALID');
    if (c.usage) { const u = object(c.usage, ['inputTokens', 'outputTokens', 'modelVersion']); usageTokens(u.inputTokens); usageTokens(u.outputTokens); }
  }
  return v as RunReceipt;
}

/** A new private directory only: no old ledger/artifact is accepted or modified.
 * This journal is suitable for the operator trial. Production must use the
 * transactional DB accounting/state adapter before enabling a customer route. */
export async function withAssistantJournal<T>(directory: string, request: AssistantRequest, accounting: AssistantAccounting, action: (journal: AssistantJournal) => Promise<T>): Promise<T> {
  directory = resolve(directory); const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o700 || await realpath(directory) !== directory) throw new AssistantError('ASSISTANT_JOURNAL_DIRECTORY_INVALID');
  const marker = join(directory, 'assistant-version.json');
  try { if ((await readAssistantPrivateFile(marker)).version !== assistantWorkflowVersion) throw new AssistantError('ASSISTANT_JOURNAL_INVALID'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    if ((await readdir(directory)).length) throw new AssistantError('ASSISTANT_JOURNAL_NOT_EMPTY');
    const fd = await open(marker, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await fd.writeFile(JSON.stringify({ version: assistantWorkflowVersion }) + '\n'); await fd.sync(); } finally { await fd.close(); }
    await syncDirectory(directory);
  }
  const id = uuid(request.requestId), path = join(directory, id + '.json'), lockPath = join(directory, id + '.lock');
  let lock: FileHandle;
  try { lock = await open(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
  catch { throw new AssistantError('ASSISTANT_REQUEST_IN_PROGRESS'); }
  try {
    await lock.writeFile(String(process.pid)); await lock.sync(); await syncDirectory(directory);
    const fingerprint = assistantRequestFingerprint(request); let receipt: RunReceipt;
    try { receipt = checkedReceipt(await readAssistantPrivateFile(path), fingerprint); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; receipt = { fingerprint, calls: [] }; }
    const journal: AssistantJournal = { receipt,
      reserve: (index, bound) => accounting.reserve(id, index, bound), settle: (index, usage) => accounting.settle(id, index, usage),
      async persist() {
        const text = JSON.stringify({ version: assistantWorkflowVersion, receipt }) + '\n';
        if (Buffer.byteLength(text) > 2097152) throw new AssistantError('ASSISTANT_JOURNAL_TOO_LARGE');
        const temporary = join(directory, id + '.' + randomUUID() + '.tmp');
        const fd = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        try { await fd.writeFile(text); await fd.sync(); } finally { await fd.close(); }
        await rename(temporary, path); await syncDirectory(directory);
      },
    };
    await journal.persist(); return await action(journal);
  } finally { await lock.close(); await unlink(lockPath); await syncDirectory(directory); }
}
