import type { AcceptanceSpec, Command, Ledger, Task, TaskState } from './contracts';
export class DomainError extends Error {
  constructor(public code: string) {
    super(code);
  }
}
export function requireRule(ok: unknown, code: string): asserts ok {
  if (!ok) throw new DomainError(code);
}
const transitions: Record<TaskState, TaskState[]> = {
  needs_clarification: ['pending_acceptance', 'deferred', 'cancelled'],
  pending_acceptance: ['in_progress', 'blocked', 'needs_clarification', 'deferred', 'cancelled'],
  in_progress: ['blocked', 'ready_for_qa', 'needs_clarification', 'deferred', 'cancelled'],
  blocked: ['in_progress', 'pending_acceptance', 'needs_clarification', 'deferred', 'cancelled'],
  ready_for_qa: ['verified', 'in_progress', 'blocked', 'deferred', 'cancelled'],
  verified: ['needs_clarification', 'pending_acceptance', 'in_progress'],
  deferred: ['needs_clarification', 'pending_acceptance', 'in_progress', 'cancelled'],
  cancelled: [],
};
export function transition(t: Task, state: TaskState) {
  requireRule(transitions[t.state].includes(state), 'illegal_transition');
  t.state = state;
  t.revision++;
}
export function versionMatch(spec: AcceptanceSpec, versions: Record<string, unknown> = {}) {
  return Object.entries(spec.version_requirements).every(
    ([k, v]) => v && v !== 'unknown' && versions[k] === v,
  );
}
export function qaReason(spec: AcceptanceSpec, revision: number, c: Command): string | null {
  const p = c.payload;
  if (!spec.qa_owner_key || c.actor_key !== spec.qa_owner_key) return 'unauthorized_verifier';
  if ((p.task_revision ?? p.issue_revision) !== revision) return 'revision_mismatch';
  if (!versionMatch(spec, p.version_refs)) return 'version_mismatch';
  if (!spec.environment || p.environment !== spec.environment) return 'environment_mismatch';
  if (
    p.scope?.validation !== spec.scope.validation ||
    !spec.case_ids.every((x) => p.case_ids?.includes(x)) ||
    p.scope?.description !== spec.scope.description
  )
    return 'scope_incomplete';
  if (!spec.required_evidence_types.every((x) => p.evidence_types?.includes(x)) || !p.evidence_refs?.length)
    return 'evidence_incomplete';
  return null;
}
export function assertAcyclic(tasks: Record<string, Task>) {
  const seen = new Set<string>(),
    active = new Set<string>();
  function visit(id: string) {
    if (active.has(id)) throw new DomainError('dependency_cycle');
    if (seen.has(id)) return;
    active.add(id);
    for (const d of tasks[id]?.dependencies || []) if (d.kind === 'task') visit(d.target_ref);
    active.delete(id);
    seen.add(id);
  }
  Object.keys(tasks).forEach(visit);
}
export function cancelObsolete(s: Ledger, t: Task) {
  for (const e of Object.values(s.outbox))
    if (
      e.task_id === t.task_id &&
      ['pending', 'blocked', 'failed_retryable'].includes(e.state) &&
      (e.expected_revision !== t.revision ||
        (['cancelled', 'deferred'].includes(t.state) && e.request.purpose !== 'command_receipt'))
    )
      e.state = 'cancelled';
  for (const sub of Object.values(s.subscriptions))
    if (sub.task_id === t.task_id && ['cancelled', 'deferred', 'verified'].includes(t.state))
      sub.active = false;
}
