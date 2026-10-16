import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

/** Release identity includes literal dynamic imports used by the HTTP router.
 * Credentials, node_modules and deployment configuration are never hashed. */
export async function assistantRuntimeManifest() {
  const root = new URL('../../../', import.meta.url), pending = [new URL('./main.ts', import.meta.url), new URL('../../../package.json', import.meta.url), new URL('../../../pnpm-lock.yaml', import.meta.url)];
  const source: Record<string, string> = {};
  for (let i = 0; i < pending.length; i++) {
    const url = pending[i]!, key = url.href.slice(root.href.length);
    if (!url.href.startsWith(root.href) || pending.length > 1000) throw Error('ASSISTANT_RUNTIME_SOURCE_INVALID');
    if (key in source) continue;
    const text = await readFile(url,'utf8'); source[key] = createHash('sha256').update(text).digest('hex');
    if (!/\.(?:ts|js|mjs)$/.test(url.pathname)) continue;
    for (const pattern of [/^\s*import\s+(?:[^;'"`]+\s+from\s+)?['"](\.[^'"`]+)['"]/gmu, /^\s*export\s+(?:type\s+)?(?:\{[^}]*\}|\*)\s+from\s+['"](\.[^'"`]+)['"]/gmu, /\bimport\(\s*['"](\.[^'"`]+)['"]\s*\)/gu]) {
      for (const match of text.matchAll(pattern)) pending.push(new URL(match[1]!,url));
    }
  }
  const sorted = Object.fromEntries(Object.entries(source).sort(([a],[b]) => a.localeCompare(b)));
  return { sourceSha256: createHash('sha256').update(JSON.stringify(sorted)).digest('hex'), files: Object.keys(sorted).length, paidCalls: 0 };
}
