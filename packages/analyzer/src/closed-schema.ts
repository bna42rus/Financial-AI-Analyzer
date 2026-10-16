// The deliberately small JSON Schema subset used by our versioned task wire
// schemas. No coercion, defaults, removal of fields or provider text execution.
type Schema = { anyOf?: Schema[]; type?: string; enum?: unknown[]; properties?: Record<string, Schema>; required?: string[];
  additionalProperties?: boolean; items?: Schema; minItems?: number; maxItems?: number; uniqueItems?: boolean;
  minLength?: number; maxLength?: number; pattern?: string; minimum?: number; maximum?: number };
export function assertClosedSchema(value: unknown, rawSchema: unknown): void {
  const visit = (v: unknown, s: Schema, depth: number): boolean => {
    if (depth > 12) return false;
    if (s.anyOf) return s.anyOf.some(branch => visit(v, branch, depth + 1));
    if (s.enum && !s.enum.includes(v)) return false;
    if (s.type === 'null') return v === null;
    if (s.type === 'boolean') return typeof v === 'boolean';
    if (s.type === 'integer') return typeof v === 'number' && Number.isSafeInteger(v) && v >= (s.minimum ?? -Infinity) && v <= (s.maximum ?? Infinity);
    if (s.type === 'string') return typeof v === 'string' && v.length >= (s.minLength ?? 0) && v.length <= (s.maxLength ?? Infinity) && (!s.pattern || new RegExp(s.pattern).test(v));
    if (s.type === 'array') return Array.isArray(v) && v.length >= (s.minItems ?? 0) && v.length <= (s.maxItems ?? Infinity) &&
      (!s.uniqueItems || new Set(v.map(x => JSON.stringify(x))).size === v.length) && v.every(x => visit(x, s.items!, depth + 1));
    if (s.type === 'object') {
      if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
      const r = v as Record<string, unknown>, props = s.properties!;
      return (s.required ?? []).every(k => Object.hasOwn(r, k)) && Object.keys(r).every(k => Object.hasOwn(props, k) && visit(r[k], props[k]!, depth + 1));
    }
    return false; // Unknown schema features/types never weaken the boundary.
  };
  if (!visit(value, rawSchema as Schema, 0)) throw new TypeError('TASK_WIRE_INVALID');
}
