import {
  AcceptanceSpec,
  Assignment,
  Command,
  Dependency,
  type Effect,
  type Ledger,
  type Task,
  TaskKind,
  TaskState,
  newIssue,
  newTask,
  unknownAcceptance,
} from './contracts';
import {
  cancelObsolete,
  DomainError,
  qaReason,
  requireRule,
  transition,
  versionMatch,
  assertAcyclic,
} from './rules';
import { effectBlock, inWorkWindow, type Policy } from '../policy';
import { setFollowup } from '../followups';
import { applyCoordination } from './coordination';
import { observeSource, ensureCoordinationState, cancelInvalidReminders } from './source-items';
import { acceptanceGaps, cardText, deliverCard, handoffCard, qaCard, specCard, type CardSpec } from './cards';

/** Plans an interactive card (with a plain-text fallback) for one person on a task. */
function planCard(
  s: Ledger,
  p: Policy,
  c: Command,
  t: Task,
  card: CardSpec,
  recipient: string | null | undefined,
  operation_id: string,
  purpose: string,
) {
  if (!recipient) return;
  planEffect(s, p, c, {
    operation_id,
    task_id: t.task_id,
    capability: 'message.send',
    target_owner_key: recipient,
    request: { purpose, card, text: cardText(card, p.command_prefix), task_id: t.task_id },
  });
}
/** Once the owner has accepted and nothing blocks the work, give them the delivery form. */
function offerDelivery(s: Ledger, p: Policy, c: Command, t: Task, intro?: string, round = '') {
  const a = assignment(s, t);
  if (t.state !== 'in_progress' || a?.status !== 'accepted') return;
  planCard(
    s,
    p,
    c,
    t,
    deliverCard(t, a.scope_revision, intro),
    t.primary_owner_key,
    `deliver-card:${t.task_id}:${a.scope_revision}${round ? `:${round}` : ''}`,
    'delivery_form',
  );
}
/** Missing acceptance criteria are a decision for the verifier (or a coordinator), not the implementer. */
function requestSpec(s: Ledger, p: Policy, c: Command, t: Task) {
  const gaps = acceptanceGaps(t);
  if (!gaps.length) return;
  planCard(
    s,
    p,
    c,
    t,
    specCard(t, `交付前需要确定验收标准，还缺：${gaps.join('、')}。`),
    t.qa_owner_key ?? p.decision_owners[0],
    `spec-card:${t.task_id}:${t.revision}`,
    'acceptance_request',
  );
}
/** `{'*': '1.4.2'}` (a version typed without a component) maps onto the single required component. */
function resolveVersions(refs: Record<string, unknown> | undefined, spec: AcceptanceSpec) {
  if (!refs) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(refs))
    if (v !== undefined && v !== null && v !== '') out[k] = String(v);
  const required = Object.keys(spec.version_requirements);
  if (out['*'] !== undefined) {
    if (required.length === 1 && out[required[0]] === undefined) out[required[0]] = out['*'];
    delete out['*'];
  }
  return out;
}
const defined = (o: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== ''));

function note(s: Ledger, c: Command, type: string, reason?: string, target?: string) {
  s.audit.push({ event_id: c.event_id, type, reason, target, at: c.occurred_at });
}
function assignment(s: Ledger, t: Task) {
  return t.assignment_id
    ? s.assignments[t.assignment_id]
    : Object.values(s.assignments).find((a) => a.task_id === t.task_id && a.status !== 'ended');
}
function proposeAssignment(s: Ledger, t: Task, c: Command) {
  if (!t.primary_owner_key) return;
  const id = `assignment_${t.task_id}_${t.revision}`;
  t.assignment_id = id;
  s.assignments[id] = Assignment.parse({
    assignment_id: id,
    task_id: t.task_id,
    owner_key: t.primary_owner_key,
    scope_revision: t.revision,
    status: 'proposed',
    assigned_at: null,
    acknowledged_at: null,
    accepted_at: null,
    ended_at: null,
    handoff_reason: null,
    source_refs: [c.event_id],
  });
}
export function planEffect(
  s: Ledger,
  p: Policy,
  c: Command,
  input: Partial<Effect> & { operation_id: string; capability: string },
): Effect {
  if (s.outbox[input.operation_id]) return s.outbox[input.operation_id];
  const t = input.task_id ? s.tasks[input.task_id] : undefined;
  const e: Effect = {
    project_id: s.project_id,
    issue_id: t?.issue_id || null,
    task_id: t?.task_id || null,
    expected_revision: t?.revision || 0,
    planned_mode: p.mode,
    target: input.capability.startsWith('message') ? 'fake_project_chat' : 'fake_project_space',
    target_owner_key: t?.primary_owner_key || null,
    request_ref: c.event_id,
    request: {},
    state: 'pending',
    attempt_count: 0,
    last_error: null,
    external_result_ref: null,
    requires_operation_id: null,
    next_attempt_at: null,
    created_at: c.occurred_at,
    ...input,
  };
  const reason = effectBlock(p, e, t);
  if (reason) {
    e.state = 'blocked';
    e.last_error = reason;
    note(s, c, 'effect_blocked', reason, e.operation_id);
  }
  s.outbox[e.operation_id] = e;
  return e;
}
function handoff(s: Ledger, p: Policy, t: Task, c: Command, intro?: string) {
  if (p.task_backend === 'agent_ledger') {
    t.external_record = { platform: 'agent_ledger', record_id: t.task_id, synthetic: p.mode === 'mock' };
    if (t.state !== 'needs_clarification')
      planCard(
        s,
        p,
        c,
        t,
        handoffCard(t, intro),
        t.primary_owner_key,
        `handoff:${t.task_id}:${t.revision}`,
        'handoff',
      );
    return;
  }
  if (t.state === 'needs_clarification') return;
  const op = `create:${t.task_id}:${t.revision}`;
  planEffect(s, p, c, {
    operation_id: op,
    capability: t.external_record ? 'work_item.update' : 'work_item.create',
    task_id: t.task_id,
    request: { task: structuredClone(t) },
  });
  planEffect(s, p, c, {
    operation_id: `handoff:${t.task_id}:${t.revision}`,
    capability: 'message.send',
    task_id: t.task_id,
    requires_operation_id: op,
    request: { text: `${t.title}；交付物：${t.deliverable}；请明确接单。`, purpose: 'handoff' },
  });
}
function ensureIssue(s: Ledger, id: string) {
  return s.issues[id] ?? (s.issues[id] = newIssue(id, s.project_id));
}
function touch(t: Task, c: Command) {
  t.last_human_at = c.occurred_at;
}
function assertOwner(t: Task, c: Command) {
  requireRule(t.primary_owner_key === c.actor_key, 'not_current_owner');
}
function assertCurrent(t: Task, c: Command) {
  if (c.payload.expected_revision !== undefined)
    requireRule(c.payload.expected_revision === t.revision, 'stale_revision');
}
function followupAllowed(s: Ledger, p: Policy, at: string, taskId: string | null) {
  const prior = Object.values(s.outbox).filter(
    (e) =>
      e.task_id === taskId && e.request.purpose === 'followup' && !['cancelled', 'blocked'].includes(e.state),
  );
  const last = prior.sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
  if (last && Date.parse(at) - Date.parse(last.created_at) < p.notifications.cooldown_minutes * 60000)
    return false;
  const day = (time: string) =>
    new Intl.DateTimeFormat('en-CA', { timeZone: p.notifications.timezone }).format(new Date(time));
  return prior.filter((e) => day(e.created_at) === day(at)).length < p.notifications.max_per_day;
}
function followupRecipient(t: Task) {
  return t.state === 'ready_for_qa'
    ? t.qa_owner_key
    : t.state === 'blocked'
      ? t.dependencies.find((d) => d.status !== 'satisfied')?.provider_owner_key
      : t.primary_owner_key;
}
/**
 * Whether a `timer_fired` at `at` would plan a follow-up for this task. Shared by the reducer and the
 * cron tick, so the tick only runs the reducer (and copies the ledger) for tasks that are actually due.
 */
