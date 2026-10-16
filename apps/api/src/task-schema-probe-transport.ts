import { createBenchmarkTransport } from './benchmark-transport.ts';
import { classifyTaskProviderError } from './task-provider-schema.ts';

export type SchemaHttpDiagnostics = ReturnType<typeof classifyTaskProviderError> & { httpStatus: number | null; errorBody: 'not_read' | 'bounded' | 'too_large' | 'read_failed' };
export const emptySchemaDiagnostics = (): SchemaHttpDiagnostics => ({ ...classifyTaskProviderError(''), httpStatus: null, errorBody: 'not_read' });
/** Use the existing bounded, no-retry completion transport. Only non-2xx
 * response bodies are replaced by fixed-vocabulary diagnostics before that
 * transport sees them. No raw provider bytes reach a receipt/cache/output. */
export function createSchemaProbeTransport(credentials: unknown, fetcher: typeof fetch = fetch) {
  const diagnostics = emptySchemaDiagnostics();
  const wrapped: typeof fetch = async (url, options) => {
    const response = await fetcher(url, options); diagnostics.httpStatus = response.status;
    if (response.ok) return response;
    const reader = response.body?.getReader(); let source = '';
    try {
      if (reader) {
        const parts: Uint8Array[] = []; let bytes = 0;
        while (true) { const part = await reader.read(); if (part.done) break; bytes += part.value.byteLength;
          if (bytes > 16384) { diagnostics.errorBody = 'too_large'; break; } parts.push(part.value); }
        if (diagnostics.errorBody !== 'too_large') { source = Buffer.concat(parts).toString('utf8'); diagnostics.errorBody = 'bounded'; }
      }
    } catch { diagnostics.errorBody = 'read_failed'; }
    finally { try { await reader?.cancel(); } catch { /* Preserve status; no retry. */ } }
    Object.assign(diagnostics, classifyTaskProviderError(source));
    return new Response(JSON.stringify(diagnostics), { status: response.status });
  };
  return { transport: createBenchmarkTransport('cloud-oss', credentials, wrapped, 'empty-tools'), diagnostics };
}
