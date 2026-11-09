import { z } from 'zod';
import { EventEnvelope, type Command } from '../domain/contracts';
import type { FeedbackPort, Evidence } from '../ports';
const Review = z.object({
  traceId: z.string().regex(/^tr_[0-9a-f]{32}$/),
  requestId: z.string(),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
  inputText: z.string(),
  replyText: z.string(),
  qualityStatus: z.enum(['unreviewed', 'unacceptable', 'acceptable']),
  reasonNote: z.string().nullable().optional(),
  actionClipIds: z.array(z.string()).default([]),
  contentSegments: z.array(z.unknown()).default([]),
  interactionSummary: z.unknown().optional(),
});
export const ReviewPage = z.object({
  items: z.array(Review),
  nextCursor: z.string().nullable(),
  limit: z.number().int().min(1).max(100),
});
export function normalizeReviews(
  raw: unknown,
  project_id: string,
  source_id: string,
  received_at = new Date().toISOString(),
): { events: Command[]; next_cursor: string | null } {
  const page = ReviewPage.parse(raw);
  const events = page.items.map((row) => {
    const id = `${source_id}:${row.traceId}`;
    const envelope = EventEnvelope.parse({
      schema_version: '1.0',
      event_id: `${id}:${row.updatedAt}`,
      project_id,
      source: 'feedback',
      source_event_id: id,
      source_revision: row.updatedAt,
      actor: { kind: 'service', source_actor_id: source_id },
      thread_refs: [],
      occurred_at: row.updatedAt,
      received_at,
      payload_ref: id,
      correlation_ids: { trace_id: row.traceId, session_id: row.requestId },
      provenance: {
        trust: 'verified_source',
        method: 'readonly_review_api',
        observed_at: received_at,
        synthetic: false,
      },
    });
    return {
      event_id: envelope.event_id,
      event_type: row.qualityStatus === 'unacceptable' ? 'feedback_observed' : 'evidence_observed',
      actor_key: 'system',
      occurred_at: row.updatedAt,
      source_event_id: id,
      source_revision: row.updatedAt,
      envelope,
      payload: {
        case_id: `case_${row.traceId}`,
        feedback_id: id,
        trace_id: row.traceId,
        input: row.inputText,
        text: row.reasonNote || '已有点踩反馈',
        observed_behavior: row.replyText,
        run_refs: [row.traceId],
        resource_refs: row.actionClipIds,
        content_segments: row.contentSegments,
        context: row.interactionSummary ?? null,
        quality_status: row.qualityStatus,
        version_refs: {},
        created_at: row.createdAt,
      },
    } as Command;
  });
  return { events, next_cursor: page.nextCursor };
}
export class ExistingFeedbackAdapter implements FeedbackPort {
  constructor(
    private readPage: (cursor: string | null) => Promise<unknown>,
    private source_id: string,
  ) {}
  async list(cursor: string | null) {
    const page = ReviewPage.parse(await this.readPage(cursor));
    const items: Evidence[] = page.items.map((row) => ({
      evidence_id: `${this.source_id}:${row.traceId}:${row.updatedAt}`,
      source_id: this.source_id,
      observed_at: row.updatedAt,
      version: null,
      status: 'found',
      data: row,
      synthetic: false,
    }));
    return { items, next_cursor: page.nextCursor };
  }
}