export function followupDue(s: Ledger, t: Task, at: string, policy: Policy) {
  const n = t.next_condition;
  if (!n || n.expected_revision !== t.revision || ['cancelled', 'deferred', 'verified'].includes(t.state))
    return false;
  if (
    (n.not_before && Date.parse(at) < Date.parse(n.not_before)) ||
    (n.expires_at && Date.parse(at) > Date.parse(n.expires_at)) ||
    !inWorkWindow(at, policy)
  )
    return false;
  if (
    n.condition_type === 'check_due' &&
    (!t.schedule.committed_due_at || Date.parse(at) <= Date.parse(t.schedule.committed_due_at))
  )
    return false;
  if (!followupRecipient(t)) return false;
  return followupAllowed(s, policy, at, t.task_id);
}
function reminderRecipient(s: Ledger, taskId: string | null, policy: Policy) {
  const task = taskId ? s.tasks[taskId] : null;
  return task?.state === 'ready_for_qa'
    ? task.qa_owner_key
    : task?.state === 'blocked'
      ? task.dependencies.find((d) => d.status !== 'satisfied')?.provider_owner_key
      : (task?.primary_owner_key ?? policy.decision_owners[0]);
}
/** Same idea for planned coordination reminders. */
export function reminderDue(s: Ledger, reminderId: string, at: string, policy: Policy) {
  const r = s.reminders[reminderId];
  if (!r || r.state !== 'pending' || Date.parse(r.at) > Date.parse(at) || !inWorkWindow(at, policy))
    return false;
  if (r.task_id) {
    const t = s.tasks[r.task_id];
    if (!t || t.revision !== r.task_revision || ['verified', 'deferred', 'cancelled'].includes(t.state))
      return true; // firing cancels it, which is a state change worth committing
  }
  return Boolean(reminderRecipient(s, r.task_id, policy)) && followupAllowed(s, policy, at, r.task_id);
}
function canDeliver(t: Task) {
  const d = t.delivery as any,
    a = t.acceptance_spec;
  return (
    a.environment &&
    a.qa_owner_key &&
    a.case_ids.length &&
    a.expected_behavior !== '待明确验收目标' &&
    a.scope.description !== '待明确范围' &&
    d?.artifact_ref &&
    d?.test_entry_ref &&
    d?.environment === a.environment &&
    versionMatch(a, d.version_refs) &&
    t.dependencies.every((x) => x.status === 'satisfied')
  );
}
const REJECTION_TEXT: Record<string, string> = {
  stale_revision: '任务已有更新，请核对当前修订后重新提交',
  scope_revision_mismatch: '接单范围已经更新，请确认当前交付范围',
  not_current_owner: '需由当前主负责人确认',
  unauthorized_verifier: '需由指定验收人提交',
  revision_mismatch: '验收对应的任务修订已变化',
  version_mismatch: '请补充与验收要求相符的交付版本',
  environment_mismatch: '请补充对应测试环境',
  scope_incomplete: '验收范围与要求不一致（例如抽样不能替代全量）',
  evidence_incomplete: '请补充验收证据链接',
  not_ready_for_qa: '交付材料尚未齐全，当前还未进入待验收状态',
  explicit_dependency_evidence_required: '该依赖需要对应交付物或版本证据，不能仅凭一句话解除',
  task_missing: '找不到这个任务编号',
  acceptance_state_invalid: '任务当前不在待接手状态',
  delivery_state_invalid: '任务当前不在处理中，无法提交交付',
  decline_state_invalid: '任务当前状态不能退回',
  decision_actor_required: '这个操作需要协调人执行',
  acceptance_definition_actor_required: '验收标准需由验收人或协调人确定',
  acceptance_definition_incomplete: '验收标准还不完整（期望、环境、范围、用例）',
  identity_unbound: '对方的飞书身份尚未绑定',
  reassignment_invalid: '请用 @成员 指定唯一的新负责人',
  date_invalid: '时间格式无法识别，例如 2030-01-08 18:00',
  decision_reason_required: '请写明原因',
  blocker_required: '请写明阻塞原因',
  unknown_command: '无法识别的命令',
  command_missing: '缺少命令',
  task_id_missing: '缺少任务编号，例如 TASK-00001',
  json_invalid: 'JSON 格式有误',
  json_required: '这个命令需要 JSON 参数',
  qa_result_missing: '请写明「通过」或「不通过」',
  qa_result_invalid: '请写明「通过」或「不通过」',
  late_human_event: '这条操作早于任务的最新变更',
};
export function rejectionText(reason: string) {
  return REJECTION_TEXT[reason] ?? '当前任务状态、身份或材料尚不满足处理条件';
}
function commandNotice(s: Ledger, c: Command, policy: Policy, reason?: string) {
  if (
    c.envelope?.source !== 'feishu_message' ||
    c.event_type === 'feedback_observed' ||
    (c.event_type === 'qa_card_requested' && !reason) ||
    !c.payload.source_message_id
  )
    return;
  const t = s.tasks[c.payload.task_id],
    issue = s.issues[c.payload.issue_id];
  const labels: Record<string, string> = {
    needs_clarification: '待澄清',
    pending_acceptance: '待接单',
    in_progress: '处理中',
    blocked: '有阻塞',
    ready_for_qa: '已修待测',
    verified: '验收通过',
    deferred: '已暂缓',
    cancelled: '已取消',
  };
  const detail = t
    ? `任务 ${t.task_id}：${labels[t.state]}；修订 ${t.revision}。\n原问题：${t.issue_id}。\n主负责人：${t.primary_owner_key || '待定'}；验收人：${t.qa_owner_key || '待定'}。\n接单范围修订：${assignment(s, t)?.scope_revision ?? '待定'}；承诺完成时间：${t.schedule.committed_due_at || '尚未承诺'}。\n交付物：${t.deliverable}\n验收：${t.acceptance_spec.expected_behavior}\n用例：${t.acceptance_spec.case_ids.join('、') || '待定'}；环境：${t.acceptance_spec.environment || '待定'}；版本：${JSON.stringify(t.acceptance_spec.version_requirements)}。\n范围：${t.acceptance_spec.scope.description}（${t.acceptance_spec.scope.validation}）；证据类型：${t.acceptance_spec.required_evidence_types.join('、')}。\n${t.dependencies
        .filter((d) => d.status !== 'satisfied')
        .map(
          (d) =>
            `依赖 ${d.dependency_id}：等待 ${d.target_ref.replace(/^human-note:/, '')}，${d.required_condition}`,
        )
        .join('\n')}`
    : issue
      ? `问题 ${issue.issue_id}：${issue.lifecycle}；修订 ${issue.revision}。`
      : '未找到对应任务或问题。';
  const usage = typeof c.payload.usage === 'string' ? `\n\n${c.payload.usage}` : '';
  const head =
    c.event_type === 'command_help'
      ? '命令说明如下。\n'
      : reason
        ? `未执行本次变更：${rejectionText(reason)}。\n`
        : '已记录本次请求。\n';
  planEffect(s, policy, c, {
    operation_id: `receipt:${c.source_event_id || c.event_id}`,
    task_id: t?.task_id || null,
    issue_id: t?.issue_id || issue?.issue_id || null,
    capability: 'message.reply',
    target_owner_key: c.actor_key,
    target: c.payload.source_chat_id || '',
    request: {
      purpose: 'command_receipt',
      text: `${head}${c.event_type === 'command_help' ? '' : detail}${reason || c.event_type === 'command_help' ? usage : ''}`,
      reply_to: c.payload.source_message_id,
      source_chat_id: c.payload.source_chat_id,
      suppress_mention: true,
    },
  });
}
/**
 * System clock ticks are idempotent (a fired reminder changes state; a follow-up moves `not_before`),
 * so they are never recorded in `events`. Recording them grew the ledger every five minutes per task.
 */
