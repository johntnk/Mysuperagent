import type { Effect, EventEnvelope, Task } from './domain/contracts';
export interface Evidence {
  evidence_id: string;
  source_id: string;
  observed_at: string;
  version: string | null;
  status: 'found' | 'absent' | 'unavailable';
  data: unknown;
  synthetic: boolean;
}
export interface FeedbackPort {
  list(cursor: string | null): Promise<{ items: Evidence[]; next_cursor: string | null }>;
}
export interface EvidencePort {
  read(operation: string, params: Record<string, unknown>): Promise<Evidence>;
}
export interface AnimationCatalogPort extends EvidencePort {}
export interface ResourceStatusPort extends EvidencePort {}
export type Reconciliation =
  | { status: 'found'; record_ref: string }
  | { status: 'absent'; authoritative: true }
  /** The write can be repeated with the same idempotency key without risking a duplicate. */
  | { status: 'retry_safe' }
  | { status: 'unknown'; reason: string };
export interface EffectPort {
  execute(effect: Effect, task?: Task): Promise<{ record_ref: string }>;
  reconcile(effect: Effect): Promise<Reconciliation>;
}
export interface WorkItemPort extends EffectPort {
  get(id: string): Promise<unknown>;
  search(operation_id: string): Promise<Reconciliation>;
}
export interface MessagePort extends EffectPort {}
export interface SourceAdapter {
  normalize(raw: unknown): { envelope: EventEnvelope; payload: unknown } | null;
}
