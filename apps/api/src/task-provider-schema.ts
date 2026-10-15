/** Provider-decoding compatibility is separate from the authoritative server
 * contract. vLLM v0.10.2 backend_xgrammar.py:204-245 rejects these features.
 * Cloud.ru does not expose its decoder version, so this is a conservative
 * profile, not proof of the cause of a particular HTTP 400 or API acceptance.
 * This module does not change the frozen v1 pilot or dispatch any request. */
export const taskWireProfile = 'cashneuro-task-wire-xgrammar/1';
const unsupported: Record<string, string[]> = {
  integer: ['multipleOf'], number: ['multipleOf'],
  array: ['uniqueItems', 'contains', 'minContains', 'maxContains'],
  string: ['format'], object: ['minProperties', 'maxProperties', 'propertyNames', 'patternProperties'],
};
type Issue = { path: string; keyword: string };
const profileKeywords = new Set(['type', 'properties', 'required', 'additionalProperties', 'enum', 'anyOf', 'items', 'minLength', 'maxLength', 'minItems', 'maxItems', 'minimum', 'maximum', 'pattern', ...Object.values(unsupported).flat()]);
export function auditTaskWireSchema(schema: unknown): Issue[] {
  const issues: Issue[] = [];
  const walk = (value: unknown, path: string) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) { issues.push({ path, keyword: 'INVALID_SCHEMA_NODE' }); return; }
    const node = value as Record<string, unknown>;
    for (const keyword of Object.keys(node)) if (!profileKeywords.has(keyword)) issues.push({ path: path + '/' + keyword, keyword });
    for (const keyword of unsupported[String(node.type)] ?? []) if (Object.hasOwn(node, keyword)) issues.push({ path: path + '/' + keyword, keyword });
    if (node.properties && typeof node.properties === 'object' && !Array.isArray(node.properties)) for (const [name, child] of Object.entries(node.properties)) walk(child, path + '/properties/' + name.replaceAll('~', '~0').replaceAll('/', '~1'));
    for (const key of ['items', 'additionalProperties']) if (node[key] && typeof node[key] === 'object') walk(node[key], path + '/' + key);
    for (const key of ['anyOf', 'allOf', 'oneOf', 'prefixItems']) if (Array.isArray(node[key])) node[key].forEach((child, i) => walk(child, path + '/' + key + '/' + i));
  };
  walk(schema, ''); return issues;
}
/** Only the decoder's uniqueness keyword is projected out. The unchanged
 * assertClosedSchema/quotedNames server parsers still reject all duplicates.
 * Other unsupported constraints are never silently removed. */
export function projectTaskWireSchema(schema: unknown): unknown {
  const issues = auditTaskWireSchema(schema);
  if (issues.some(issue => issue.keyword !== 'uniqueItems')) throw new Error('TASK_WIRE_SCHEMA_UNSUPPORTED');
  const result = structuredClone(schema) as Record<string, unknown>;
  for (const issue of issues) {
    const parts = issue.path.slice(1).split('/').map(p => p.replaceAll('~1', '/').replaceAll('~0', '~'));
    let node: any = result;
    for (const part of parts.slice(0, -1)) node = node[part];
    delete node[parts.at(-1)!];
  }
  return result;
}
/** Safe future-error vocabulary: no raw message, arbitrary code/parameter,
 * request ID, URL, credential or free provider text is ever returned. */
export function classifyTaskProviderError(text: string) {
  const source = typeof text === 'string' && text.length <= 16384 ? text.toLowerCase() : '';
  const mentions = (word: string) => new RegExp('(^|[^a-z0-9_])' + word.toLowerCase() + '($|[^a-z0-9_])').test(source);
  return {
    referencedParameters: ['max_completion_tokens', 'max_tokens', 'response_format', 'json_schema', 'messages', 'model', 'temperature'].filter(mentions),
    referencedSchemaKeywords: [...new Set(Object.values(unsupported).flat())].filter(mentions),
    decoder: source.includes('xgrammar') ? 'xgrammar' : source.includes('outlines') ? 'outlines' : 'unknown',
    reason: /schema/.test(source) && /not supported|unsupported/.test(source) ? 'schema_unsupported' : /schema/.test(source) && /invalid|failed/.test(source) ? 'schema_invalid' : 'unclassified',
  };
}
