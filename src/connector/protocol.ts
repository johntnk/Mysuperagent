import { z } from 'zod';
export const ReadRequest = z.strictObject({
  operation_id: z.string().min(1).max(160),
  run_id: z.string().min(1).max(160),
  project_id: z.string().min(1),
  source_id: z.string().min(1),
  capability: z.enum(['feedback.list', 'trace.get', 'animation.catalog', 'animation.operations']),
  params: z.record(z.string(), z.unknown()),
  expires_at: z.string().datetime({ offset: true }),
});
export type ReadRequest = z.infer<typeof ReadRequest>;
const list = z.strictObject({
  cursor: z.string().max(500).optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  limit: z.number().int().min(1).max(100).default(50),
  qualityStatus: z.string().max(40).optional(),
});
const catalog = z.strictObject({
  q: z.string().max(200).optional(),
  clip_id: z.string().max(120).optional(),
  source_sheet: z.string().max(100).optional(),
  status: z.enum(['all', 'enabled', 'disabled']).default('all'),
  clip_filter: z.enum(['all', 'with', 'without']).default('all'),
  offset: z.number().int().min(0).max(100000).default(0),
  limit: z.literal(60).default(60),
});
/** Example read-only contract for internal evidence sources; adapt the paths to your own systems. */
export function requestPath(capability: ReadRequest['capability'], input: unknown) {
  if (capability === 'trace.get') {
    const p = z.strictObject({ trace_id: z.string().regex(/^tr_[0-9a-f]{32}$/) }).parse(input);
    return `/api/traces/${p.trace_id}`;
  }
  if (capability === 'animation.operations') {
    const p = z.strictObject({ id: z.number().int().positive() }).parse(input);
    return `/api/catalog/items/${p.id}/operations`;
  }
  let params: Record<string, unknown>;
  if (capability === 'feedback.list') params = list.parse(input);
  else {
    const p = catalog.parse(input);
    params = {
      q: p.clip_id || p.q || '',
      mode: p.clip_id ? 'clip' : 'all',
      clip_id: p.clip_filter,
      source_scope: 'all',
      source_sheet: p.source_sheet,
      status: p.status,
      offset: p.offset,
      limit: p.limit,
    };
  }
  const query = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) query.set(k, String(v));
  return (capability === 'feedback.list' ? '/api/feedback/reviews' : '/api/catalog/items') + '?' + query;
}
export interface SourceBinding {
  source_id: string;
  base_url: string;
  capabilities: ReadRequest['capability'][];
  token?: string;
  max_bytes: number;
}
export async function readSource(
  raw: unknown,
  bindings: SourceBinding[],
  transport: typeof fetch = fetch,
  now = Date.now(),
) {
  const r = ReadRequest.parse(raw);
  if (Date.parse(r.expires_at) < now) throw new Error('read_request_expired');
  const binding = bindings.find((x) => x.source_id === r.source_id && x.capabilities.includes(r.capability));
  if (!binding) throw new Error('source_not_allowlisted');
  const base = new URL(binding.base_url);
  if (
    !['http:', 'https:'].includes(base.protocol) ||
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    base.pathname !== '/'
  )
    throw new Error('invalid_fixed_source_base');
  const path = requestPath(r.capability, r.params),
    url = new URL(path, base);
  if (url.origin !== base.origin) throw new Error('source_escape');
  const response = await transport(url, {
    method: 'GET',
    redirect: 'error',
    headers: binding.token ? { Authorization: `Bearer ${binding.token}` } : {},
    signal: AbortSignal.timeout(15000),
  });
  if (response.status === 404) return { status: 'absent', data: null, version: null };
  if (!response.ok) throw new Error(`SOURCE_HTTP_${response.status}`);
  if (Number(response.headers.get('content-length') || 0) > binding.max_bytes)
    throw new Error('evidence_too_large');
  const reader = response.body?.getReader();
  if (!reader) throw new Error('source_empty_body');
  let size = 0;
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > binding.max_bytes) {
      await reader.cancel();
      throw new Error('evidence_too_large');
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.length;
  }
  return { status: 'found', data: JSON.parse(new TextDecoder().decode(all)), version: null };
}
export function resourceKey(
  namespace: string,
  row: { id: string | number; source_sheet?: string; action_id?: string; clip_id?: string },
) {
  return {
    resource_key: JSON.stringify([namespace, String(row.id)]),
    catalog_id: String(row.id),
    source_sheet: row.source_sheet || null,
    action_id: row.action_id || null,
    clip_id: row.clip_id || null,
  };
}
export function candidateKey(run: string, branch: string, part: number, rank: number) {
  return JSON.stringify([run, branch, part, rank]);
}
