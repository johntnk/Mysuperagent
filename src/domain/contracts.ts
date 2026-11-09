import { z } from 'zod';
import type { SourceItem, Reminder, ObservedProgress } from './coordination-schema';

export const Mode = z.enum(['mock', 'observe', 'pilot', 'active']);
export type Mode = z.infer<typeof Mode>;
export const TaskState = z.enum([
  'needs_clarification',
  'pending_acceptance',
  'in_progress',
  'blocked',
  'ready_for_qa',
  'verified',
  'deferred',
  'cancelled',
]);
export type TaskState = z.infer<typeof TaskState>;
export const TaskKind = z.enum(['diagnosis', 'implementation', 'verification', 'decision']);
export const Id = z.string().min(1).max(200);
const Refs = z.array(Id).default([]);
const nullableString = z.string().nullable();
export const AcceptanceSpec = z.object({
  expected_behavior: z.string(),
  case_ids: Refs,
  environment: nullableString,
  version_requirements: z.record(z.string(), nullableString),
  scope: z.object({ description: z.string(), validation: z.enum(['all', 'sample']) }),
  qa_owner_key: nullableString,
  required_evidence_types: Refs,
});
export type AcceptanceSpec = z.infer<typeof AcceptanceSpec>;
export const NextCondition = z.object({
  condition_type: z.enum(['await_acceptance', 'await_dependency', 'await_qa', 'await_decision', 'check_due']),
  target_ref: Id,
  expected_revision: z.number().int(),
  not_before: nullableString,
  expires_at: nullableString.default(null),
  recipient_owner_key: nullableString,
  action_on_ready: z.string(),
});
export const Dependency = z.object({
  dependency_id: Id,
  kind: z.enum(['task', 'job', 'artifact', 'deployment', 'decision']),
  target_ref: Id,
  required_condition: z.string(),
  expected_version: nullableString.default(null),
  provider_owner_key: nullableString.default(null),
  status: z.enum(['unknown', 'waiting', 'satisfied', 'invalidated']),
  observed_at: nullableString.default(null),
  source_ref: nullableString.default(null),
});
export type Dependency = z.infer<typeof Dependency>;
export const Schedule = z.object({
  target_at: nullableString.default(null),
  proposed_due_at: nullableString.default(null),
  committed_due_at: nullableString.default(null),
  estimate_basis: nullableString.default(null),
  source_ref: nullableString.default(null),
  updated_at: nullableString.default(null),
});
export const Task = z.object({
  task_id: Id,
  issue_id: Id,
  project_id: Id,
  kind: TaskKind,
  title: z.string(),
  objective: z.string(),
  deliverable: z.string(),
  state: TaskState,
  primary_owner_key: nullableString,
  collaborator_keys: Refs,
  qa_owner_key: nullableString,
  assignment_id: nullableString,
  dependencies: z.array(Dependency),
  acceptance_spec: AcceptanceSpec,
  schedule: Schedule,
  evidence_refs: Refs,
  decision_refs: Refs,
  external_record: z
    .object({
      platform: z.string(),
      record_id: z.string(),
      space_id: z.string().optional(),
      revision: z.string().optional(),
      synthetic: z.boolean().optional(),
    })
    .nullable(),
  revision: z.number().int().positive(),
  next_condition: NextCondition.nullable(),
  delivery: z.record(z.string(), z.unknown()).nullable().default(null),
  last_human_at: nullableString.default(null),
  source_item_ids: Refs,
  external_refs: Refs,
  observed_progress: z
    .array(
      z.object({
        kind: z.string(),
        summary: z.string(),
        scope: z.string(),
        source_item_id: z.string(),
        at: z.string(),
      }),
    )
    .default([]),
});
export type Task = z.infer<typeof Task>;
export const Assignment = z.object({
  assignment_id: Id,
  task_id: Id,
  owner_key: Id,
  scope_revision: z.number().int(),
  status: z.enum(['proposed', 'acknowledged', 'accepted', 'ended']),
  assigned_at: nullableString,
  acknowledged_at: nullableString,
  accepted_at: nullableString,
  ended_at: nullableString,
  handoff_reason: nullableString,
  source_refs: Refs,
});
export type Assignment = z.infer<typeof Assignment>;
export const Issue = z.object({
  issue_id: Id,
  project_id: Id,
  title: z.string(),
  problem_statement: z.string(),
  expected_behavior: z.string(),
  case_ids: Refs,
  task_ids: Refs,
  confirmed_facts: Refs,
  hypotheses: Refs,
  decisions: Refs,
  lifecycle: z.enum(['open', 'verified', 'deferred', 'cancelled']),
  revision: z.number().int().positive(),
  acceptance_spec: AcceptanceSpec,
  next_condition: NextCondition.nullable(),
});
export type Issue = z.infer<typeof Issue>;
export const Case = z.object({
  case_id: Id,
  project_id: Id,
  source_event_ids: Refs,
  feedback_ref: nullableString,
  conversation_ref: nullableString,
  run_refs: Refs,
  resource_refs: Refs,
  reported_expectation: nullableString,
  observed_behavior: nullableString,
  environment: nullableString,
  version_refs: z.record(z.string(), nullableString),
  evidence_completeness: z.enum(['partial', 'complete', 'unknown']),
  created_at: z.string(),
  observations: z.array(z.record(z.string(), z.unknown())),
});
export type Case = z.infer<typeof Case>;
export const EventEnvelope = z.object({
  schema_version: z.literal('1.0'),
  event_id: Id,
  project_id: Id,
  source: z.enum([
    'feishu_message',
    'feishu_card',
    'feishu_work_item',
    'feedback',
    'resource_status',
    'schedule',
    'manual',
  ]),
  source_event_id: Id,
  source_revision: nullableString,
  actor: z.object({
    kind: z.enum(['human', 'bot', 'service']),
    source_actor_id: Id,
    person_key: z.string().optional(),
  }),
  thread_refs: z.array(z.object({ source: z.string(), thread_id: z.string() })),
  occurred_at: z.string().datetime({ offset: true }),
  received_at: z.string().datetime({ offset: true }),
  payload_ref: Id,
  correlation_ids: z.record(z.string(), z.union([z.string(), z.array(z.string())])).default({}),
  provenance: z.object({
    trust: z.enum(['verified_source', 'untrusted_context', 'synthetic']),
    method: z.string(),
    observed_at: z.string(),
    synthetic: z.boolean(),
  }),
});
export type EventEnvelope = z.infer<typeof EventEnvelope>;
// Conceptual commands are accepted only after a trusted source adapter has authenticated them.
export const Command = z.object({
  event_id: Id,
  event_type: z.string().min(1).max(80),
  occurred_at: z.string().datetime({ offset: true }),
  actor_key: Id,
  source_event_id: z.string().optional(),
  source_revision: z.string().optional(),
  payload: z.record(z.string(), z.any()),
  envelope: EventEnvelope.optional(),
});
export type Command = z.infer<typeof Command>;
export const Effect = z.object({
  operation_id: Id,
  project_id: Id,
  issue_id: nullableString,
  task_id: nullableString,
  expected_revision: z.number().int(),
  planned_mode: Mode,
  capability: z.string(),
  target: z.string(),
  target_owner_key: nullableString,
  request_ref: Id,
  request: z.record(z.string(), z.any()),
  state: z.enum(['pending', 'sending', 'succeeded', 'failed_retryable', 'unknown', 'blocked', 'cancelled']),
  attempt_count: z.number().int(),
  last_error: nullableString,
  external_result_ref: nullableString,
  requires_operation_id: nullableString,
  next_attempt_at: nullableString,
  created_at: z.string(),
  last_attempt_at: z.string().optional(),
  /** First time a send was attempted; bounds the window in which an idempotent resend is safe. */
  first_attempt_at: z.string().optional(),
});
export type Effect = z.infer<typeof Effect>;
export interface Audit {
  event_id: string;
  type: string;
  reason?: string;
  target?: string;
  at: string;
  details?: unknown;
}
export interface Ledger {
  source_items: Record<string, SourceItem>;
  reminders: Record<string, Reminder>;
  schema_version: 1;
  project_id: string;
  issues: Record<string, Issue>;
  tasks: Record<string, Task>;
  assignments: Record<string, Assignment>;
  cases: Record<string, Case>;
  events: Record<string, Command>;
  outbox: Record<string, Effect>;
  audit: Audit[];
  proposals: unknown[];
  relations: { from: string; to: string; status: string }[];
  qa_reports: { accepted: boolean; reason: string | null; payload: Record<string, any>; actor: string }[];
  attention: string[];
  subscriptions: Record<
    string,
    { task_id?: string; issue_id: string; kind: string; source_ref: string; active: boolean }
  >;
  runs: Record<
    string,
    {
      run_id: string;
      event_id: string;
      issue_id: string | null;
      expected_revision: number;
      task_revisions?: Record<string, number>;
      source_revisions?: Record<string, string>;
      state: string;
      started_at: string;
      start_attempts?: number;
      result?: unknown;
      model_calls: number;
      tool_reads: number;
      /** Re-analysis attempt after a stale result (1, 2, ...); the original run has none. */
      attempt?: number;
      retry_of?: string;
    }
  >;
  connector: Record<
    string,
    {
      operation_id: string;
      run_id: string;
      source_id: string;
      capability: string;
      params: Record<string, unknown>;
      state: string;
      result?: unknown;
      notification_pending: boolean;
      processing_pending?: boolean;
      leased_until?: string;
      expires_at: string;
    }
  >;
  fake: {
    records: Record<string, { record_ref: string; operation_id: string; task_id: string }>;
    messages: { operation_id: string; recipient: string; body: unknown }[];
    creates: number;
    updates: number;
  };
}
export function emptyLedger(project_id: string): Ledger {
  return {
    schema_version: 1,
    project_id,
    source_items: {},
    reminders: {},
    issues: {},
    tasks: {},
    assignments: {},
    cases: {},
    events: {},
    outbox: {},
    audit: [],
    proposals: [],
    relations: [],
    qa_reports: [],
    attention: [],
    subscriptions: {},
    runs: {},
    connector: {},
    fake: { records: {}, messages: [], creates: 0, updates: 0 },
  };
}
export const unknownAcceptance = (qa: string | null = null): AcceptanceSpec => ({
  expected_behavior: '待明确验收目标',
  case_ids: [],
  environment: null,
  version_requirements: {},
  scope: { description: '待明确范围', validation: 'all' },
  qa_owner_key: qa,
  required_evidence_types: ['human_qa'],
});
export function newIssue(id: string, project: string): Issue {
  return Issue.parse({
    issue_id: id,
    project_id: project,
    title: '待诊断反馈',
    problem_statement: '待整理原始证据',
    expected_behavior: '待明确',
    case_ids: [],
    task_ids: [],
    confirmed_facts: [],
    hypotheses: [],
    decisions: [],
    lifecycle: 'open',
    revision: 1,
    acceptance_spec: unknownAcceptance(),
    next_condition: null,
  });
}
export function newTask(id: string, issue: string, project: string, patch: Partial<Task> = {}): Task {
  return Task.parse({
    task_id: id,
    issue_id: issue,
    project_id: project,
    kind: 'diagnosis',
    title: '诊断反馈',
    objective: '整理证据与下一步',
    deliverable: '提交定位材料及缺项',
    state: 'needs_clarification',
    primary_owner_key: null,
    collaborator_keys: [],
    qa_owner_key: null,
    assignment_id: null,
    dependencies: [],
    acceptance_spec: unknownAcceptance(),
    schedule: {},
    evidence_refs: [],
    decision_refs: [],
    external_record: null,
    revision: 1,
    next_condition: null,
    ...patch,
  });
}
