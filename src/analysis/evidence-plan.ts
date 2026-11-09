import { z } from 'zod';
import { createHash } from 'node:crypto';
import type { ProjectConfig } from '../config';
import { requestPath, type ReadRequest } from '../connector/protocol';

// The model selects a read capability and arguments, never a host, URL, credential or command.
export const EvidenceQuery = z.strictObject({
  kind: z.enum(['trace', 'animation_catalog', 'animation_operations', 'feedback_reviews']),
  query: z.string().max(200).nullable(),
  clip_id: z.string().max(120).nullable(),
  catalog_id: z.number().int().positive().nullable(),
  trace_id: z
    .string()
    .regex(/^tr_[0-9a-f]{32}$/)
    .nullable(),
  from: z.string().datetime({ offset: true }).nullable(),
  to: z.string().datetime({ offset: true }).nullable(),
});
export type EvidenceQuery = z.infer<typeof EvidenceQuery>;
export function planEvidenceReads(
  queries: EvidenceQuery[],
  config: ProjectConfig,
  run: { run_id: string; tool_reads: number },
  existing: { operation_id: string }[],
  now = Date.now(),
) {
  const requests: ReadRequest[] = [],
    unavailable: string[] = [];
  for (const raw of queries.slice(0, 4)) {
    const q = EvidenceQuery.parse(raw),
      source =
        q.kind === 'trace'
          ? config.evidenceConnector.sources.runtimeLogs.sourceId
          : q.kind === 'feedback_reviews'
            ? config.evidenceConnector.sources.feedback.sourceId
            : config.evidenceConnector.sources.animationLibrary.sourceId;
    if (
      config.mode === 'mock' ||
      !config.capabilities.readEvidence ||
      !config.evidenceConnector.enabled ||
      !source ||
      !config.allowlists.evidenceSourceIds.includes(source as never)
    ) {
      unavailable.push(`${q.kind}: source_not_enabled`);
      continue;
    }
    if (
      q.kind === 'feedback_reviews' &&
      (!q.from ||
        !q.to ||
        Date.parse(q.to) <= Date.parse(q.from) ||
        Date.parse(q.to) - Date.parse(q.from) > 86400000)
    ) {
      unavailable.push('feedback_reviews: explicit_range_up_to_24h_required');
      continue;
    }
    const capability =
      q.kind === 'trace'
        ? 'trace.get'
        : q.kind === 'animation_catalog'
          ? 'animation.catalog'
          : q.kind === 'feedback_reviews'
            ? 'feedback.list'
            : 'animation.operations';
    const params =
      q.kind === 'trace'
        ? { trace_id: q.trace_id }
        : q.kind === 'animation_operations'
          ? { id: q.catalog_id }
          : q.kind === 'feedback_reviews'
            ? { from: q.from!, to: q.to!, limit: 50, qualityStatus: 'unacceptable' }
            : q.clip_id
              ? { clip_id: q.clip_id }
              : { q: q.query || '' };
    let path: string;
    try {
      path = requestPath(capability, params);
    } catch {
      unavailable.push(`${q.kind}: invalid_arguments`);
      continue;
    }
    // An unfiltered inventory is not a useful model read and can expose unrelated records.
    if (q.kind === 'animation_catalog' && !q.query && !q.clip_id) {
      unavailable.push('animation_catalog: query_required');
      continue;
    }
    const operation_id = `read:${createHash('sha256')
      .update(JSON.stringify([run.run_id, source, path]))
      .digest('hex')
      .slice(0, 48)}`;
    if (
      existing.some((x) => x.operation_id === operation_id) ||
      requests.some((x) => x.operation_id === operation_id)
    )
      continue;
    if (run.tool_reads + requests.length >= config.budgets.toolReadsPerRun) {
      unavailable.push(`${q.kind}: read_budget_exceeded`);
      continue;
    }
    requests.push({
      operation_id,
      run_id: run.run_id,
      project_id: config.projectKey,
      source_id: source,
      capability,
      params,
      expires_at: new Date(now + 180000).toISOString(),
    });
  }
  return { requests, unavailable };
}

export function evidenceForModel(reads: any[], characterBudget: number) {
  const perRead = Math.max(600, Math.floor(characterBudget / Math.max(1, reads.length)));
  return reads.map((r) => {
    const result = r.result?.result,
      raw = JSON.stringify(result?.data ?? null),
      truncated = raw.length > perRead;
    return {
      evidence_id: r.operation_id,
      source_id: r.source_id,
      capability: r.capability,
      request: r.params,
      observed_at: r.result?.observed_at || null,
      status: result?.status || 'pending',
      version: result?.version ?? null,
      truncated,
      data: truncated
        ? {
            json_excerpt: raw.slice(0, perRead),
            warning: 'Partial evidence; absence in this excerpt is not proof of absence.',
          }
        : (result?.data ?? null),
      error: result?.error || null,
    };
  });
}