const EPHEMERAL_SYSTEM_EVENTS = new Set([
  'timer_fired',
  'coordination_reminder_fired',
  'retry_timer_fired',
  'outbox_dispatch_requested',
]);
export function reduce(previous: Ledger, command: Command, policy: Policy): Ledger {
  const c = Command.parse(command),
    p = c.payload;
  const ephemeral = c.actor_key === 'system' && EPHEMERAL_SYSTEM_EVENTS.has(c.event_type);
  const business = c.source_event_id || c.envelope?.source_event_id || c.event_id;
  const dedup = JSON.stringify([
    previous.project_id,
    c.envelope?.source || 'conceptual',
    business,
    c.source_revision ?? c.envelope?.source_revision ?? '',
    c.envelope?.source === 'feishu_message' ? 'message' : c.event_type,
  ]);
  const start = () => {
    const copy = structuredClone(previous);
    ensureCoordinationState(copy);
    return copy;
  };
  if (!ephemeral && previous.events[dedup]) {
    const duplicate = start();
    note(duplicate, c, 'duplicate_ignored');
    return duplicate;
  }
  // A rejected command is retained but no partial domain mutation escapes: on failure we restart from
  // `previous`, so the common path needs a single deep copy of the ledger instead of two.
  const s = previous;
  const work = start();
  if (!ephemeral) work.events[dedup] = c;
  try {
    apply(work, c, policy);
    assertAcyclic(work.tasks);
    commandNotice(
      work,
      c,
      policy,
      work.audit.at(-1)?.type === 'qa_rejected' ? work.audit.at(-1)?.reason : undefined,
    );
    for (const t of Object.values(work.tasks)) {
      TaskState.parse(t.state);
      requireRule(!t.primary_owner_key || typeof t.primary_owner_key === 'string', 'multiple_owners');
      if (!s.tasks[t.task_id] || s.tasks[t.task_id].revision !== t.revision) setFollowup(work, t, c, policy);
      cancelObsolete(work, t);
    }
    cancelInvalidReminders(work, c.occurred_at);
    return work;
  } catch (e) {
    if (!(e instanceof DomainError) && !(e instanceof Error && e.name === 'ZodError')) throw e;
    const reason = e instanceof DomainError ? e.code : 'schema_invalid';
    const rejected = start();
    if (!ephemeral) rejected.events[dedup] = c;
    note(rejected, c, 'rejected', reason, p.task_id);
    commandNotice(rejected, c, policy, reason);
    return rejected;
  }
}
function apply(s: Ledger, c: Command, policy: Policy) {
  const p = c.payload;
  const t: Task | undefined = p.task_id ? s.tasks[p.task_id] : undefined;
  if (t) {
    assertCurrent(t, c);
    if (c.actor_key !== 'system' && t.last_human_at && c.occurred_at < t.last_human_at)
      throw new DomainError('late_human_event');
  }
  switch (c.event_type) {
    case 'source_message_observed': {
      observeSource(s, c);
      return;
    }
    case 'coordination_reminder_fired': {
      const r = s.reminders[p.reminder_id];
      if (!r || r.state !== 'pending' || Date.parse(r.at) > Date.parse(c.occurred_at)) return;
      if (!p.historical && !inWorkWindow(c.occurred_at, policy)) return;
      cancelInvalidReminders(s, c.occurred_at);
      if (r.state !== 'pending') return;
      if (!p.historical) {
        if (!followupAllowed(s, policy, c.occurred_at, r.task_id)) return;
        const task = r.task_id ? s.tasks[r.task_id] : null;
        const recipient = reminderRecipient(s, r.task_id, policy);
        if (!recipient) return;
        planEffect(s, policy, c, {
          operation_id: `coordination-reminder:${r.reminder_id}:${r.at}`,
          task_id: r.task_id,
          target_owner_key: recipient,
          capability: 'message.send',
          request: {
            purpose: 'followup',
            text: `${task ? `任务 ${task.task_id}「${task.title}」` : '项目检查'}：${r.reason}`,
            source_item_ids: r.source_item_ids,
          },
        });
      }
      r.state = 'fired';
      r.updated_at = c.occurred_at;
      return;
    }
    case 'task_status_requested': {
      requireRule(t, 'task_missing');
      return;
    }
    case 'feedback_observed': {
      observeSource(s, c);
      if (
        c.envelope?.source === 'feishu_message' &&
        !p.task_id &&
        !p.issue_id &&
        !/(反馈|问题|错误|异常|失败|不对|不符合|太长|太短|阻塞|验收|修复|不自然|人机|暂缓|取消|部署|测试|需求|动作|模型)/u.test(
          String(p.text || ''),
        )
      ) {
        note(s, c, 'record_only', 'low_information_group_message');
        return;
      }
      if (
        !p.case_id &&
        !p.feedback_id &&
        !p.task_id &&
        !/(反馈|问题|错误|异常|失败|不对|不符合|太长|太短|阻塞|验收|修复)/u.test(
          String(p.text || p.feedback || ''),
        )
      ) {
        note(s, c, 'record_only', 'low_information');
        return;
      }
      const source = p.feedback_id || p.case_id || c.source_event_id || c.event_id;
      const id = p.case_id || `case_${source}`;
      const observed = {
        source_event_id: c.event_id,
        source_revision: c.source_revision || p.source_revision || null,
        observed_at: c.occurred_at,
        payload: structuredClone(p),
      };
      if (!s.cases[id])
        s.cases[id] = {
          case_id: id,
          project_id: s.project_id,
          source_event_ids: [],
          feedback_ref: p.feedback_id || null,
          conversation_ref: p.context_ref || null,
          run_refs: p.run_refs || [],
          resource_refs: p.resource_refs || [],
          reported_expectation: p.expected || null,
          observed_behavior: p.observed_behavior || p.text || p.feedback || null,
          environment: p.environment || null,
          version_refs: p.version_refs || {},
          evidence_completeness: 'partial',
          created_at: c.occurred_at,
          observations: [],
        };
      s.cases[id].source_event_ids.push(c.event_id);
      s.cases[id].observations.push(observed);
      const explicit =
        p.issue_id || t?.issue_id || Object.values(s.issues).find((i) => i.case_ids.includes(id))?.issue_id;
      const issue = ensureIssue(s, explicit || p.new_issue_id || id.replace(/^case_/, 'issue_'));
      if (issue.problem_statement === '待整理原始证据' && (p.text || p.feedback || p.observed_behavior)) {
        issue.problem_statement = String(p.text || p.feedback || p.observed_behavior);
        issue.title = issue.problem_statement.slice(0, 80);
        issue.expected_behavior = p.expected || '待明确';
      }
      if (!issue.case_ids.includes(id)) issue.case_ids.push(id);
      if (
        p.known_issue_candidate &&
        p.known_issue_candidate !== issue.issue_id &&
        !s.relations.some((r) => r.to === issue.issue_id)
      )
        s.relations.push({ from: p.known_issue_candidate, to: issue.issue_id, status: 'candidate_only' });
      s.subscriptions[`feedback:${source}`] = {
        issue_id: issue.issue_id,
        kind: 'feedback',
        source_ref: source,
        active: issue.lifecycle === 'open',
      };
      note(s, c, 'case_observed', undefined, id);
      return;
    }
    case 'analysis_completed': {
      s.proposals.push({ event_id: c.event_id, proposal: structuredClone(p) });
      requireRule(c.actor_key === 'system', 'planner_origin_invalid');
      if (p.coordination) {
        const created = applyCoordination(s, c, policy);
        for (const id of new Set([
          ...created,
          ...p.coordination.tasks.map((x: any) => x.internal_task_id).filter(Boolean),
        ])) {
          const task = s.tasks[id as string];
          if (!task?.primary_owner_key || task.state !== 'pending_acceptance') continue;
          const prior = assignment(s, task);
          if (prior?.scope_revision === task.revision) continue;
          if (prior) {
            prior.status = 'ended';
            prior.ended_at = c.occurred_at;
          }
          proposeAssignment(s, task, c);
          // The owner hears about the task directly, with buttons, instead of only through reminders.
          handoff(s, policy, task, c);
        }
        // A person saying "I'll take it" / "fixed" / "verified" in chat is a claim, not a state change.
        // Turn it into a one-click confirmation for exactly that person.
        for (const r of p.coordination.reports ?? []) {
          const task = s.tasks[r.internal_task_id],
            item = s.source_items[r.source_item_id];
          if (!task || !item?.sender_id) continue;
          const sender = item.sender_id;
          if (
            r.kind === 'accepted' &&
            task.state === 'pending_acceptance' &&
            sender === task.primary_owner_key
          )
            planCard(
              s,
              policy,
              c,
              task,
              handoffCard(task, '看起来你已在群里表示接手，点「确认接手」即可正式记录。'),
              sender,
              `claim:${task.task_id}:${task.revision}:accepted`,
              'claim_confirmation',
            );
          if (
            r.kind === 'delivery_claimed' &&
            task.state === 'in_progress' &&
            sender === task.primary_owner_key
          )
            planCard(
              s,
              policy,
              c,
              task,
              deliverCard(
                task,
                assignment(s, task)?.scope_revision,
                '看起来已经完成，补充交付信息后会自动交给验收人。',
              ),
              sender,
              `claim:${task.task_id}:${task.revision}:delivery`,
              'claim_confirmation',
            );
          if (r.kind === 'qa_claimed' && task.state === 'ready_for_qa' && sender === task.qa_owner_key)
            planCard(
              s,
              policy,
              c,
              task,
              qaCard(task, '看起来已经验收，确认范围并附上证据即可正式记录。'),
              sender,
              `claim:${task.task_id}:${task.revision}:qa`,
              'claim_confirmation',
            );
        }
        if (p.notify && p.user_facing_summary?.trim())
          planEffect(s, policy, c, {
            operation_id: `coordination-notice:${c.event_id}`,
            capability: p.source_message_id ? 'message.reply' : 'message.send',
            target_owner_key: policy.decision_owners[0] || null,
            request: {
              purpose: 'coordination',
              text: p.user_facing_summary,
              reply_to: p.source_message_id,
              source_chat_id: p.source_chat_id,
              suppress_mention: true,
            },
          });
        return;
      }
      if (t) {
        requireRule(!['cancelled', 'deferred'].includes(t.state), 'task_inactive');
        requireRule(p.expected_revision === t.revision, 'stale_analysis');
      }
      if (
        p.decision_type === 'request_decision' &&
        policy.task_backend === 'agent_ledger' &&
        p.issue_id &&
        s.issues[p.issue_id]
      ) {
        const issue = s.issues[p.issue_id];
        planEffect(s, policy, c, {
          operation_id: `clarify:${issue.issue_id}:${issue.revision}`,
          issue_id: issue.issue_id,
          capability: 'message.send',
          target_owner_key: policy.decision_owners[0] || null,
          request: {
            purpose: 'clarification',
            text: `问题 ${issue.issue_id} 需要补充信息。\n${p.user_facing_summary || issue.problem_statement}\n${(p.missing_information || []).join('；')}`,
          },
        });
      }
      if (['record_only', 'request_decision', 'defer', 'cancel', 'prepare_qa'].includes(p.decision_type)) {
        note(s, c, 'proposal_recorded', 'requires_explicit_domain_evidence');
        return;
      }
      for (const change of p.proposed_task_changes || []) {
        requireRule(
          !change.state || change.state === 'needs_clarification' || change.state === 'pending_acceptance',
          'model_cannot_assert_human_state',
        );
        requireRule(
          !change.committed_due_at && !change.schedule?.committed_due_at,
          'model_cannot_commit_due_date',
        );
        if (change.task_id && s.tasks[change.task_id]) {
          note(s, c, 'proposal_recorded', 'existing_task_requires_scoped_command', change.task_id);
          continue;
        }
        let sequence = Object.keys(s.tasks).length + 1;
        while (s.tasks[`TASK-${String(sequence).padStart(5, '0')}`]) sequence++;
        const id =
          policy.transport === 'fake' && change.task_id
            ? change.task_id
            : `TASK-${String(sequence).padStart(5, '0')}`;
        const issue = ensureIssue(
          s,
          p.issue_id || t?.issue_id || Object.keys(s.issues).at(-1) || `issue_${c.event_id}`,
        );
        // Global candidates do not establish responsibility for an individual task.
        const owner = change.primary_owner_key ?? null;
        const knownOwner = owner && (policy.transport === 'fake' || policy.identities[owner]?.verified);
        const kind = TaskKind.parse(change.kind || 'diagnosis');
        const state =
          knownOwner && !(kind === 'decision' && p.missing_information?.length)
            ? 'pending_acceptance'
            : 'needs_clarification';
        const task = newTask(id, issue.issue_id, s.project_id, {
          kind,
          title: change.title || change.deliverable || '整理诊断材料',
          objective: change.objective || change.deliverable || '核实证据和范围',
          deliverable: change.deliverable || '提交定位报告和缺项',
          primary_owner_key: knownOwner ? owner : null,
          collaborator_keys: change.collaborator_keys || [],
          qa_owner_key: change.qa_owner_key || null,
          state,
          acceptance_spec: change.acceptance_spec || unknownAcceptance(change.qa_owner_key || null),
        });
        task.evidence_refs = [...new Set([...issue.case_ids, ...(p.fact_refs || [])])];
        s.tasks[id] = task;
        issue.task_ids.push(id);
        proposeAssignment(s, task, c);
        handoff(s, policy, task, c);
      }
      return;
    }
    case 'assignment_requested': {
      requireRule(policy.decision_owners.includes(c.actor_key), 'decision_actor_required');
      requireRule(
        !p.owner_key || policy.transport === 'fake' || policy.identities[p.owner_key]?.verified,
        'identity_unbound',
      );
      const id = p.task_id;
      requireRule(!s.tasks[id], 'task_already_exists');
      const issue = ensureIssue(s, p.issue_id || id.replace(/^task_/, 'issue_'));
      const task = newTask(id, issue.issue_id, s.project_id, {
        primary_owner_key: p.owner_key || null,
        state: p.owner_key ? 'pending_acceptance' : 'needs_clarification',
        title: p.summary || '诊断任务',
      });
      s.tasks[id] = task;
      issue.task_ids.push(id);
      proposeAssignment(s, task, c);
      handoff(s, policy, task, c);
      return;
    }
    case 'human_reply': {
      requireRule(t, 'task_missing');
      assertOwner(t, c);
      const a = assignment(s, t);
      requireRule(a, 'assignment_missing');
      if (p.interpretation === 'acknowledgement_only') {
        a.status = a.status === 'accepted' ? 'accepted' : 'acknowledged';
        a.acknowledged_at = c.occurred_at;
        a.source_refs.push(c.event_id);
      }
      touch(t, c);
      return;
    }
    case 'human_acceptance': {
      requireRule(t, 'task_missing');
      assertOwner(t, c);
      const a = assignment(s, t);
      // Without a revision ("/agent accept TASK-1", or the exact phrase in the task thread) the person
      // accepts the scope that is current now; the receipt echoes which revision that was.
      requireRule(
        a && (p.scope_revision === undefined || p.scope_revision === a.scope_revision),
        'scope_revision_mismatch',
      );
      requireRule(t.state === 'pending_acceptance' || t.state === 'blocked', 'acceptance_state_invalid');
      a.status = 'accepted';
      a.accepted_at = c.occurred_at;
      a.source_refs.push(c.event_id);
      if (t.dependencies.every((d) => d.status === 'satisfied')) transition(t, 'in_progress');
      else if (t.state === 'pending_acceptance') transition(t, 'blocked');
      touch(t, c);
      offerDelivery(s, policy, c, t);
      if (String(t.state) === 'in_progress') requestSpec(s, policy, c, t);
      return;
    }
    case 'assignment_declined': {
      requireRule(t, 'task_missing');
      assertOwner(t, c);
      requireRule(
        ['pending_acceptance', 'blocked', 'in_progress'].includes(t.state),
        'decline_state_invalid',
      );
      const a = assignment(s, t);
      if (a) {
        a.status = 'ended';
        a.ended_at = c.occurred_at;
        a.handoff_reason = String(p.reason ?? '').slice(0, 300) || null;
      }
      const previous = t.primary_owner_key;
      transition(t, 'needs_clarification');
      t.primary_owner_key = null;
      t.assignment_id = null;
      t.decision_refs.push(c.event_id);
      touch(t, c);
      planEffect(s, policy, c, {
        operation_id: `declined:${t.task_id}:${t.revision}`,
        task_id: t.task_id,
        capability: 'message.send',
        target_owner_key: policy.decision_owners[0] || null,
        request: {
          purpose: 'reassignment_needed',
          text: `任务 ${t.task_id}「${t.title}」被 ${previous} 退回：${p.reason || '未说明原因'}。\n需要重新指定负责人：${policy.command_prefix} reassign ${t.task_id} @成员 原因`,
        },
      });
      return;
    }
    case 'qa_card_requested': {
      requireRule(t, 'task_missing');
      requireRule(c.actor_key === t.qa_owner_key, 'unauthorized_verifier');
      requireRule(t.state === 'ready_for_qa', 'not_ready_for_qa');
      planCard(
        s,
        policy,
        c,
        t,
        qaCard(
          t,
          p.result_hint === 'fail'
            ? '收到「未通过」。请确认验收环境和范围，附上证据后点「验收不通过」正式记录。'
            : '收到「通过」。请确认验收环境和范围，附上证据后点「验收通过」正式记录。',
        ),
        t.qa_owner_key,
        `qa-confirm:${t.task_id}:${t.revision}:${c.source_event_id || c.event_id}`,
        'claim_confirmation',
      );
      return;
    }
    case 'command_invalid': {
      throw new DomainError(String(p.reason || 'unknown_command'));
    }
    case 'command_help': {
      return;
    }
    case 'human_due_commitment': {
      requireRule(t, 'task_missing');
      assertOwner(t, c);
      requireRule(assignment(s, t)?.status === 'accepted', 'assignment_not_accepted');
      requireRule(
        typeof p.committed_due_at === 'string' &&
          /(Z|[+-]\d{2}:\d{2})$/.test(p.committed_due_at) &&
          Number.isFinite(Date.parse(p.committed_due_at)),
        'date_invalid',
      );
      t.schedule.committed_due_at = p.committed_due_at;
      t.schedule.source_ref = c.event_id;
      t.schedule.updated_at = c.occurred_at;
      t.revision++;
      touch(t, c);
      return;
    }
    case 'blocked_reported': {
      requireRule(t, 'task_missing');
      assertOwner(t, c);
      const target = p.blocker_text ? `human-note:${String(p.blocker_text).slice(0, 300)}` : null;
      const dependencies =
        p.dependencies ??
        (target
          ? [
              ...t.dependencies.filter((d) => d.target_ref !== target),
              {
                dependency_id: `blocker:${c.source_event_id || c.event_id}`,
                kind: 'decision',
                target_ref: target,
                required_condition: '原负责人明确确认此项阻塞解除',
                provider_owner_key: c.actor_key,
                status: 'waiting',
                source_ref: c.event_id,
                observed_at: c.occurred_at,
              },
            ]
          : undefined);
      requireRule(dependencies?.length, 'blocker_required');
      t.dependencies = Dependency.array().parse(dependencies);
      if (t.state === 'blocked') t.revision++;
      else transition(t, 'blocked');
      touch(t, c);
      return;
    }
    case 'human_blocker_resolved': {
      requireRule(t && t.state === 'blocked', 'not_blocked');
      assertOwner(t, c);
      const eligible = t.dependencies.filter(
        (d) =>
          d.kind === 'decision' &&
          d.target_ref.startsWith('human-note:') &&
          d.provider_owner_key === c.actor_key &&
          d.status !== 'satisfied',
      );
      requireRule(eligible.length, 'explicit_dependency_evidence_required');
      for (const d of eligible) {
        d.status = 'satisfied';
        d.observed_at = c.occurred_at;
        d.source_ref = c.event_id;
      }
      if (t.dependencies.every((d) => d.status === 'satisfied'))
        transition(t, assignment(s, t)?.status === 'accepted' ? 'in_progress' : 'pending_acceptance');
      else t.revision++;
      touch(t, c);
      offerDelivery(s, policy, c, t);
      return;
    }
    case 'dependency_confirmed_by_human': {
      requireRule(t && t.state === 'blocked', 'not_blocked');
      const d = t.dependencies.find((d) => d.dependency_id === p.dependency_id);
      requireRule(d, 'dependency_missing');
      requireRule(
        c.actor_key === d.provider_owner_key || policy.decision_owners.includes(c.actor_key),
        'dependency_provider_required',
      );
      requireRule(
        p.evidence_ref && (!d.expected_version || p.version === d.expected_version),
        'dependency_evidence_or_version_mismatch',
      );
      d.status = 'satisfied';
      d.source_ref = c.event_id;
      d.observed_at = c.occurred_at;
      t.evidence_refs.push(p.evidence_ref);
      if (t.dependencies.every((d) => d.status === 'satisfied'))
        transition(t, assignment(s, t)?.status === 'accepted' ? 'in_progress' : 'pending_acceptance');
      else t.revision++;
      offerDelivery(s, policy, c, t);
      planEffect(s, policy, c, {
        operation_id: `dependency-ready:${t.task_id}:${t.revision}`,
        task_id: t.task_id,
        capability: 'message.send',
        request: {
          purpose: 'dependency_update',
          text: `任务 ${t.task_id} 的依赖 ${d.target_ref} 已由提供人确认交付。\n证据：${p.evidence_ref}\n${t.state === 'blocked' ? '仍有其他依赖待满足。' : '可以按当前任务范围继续推进。'}`,
        },
      });
      touch(t, c);
      return;
    }
    case 'acceptance_defined':
    case 'issue_acceptance_defined': {
      requireRule(
        policy.decision_owners.includes(c.actor_key) || t?.qa_owner_key === c.actor_key,
        'acceptance_definition_actor_required',
      );
      let input = p.acceptance_spec;
      if (p.complete_from_task) {
        // Short command / card form: only the human-facing fields are typed; case links and evidence
        // types come from the task, and whoever defines criteria without a named verifier verifies.
        requireRule(t, 'task_missing');
        const cur = t.acceptance_spec,
          i = p.acceptance_input ?? {};
        const versions = i.version_requirements
          ? Object.fromEntries(
              Object.entries(i.version_requirements).map(([k, v]) => [k === '*' ? 'build' : k, v]),
            )
          : cur.version_requirements;
        input = {
          expected_behavior: i.expected_behavior ?? cur.expected_behavior,
          case_ids: cur.case_ids.length ? cur.case_ids : (s.issues[t.issue_id]?.case_ids ?? []),
          environment: i.environment ?? cur.environment,
          version_requirements: versions,
          scope: {
            description: i.scope_description ?? cur.scope.description,
            validation: i.validation ?? cur.scope.validation,
          },
          qa_owner_key: cur.qa_owner_key ?? t.qa_owner_key ?? c.actor_key,
          required_evidence_types: cur.required_evidence_types.length
            ? cur.required_evidence_types
            : ['human_qa'],
        };
      }
      const spec = AcceptanceSpec.parse(input);
      requireRule(
        spec.qa_owner_key && spec.environment && spec.case_ids.length && spec.required_evidence_types.length,
        'acceptance_definition_incomplete',
      );
      if (p.complete_from_task)
        requireRule(
          spec.expected_behavior !== '待明确验收目标' && spec.scope.description !== '待明确范围',
          'acceptance_definition_incomplete',
        );
      if (c.event_type === 'acceptance_defined') {
        requireRule(t && t.state !== 'cancelled', 'task_missing_or_cancelled');
        const old = assignment(s, t);
        if (old) {
          old.status = 'ended';
          old.ended_at = c.occurred_at;
        }
        t.acceptance_spec = spec;
        t.qa_owner_key = spec.qa_owner_key;
        t.revision++;
        t.schedule.committed_due_at = null;
        touch(t, c);
        if (t.primary_owner_key) {
          t.state = 'pending_acceptance';
          proposeAssignment(s, t, c);
          handoff(s, policy, t, c, '验收标准已更新，范围有变化，请重新确认是否接手。');
        }
      } else {
        const issue = s.issues[p.issue_id];
        requireRule(issue && issue.lifecycle === 'open', 'issue_not_open');
        requireRule(p.expected_revision === issue.revision, 'stale_issue_revision');
        issue.acceptance_spec = spec;
        issue.revision++;
      }
      return;
    }
    case 'delivery_reported': {
      requireRule(t, 'task_missing');
      assertOwner(t, c);
      requireRule(t.state === 'in_progress', 'delivery_state_invalid');
      if (p.scope_revision !== undefined)
        requireRule(assignment(s, t)?.scope_revision === p.scope_revision, 'scope_revision_mismatch');
      const spec = t.acceptance_spec;
      // Missing fields never erase what an earlier report already provided ("已修复" after a full form).
      const fields = defined({
        artifact_ref: p.artifact_ref,
        test_entry_ref: p.test_entry_ref,
        environment: p.environment,
        note: p.note,
        text: p.text,
      });
      const versions =
        resolveVersions(p.version_refs, spec) ??
        (p.service_release ? { service: String(p.service_release) } : undefined);
      const previous = (t.delivery ?? {}) as Record<string, any>;
      t.delivery = {
        ...previous,
        ...fields,
        version_refs: { ...(previous.version_refs ?? {}), ...(versions ?? {}) },
        reported_by: c.actor_key,
        source_ref: c.event_id,
      };
      if (canDeliver(t)) {
        transition(t, 'ready_for_qa');
        planCard(
          s,
          policy,
          c,
          t,
          qaCard(t),
          t.qa_owner_key,
          `qa-handoff:${t.task_id}:${t.revision}`,
          'qa_handoff',
        );
      } else {
        const d = t.delivery as Record<string, any>;
        const deliveryGaps = [
          !d.artifact_ref && '交付物',
          !d.test_entry_ref && '测试入口',
          spec.environment && d.environment !== spec.environment && `环境（验收要求 ${spec.environment}）`,
          !versionMatch(spec, d.version_refs) &&
            `版本（要求 ${Object.entries(spec.version_requirements)
              .map(([k, v]) => `${k}=${v ?? '未定'}`)
              .join('，')}）`,
        ].filter(Boolean) as string[];
        const specGaps = acceptanceGaps(t);
        const waiting = t.dependencies.filter((x) => x.status !== 'satisfied').map((x) => x.target_ref);
        const lines = [
          `任务 ${t.task_id} 已记录你的交付，但还不能交给验收：`,
          deliveryGaps.length ? `· 交付信息还缺：${deliveryGaps.join('、')}` : '',
          specGaps.length ? `· 验收标准还缺：${specGaps.join('、')}（已请验收人补充）` : '',
          waiting.length ? `· 依赖未满足：${waiting.join('、')}` : '',
        ].filter(Boolean);
        if (deliveryGaps.length)
          planCard(
            s,
            policy,
            c,
            t,
            deliverCard(t, assignment(s, t)?.scope_revision, lines.join('\n')),
            t.primary_owner_key,
            `delivery-missing:${t.task_id}:${c.event_id}`,
            'clarification',
          );
        else
          planEffect(s, policy, c, {
            operation_id: `delivery-missing:${t.task_id}:${c.event_id}`,
            task_id: t.task_id,
            capability: 'message.send',
            request: { purpose: 'clarification', text: lines.join('\n') },
          });
        requestSpec(s, policy, c, t);
      }
      touch(t, c);
      return;
    }
    case 'deployment_observed': {
      if (t && t.delivery) {
        t.delivery = { ...t.delivery, ...p };
        if (t.state === 'in_progress' && canDeliver(t)) transition(t, 'ready_for_qa');
      }
      note(s, c, 'deployment_evidence');
      return;
    }
    case 'external_work_item_completed': {
      note(s, c, 'progress_only', 'native_completion_is_not_qa');
      return;
    }
    case 'qa_reported':
    case 'issue_acceptance_reported': {
      requireRule(['pass', 'fail'].includes(p.result), 'qa_result_invalid');
      const subject = c.event_type === 'qa_reported' ? t : s.issues[p.issue_id];
      requireRule(subject, 'acceptance_target_missing');
      let report: Record<string, any> = p;
      if (t && p.confirm_displayed_scope) {
        // The card / short command showed the current criteria; the verifier confirms that scope, picks
        // full or sampled coverage, and provides evidence. Sampling still cannot verify a full-scope task.
        const spec = t.acceptance_spec;
        report = {
          ...p,
          task_revision: p.task_revision ?? t.revision,
          case_ids: spec.case_ids,
          scope: {
            description: spec.scope.description,
            validation: p.scope?.validation ?? spec.scope.validation,
          },
          evidence_types: spec.required_evidence_types,
          environment: p.environment ?? spec.environment,
          version_refs: {
            ...Object.fromEntries(Object.entries(spec.version_requirements).filter(([, v]) => v !== null)),
            ...(resolveVersions(p.version_refs, spec) ?? {}),
          },
          evidence_refs: p.evidence_refs ?? [],
        };
      }
      let reason = qaReason(subject.acceptance_spec, subject.revision, { ...c, payload: report });
      if (!reason && t && t.state !== 'ready_for_qa') reason = 'not_ready_for_qa';
      if (!reason && !t && 'lifecycle' in subject && subject.lifecycle !== 'open') reason = 'issue_not_open';
      s.qa_reports.push({ accepted: !reason, reason, payload: structuredClone(report), actor: c.actor_key });
      if (reason) {
        note(s, c, 'qa_rejected', reason);
        return;
      }
      if (t) {
        transition(t, report.result === 'pass' ? 'verified' : 'in_progress');
        t.evidence_refs.push(...report.evidence_refs);
        touch(t, c);
        if (policy.task_backend === 'agent_ledger')
          planEffect(s, policy, c, {
            operation_id: `qa-result:${t.task_id}:${t.revision}`,
            task_id: t.task_id,
            capability: 'message.send',
            request: {
              purpose: 'qa_result',
              text: `任务 ${t.task_id} 验收${report.result === 'pass' ? '通过' : '未通过，继续处理'}（修订 ${t.revision}）。\n范围：${report.scope.description}（${report.scope.validation === 'all' ? '全量' : '抽样'}）\n证据：${report.evidence_refs.join('、')}\n原问题 ${t.issue_id} 的验收状态单独保留。`,
            },
          });
        if (report.result === 'fail')
          offerDelivery(
            s,
            policy,
            c,
            t,
            '验收未通过，修复后在这里重新提交交付信息。',
            `qa-fail-${t.revision}`,
          );
      } else if ('lifecycle' in subject && p.result === 'pass') {
        subject.lifecycle = 'verified';
        subject.revision++;
      }
      return;
    }
    case 'manual_reassignment':
    case 'manual_cancel':
    case 'manual_defer':
    case 'manual_resume':
    case 'regression_reopen': {
      requireRule(t, 'task_missing');
      requireRule(
        policy.decision_owners.includes(c.actor_key) ||
          (c.actor_key === t.primary_owner_key && ['manual_defer'].includes(c.event_type)),
        'decision_actor_required',
      );
      requireRule(p.reason, 'decision_reason_required');
      const a = assignment(s, t);
      if (c.event_type === 'manual_reassignment') {
        requireRule(t.state !== 'cancelled' && p.new_owner_key, 'reassignment_invalid');
        requireRule(
          policy.transport === 'fake' || policy.identities[p.new_owner_key]?.verified,
          'identity_unbound',
        );
        if (a) {
          a.status = 'ended';
          a.ended_at = c.occurred_at;
        }
        t.primary_owner_key = p.new_owner_key;
        t.revision++;
        t.state = 'pending_acceptance';
        t.schedule.committed_due_at = null;
        t.schedule.source_ref = null;
        proposeAssignment(s, t, c);
      } else if (c.event_type === 'manual_resume') {
        requireRule(t.state === 'deferred', 'not_deferred');
        const resumeState =
          p.scope_unchanged && a?.status === 'accepted' ? 'in_progress' : 'pending_acceptance';
        transition(t, resumeState);
        if (resumeState === 'in_progress' && t.dependencies.some((d) => d.status !== 'satisfied'))
          transition(t, 'blocked');
      } else if (c.event_type === 'regression_reopen') {
        requireRule(t.state === 'verified', 'not_verified');
        transition(t, 'needs_clarification');
      } else {
        transition(t, c.event_type === 'manual_cancel' ? 'cancelled' : 'deferred');
        if (a && t.state === 'cancelled') {
          a.status = 'ended';
          a.ended_at = c.occurred_at;
        }
      }
      if (['manual_reassignment', 'manual_resume'].includes(c.event_type) && t.state === 'pending_acceptance')
        handoff(s, policy, t, c);
      t.decision_refs.push(c.event_id);
      t.next_condition = null;
      touch(t, c);
      cancelObsolete(s, t);
      return;
    }
    case 'dependency_observed':
    case 'resource_status_observed': {
      requireRule(
        c.actor_key === 'system' || c.envelope?.actor.kind === 'service',
        'resource_source_required',
      );
      for (const task of Object.values(s.tasks)) {
        let changed = false;
        for (const d of task.dependencies) {
          if (
            d.dependency_id !== p.dependency_id &&
            d.target_ref !== (p.job_id || p.deployment_id || p.artifact_id)
          )
            continue;
          if (d.observed_at && c.occurred_at < d.observed_at) continue;
          const version = p.version || p.artifact_version || p.service_release;
          const ready =
            d.required_condition === p.status ||
            (d.required_condition === 'succeeded_with_artifact' &&
              p.status === 'succeeded' &&
              p.artifact_version);
          const status =
            ready && d.expected_version && version === d.expected_version && p.source_ref
              ? 'satisfied'
              : 'waiting';
          changed ||= d.status !== status;
          d.status = status;
          d.observed_at = c.occurred_at;
          d.source_ref = p.source_ref || null;
        }
        if (changed && task.state === 'blocked' && task.dependencies.every((d) => d.status === 'satisfied')) {
          transition(task, assignment(s, task)?.status === 'accepted' ? 'in_progress' : 'pending_acceptance');
          planEffect(s, policy, c, {
            operation_id: `dependencies-ready:${task.task_id}:${task.revision}`,
            task_id: task.task_id,
            capability: 'message.send',
            request: { purpose: 'dependency_ready', text: '依赖已齐备，请继续当前交付范围。' },
          });
        } else if (
          changed &&
          ['in_progress', 'ready_for_qa'].includes(task.state) &&
          task.dependencies.some((d) => d.status !== 'satisfied')
        )
          transition(task, 'blocked');
      }
      return;
    }
    case 'timer_fired': {
      requireRule(t, 'task_missing');
      if (!followupDue(s, t, c.occurred_at, policy)) return;
      const n = t.next_condition!;
      const recipient = followupRecipient(t)!;
      const operation_id = `followup:${t.task_id}:${t.revision}:${n.not_before || c.occurred_at}`;
      // Every reminder says which task, what is expected and how to answer it in one step.
      if (t.state === 'pending_acceptance')
        planCard(
          s,
          policy,
          c,
          t,
          handoffCard(t, '提醒：这项工作还在等你确认是否接手。'),
          recipient,
          operation_id,
          'followup',
        );
      else if (t.state === 'ready_for_qa')
        planCard(
          s,
          policy,
          c,
          t,
          qaCard(t, '提醒：这项工作已修待测，还在等你验收。'),
          recipient,
          operation_id,
          'followup',
        );
      else if (n.condition_type === 'check_due')
        planCard(
          s,
          policy,
          c,
          t,
          deliverCard(
            t,
            assignment(s, t)?.scope_revision,
            `提醒：已超过你确认的交付时间（${t.schedule.committed_due_at}）。完成后可直接提交；需要改期请回复「${policy.command_prefix} due ${t.task_id} 新时间」。`,
          ),
          recipient,
          operation_id,
          'followup',
        );
      else {
        const waiting = t.dependencies.find((d) => d.status !== 'satisfied');
        planEffect(s, policy, c, {
          operation_id,
          task_id: t.task_id,
          capability: 'message.send',
          target_owner_key: recipient,
          request: {
            purpose: 'followup',
            text: waiting
              ? `提醒：任务 ${t.task_id}「${t.title}」正在等你提供：${waiting.target_ref.replace(/^human-note:/, '')}（${waiting.required_condition}）。\n提供后回复「${policy.command_prefix} dependency ${t.task_id} ${waiting.dependency_id} 证据=链接」；阻塞已解除请回复「${policy.command_prefix} unblock ${t.task_id}」。`
              : `提醒：任务 ${t.task_id}「${t.title}」需要更新进展。`,
          },
        });
      }
      n.not_before = new Date(
        Date.parse(c.occurred_at) + policy.notifications.cooldown_minutes * 60000,
      ).toISOString();
      return;
    }
    case 'external_effect_requested': {
      requireRule(policy.decision_owners.includes(c.actor_key), 'decision_actor_required');
      planEffect(s, policy, c, {
        ...p,
        operation_id: p.operation_id,
        capability: p.capability,
        target: p.target_key || '',
        target_owner_key: p.owner_key || null,
      });
      return;
    }
    case 'process_restarted': {
      for (const e of Object.values(s.outbox))
        if (e.state === 'sending') {
          e.state = 'unknown';
          e.last_error = 'interrupted_send';
        }
      return;
    }
    case 'reconciliation_result': {
      const e = s.outbox[p.operation_id];
      requireRule(e && e.state === 'unknown', 'operation_not_unknown');
      if (p.authoritative && p.result === 'found_one' && p.record_ref) {
        e.state = 'succeeded';
        e.external_result_ref = p.record_ref;
        const task = e.task_id ? s.tasks[e.task_id] : undefined;
        if (task && e.capability === 'work_item.create')
          task.external_record = {
            platform: policy.transport === 'fake' ? 'fake_project' : 'feishu_project',
            record_id: p.record_ref,
            synthetic: policy.transport === 'fake',
          };
        if (task && e.capability.startsWith('message')) {
          s.subscriptions[`message:${p.record_ref}:${task.task_id}`] = {
            task_id: task.task_id,
            issue_id: task.issue_id,
            kind: 'message',
            source_ref: p.record_ref,
            active: !['cancelled', 'deferred', 'verified'].includes(task.state),
          };
          const a = assignment(s, task);
          if (e.request.purpose === 'handoff' && a?.scope_revision === e.expected_revision)
            a.assigned_at = e.last_attempt_at || c.occurred_at;
        }
      } else if (p.authoritative && p.result === 'confirmed_absent') {
        e.state = 'pending';
      } else if (!s.attention.includes(e.operation_id)) s.attention.push(e.operation_id);
      return;
    }
    case 'retry_timer_fired':
    case 'outbox_dispatch_requested': {
      return;
    }
    case 'evidence_observed': {
      note(s, c, 'evidence_recorded', 'untrusted_context_cannot_authorize');
      return;
    }
    default:
      note(s, c, 'record_only', 'no_supported_command');
  }
}

