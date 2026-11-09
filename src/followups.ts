import type { Ledger, Task, Command } from './domain/contracts';
import { inWorkWindow, type Policy } from './policy';
export function addBusinessHours(at: string, hours: number, p: Policy) {
  let cursor = Date.parse(at),
    minutes = 0;
  const limit = cursor + 30 * 86400000;
  while (minutes < hours * 60 && cursor < limit) {
    cursor += 60000;
    if (inWorkWindow(new Date(cursor).toISOString(), p)) minutes++;
  }
  if (minutes < hours * 60) throw new Error('NO_BUSINESS_WINDOW');
  return new Date(cursor).toISOString();
}
export function setFollowup(s: Ledger, t: Task, c: Command, p: Policy) {
  if (['deferred', 'cancelled', 'verified', 'needs_clarification'].includes(t.state)) {
    t.next_condition = null;
    return;
  }
  let type: 'await_acceptance' | 'await_dependency' | 'await_qa' | 'check_due',
    recipient: string | null,
    notBefore: string;
  if (t.state === 'pending_acceptance') {
    type = 'await_acceptance';
    recipient = t.primary_owner_key;
    notBefore = addBusinessHours(c.occurred_at, 4, p);
  } else if (t.state === 'blocked') {
    type = 'await_dependency';
    recipient = t.dependencies.find((d) => d.status !== 'satisfied')?.provider_owner_key || null;
    notBefore = addBusinessHours(c.occurred_at, 8, p);
  } else if (t.state === 'ready_for_qa') {
    type = 'await_qa';
    recipient = t.qa_owner_key;
    notBefore = addBusinessHours(c.occurred_at, 8, p);
  } else if (t.schedule.committed_due_at) {
    type = 'check_due';
    recipient = t.primary_owner_key;
    notBefore = t.schedule.committed_due_at;
  } else {
    t.next_condition = null;
    return;
  }
  t.next_condition = {
    condition_type: type,
    target_ref: t.task_id,
    expected_revision: t.revision,
    not_before: notBefore,
    expires_at: null,
    recipient_owner_key: recipient,
    action_on_ready: 'remind',
  };
  s.subscriptions[`task:${t.task_id}`] = {
    task_id: t.task_id,
    issue_id: t.issue_id,
    kind: type,
    source_ref: t.external_record?.record_id || t.task_id,
    active: true,
  };
}
