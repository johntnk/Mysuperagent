import {
  Assignment,
  Effect,
  emptyLedger,
  newIssue,
  newTask,
  type Command,
  type Ledger,
} from '../src/domain/contracts';
import { reduce, drainFake } from '../src/domain/engine';
import { localPolicy, type Policy } from '../src/policy';
export type Scenario = {
  id: string;
  title: string;
  given: any;
  events: Command[];
  expected: Record<string, any>;
  invariants: string[];
};
export function scenarioSeed(scenario: Scenario) {
  const g = scenario.given,
    s = emptyLedger('project_demo'),
    policy = localPolicy('project_demo');
  policy.task_backend = 'feishu_project';
  policy.mode = g.effective_mode;
  policy.environment = policy.mode === 'pilot' ? 'test' : 'local';
  policy.targets = g.fake_allowed_targets || [];
  policy.capabilities = g.enabled_capabilities || [];
  for (const [key, binding] of Object.entries(g.fake_identity_bindings || {}) as [string, any][])
    policy.identities[key] = { id: binding.binding_ref, verified: binding.verified, synthetic: true };
  if (g.notification_policy) {
    policy.notifications.start = g.notification_policy.quiet_hours.end;
    policy.notifications.end = g.notification_policy.quiet_hours.start;
    policy.notifications.cooldown_minutes = g.notification_policy.cooldown_minutes;
  }
  for (const raw of g.issues || [])
    s.issues[raw.issue_id] = { ...newIssue(raw.issue_id, s.project_id), ...raw };
  for (const raw of g.tasks || []) {
    const t = newTask(raw.task_id, raw.issue_id, s.project_id, raw);
    s.tasks[t.task_id] = t;
    if (!s.issues[t.issue_id]) s.issues[t.issue_id] = newIssue(t.issue_id, s.project_id);
    if (!s.issues[t.issue_id].task_ids.includes(t.task_id)) s.issues[t.issue_id].task_ids.push(t.task_id);
  }
  for (const raw of g.assignments || []) {
    s.assignments[raw.assignment_id] = Assignment.parse({
      assigned_at: null,
      acknowledged_at: null,
      accepted_at: null,
      ended_at: null,
      handoff_reason: null,
      source_refs: [],
      ...raw,
    });
    if (raw.status !== 'ended' && s.tasks[raw.task_id])
      s.tasks[raw.task_id].assignment_id = raw.assignment_id;
  }
  for (const t of Object.values(s.tasks))
    if (t.primary_owner_key && !t.assignment_id) {
      const id = `assignment_${t.task_id}_${t.revision}`;
      t.assignment_id = id;
      s.assignments[id] = Assignment.parse({
        assignment_id: id,
        task_id: t.task_id,
        owner_key: t.primary_owner_key,
        scope_revision: t.revision,
        status: t.state === 'pending_acceptance' ? 'proposed' : 'accepted',
        assigned_at: null,
        acknowledged_at: null,
        accepted_at: null,
        ended_at: null,
        handoff_reason: null,
        source_refs: [],
      });
    }
  for (const issue of Object.values(s.issues))
    for (const id of issue.case_ids)
      s.cases[id] = {
        case_id: id,
        project_id: s.project_id,
        source_event_ids: [],
        feedback_ref: null,
        conversation_ref: null,
        run_refs: [],
        resource_refs: [],
        reported_expectation: null,
        observed_behavior: null,
        environment: null,
        version_refs: {},
        evidence_completeness: 'unknown',
        created_at: scenario.events[0].occurred_at,
        observations: [{ synthetic: true, data: g.evidence?.[id] || {} }],
      };
  for (const raw of g.outbox || []) {
    const t = s.tasks[raw.task_id];
    s.outbox[raw.operation_id] = Effect.parse({
      project_id: s.project_id,
      issue_id: t?.issue_id || null,
      task_id: null,
      expected_revision: t?.revision || 0,
      planned_mode: policy.mode,
      capability: 'message.send',
      target: 'fake_project_space',
      target_owner_key: t?.primary_owner_key || null,
      request_ref: 'synthetic_seed',
      request: {},
      attempt_count: 0,
      last_error: null,
      external_result_ref: null,
      requires_operation_id: null,
      next_attempt_at: null,
      created_at: scenario.events[0].occurred_at,
      ...raw,
    });
  }
  for (const r of g.fake_remote_records || []) s.fake.records[r.operation_id] = r;
  return { ledger: s, policy };
}
export function runScenario(scenario: Scenario) {
  let { ledger, policy } = scenarioSeed(scenario);
  const initial = structuredClone(ledger),
    checkpoints: Record<string, Ledger> = {};
  for (const event of scenario.events) {
    ledger = reduce(ledger, event, policy);
    // The pack explicitly supplies a deterministic planner task for the dedup scenario.
    if (
      scenario.given.planner_fixture_task_id &&
      event.event_type === 'feedback_observed' &&
      !ledger.tasks[scenario.given.planner_fixture_task_id]
    ) {
      ledger = reduce(
        ledger,
        {
          event_id: `fixture_plan_${event.event_id}`,
          event_type: 'analysis_completed',
          actor_key: 'system',
          occurred_at: event.occurred_at,
          payload: {
            decision_type: 'assign_task',
            proposed_task_changes: [
              {
                task_id: scenario.given.planner_fixture_task_id,
                kind: 'diagnosis',
                primary_owner_key: 'retrieval_owner',
                qa_owner_key: 'qa_owner',
                deliverable: '整理原反馈与修订证据',
              },
            ],
          },
        },
        policy,
      );
    }
    // Unknown operations remain unknown until an authoritative reconciliation event.
    const dispatchAllowed =
      !scenario.given.outbox?.some((e: any) => e.state === 'pending') ||
      event.event_type === 'outbox_dispatch_requested';
    if (dispatchAllowed) ledger = drainFake(ledger, policy);
    checkpoints[event.event_id] = structuredClone(ledger);
  }
  return { ledger, policy, initial, checkpoints };
}
export function projection(s: Ledger, initial: Ledger, policy: Policy) {
  const tasks = Object.values(s.tasks),
    effects = Object.values(s.outbox),
    facts = Object.values(s.issues).flatMap((i) => i.confirmed_facts),
    msgs = s.fake.messages;
  return {
    tasks,
    issues: Object.values(s.issues),
    assignments: Object.values(s.assignments),
    outbox: effects,
    dependencies: tasks.flatMap((t) => t.dependencies),
    relations: s.relations,
    real_network_calls: 0,
    real_model_calls: 0,
    real_identity_resolution_calls: 0,
    internal_business_mutation_count: 0,
    training_start_count: 0,
    deployment_start_count: 0,
    debug_resolve_calls: 0,
    product_replay_calls: 0,
    configuration_mutations: 0,
    new_issue_count: Object.keys(s.issues).length - Object.keys(initial.issues).length,
    new_task_count: tasks.length - Object.keys(initial.tasks).length,
    case_count: Object.keys(s.cases).length,
    issue_count: Object.keys(s.issues).length,
    effective_source_revision_count: new Set(
      Object.values(s.events)
        .filter((e) => e.event_type === 'feedback_observed')
        .map((e) => e.source_revision || ''),
    ).size,
    duplicate_ignored_count: s.audit.filter((a) => a.type === 'duplicate_ignored').length,
    fake_work_item_creates: s.fake.creates,
    fake_messages_sent: msgs.length,
    max_handoff_messages: msgs.filter((m) => (m.body as any).purpose === 'handoff').length,
    max_followup_messages: msgs.filter((m) => (m.body as any).purpose === 'followup').length,
    max_resume_handoff_messages: msgs.filter((m) => (m.body as any).purpose === 'resume').length,
    max_messages_to_coordinator: msgs.filter((m) => m.recipient === 'coordinator').length,
    message_recipients: [...new Set(msgs.map((m) => m.recipient))],
    automatic_merge_count: s.relations.filter((r) => r.status === 'merged').length,
    committed_due_dates: tasks.map((t) => t.schedule.committed_due_at).filter(Boolean),
    qa_pass_records: s.qa_reports.filter((r) => r.accepted && r.payload.result === 'pass').length,
    accepted_qa_reports: s.qa_reports.filter((r) => r.accepted).length,
    accepted_complete_qa_reports: s.qa_reports.filter(
      (r) => r.accepted && r.payload.scope?.validation === 'all',
    ).length,
    rejected_qa_reasons: s.qa_reports.filter((r) => !r.accepted).map((r) => r.reason),
    verified_count: tasks.filter((t) => t.state === 'verified').length,
    unconditional_model_assignments: tasks.filter(
      (t) => t.primary_owner_key === 'model_owner' && !t.evidence_refs.length,
    ).length,
    stale_analysis_applied: s.audit.some((a) => a.type === 'stale_applied'),
    messages_to_old_owner: msgs.filter(
      (m) => m.recipient === Object.values(initial.tasks)[0]?.primary_owner_key,
    ).length,
    remote_matching_record_count: Object.keys(s.fake.records).length,
    attention_items: s.attention.length,
    proposal_count: s.proposals.length,
    dispatched_assignment_count: tasks.filter((t) => t.external_record).length,
    blocked_effect_count: effects.filter((e) => e.state === 'blocked').length,
    blocked_reasons: effects.filter((e) => e.state === 'blocked').map((e) => e.last_error),
    blocked_reason: effects.find((e) => e.state === 'blocked')?.last_error,
    external_record_platform: tasks.find((t) => t.external_record)?.external_record?.platform,
    assignment_status: Object.values(s.assignments)[0]?.status,
    effective_mode: policy.mode,
    business_capability_claim: Object.values(s.issues).some((i) => i.lifecycle === 'verified')
      ? 'verified'
      : 'not_verified',
    confirmed_facts: facts,
    next_condition_not_before: tasks[0]?.next_condition?.not_before,
  };
}