// Persistent fake effects are the same outbox state machine; they never construct network clients.
export function drainFake(previous: Ledger, policy: Policy): Ledger {
  requireRule(policy.transport === 'fake', 'fake_transport_required');
  const s = structuredClone(previous);
  for (const e of Object.values(s.outbox)) {
    if (!['pending', 'failed_retryable'].includes(e.state)) continue;
    const t = e.task_id ? s.tasks[e.task_id] : undefined;
    const block = effectBlock(policy, e, t);
    if (block) {
      e.state =
        block === 'stale_revision_or_state' || block === 'assignment_changed' ? 'cancelled' : 'blocked';
      e.last_error = block;
      continue;
    }
    if (e.requires_operation_id && s.outbox[e.requires_operation_id]?.state !== 'succeeded') continue;
    e.attempt_count++;
    if (e.capability === 'work_item.create') {
      let record = s.fake.records[e.operation_id];
      if (!record) {
        record = {
          record_ref: `fake_record_${e.operation_id}`,
          operation_id: e.operation_id,
          task_id: e.task_id || '',
        };
        s.fake.records[e.operation_id] = record;
        s.fake.creates++;
      }
      e.external_result_ref = record.record_ref;
      if (t) t.external_record = { platform: 'fake_project', record_id: record.record_ref, synthetic: true };
    } else if (e.capability.startsWith('message')) {
      if (!s.fake.messages.some((m) => m.operation_id === e.operation_id))
        s.fake.messages.push({
          operation_id: e.operation_id,
          recipient: e.target_owner_key || '',
          body: e.request,
        });
      e.external_result_ref = `fake_message_${e.operation_id}`;
      if (t && e.request.purpose === 'handoff') {
        const a = assignment(s, t);
        if (a) a.assigned_at = e.created_at;
      }
    } else s.fake.updates++;
    e.state = 'succeeded';
  }
  return s;
}
