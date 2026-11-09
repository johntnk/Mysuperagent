import type { Command, Ledger } from './domain/contracts';
import type { Policy } from './policy';
export function correlateConversation(s: Ledger, c: Command, policy: Policy): Command {
  if (c.event_type !== 'feedback_observed') return c;
  const p = c.payload,
    refs = [
      p.source_parent_message_id,
      p.source_thread,
      p.source_message_id,
      ...(c.envelope?.thread_refs.map((x) => x.thread_id) || []),
    ].filter(Boolean);
  const matched = Object.values(s.subscriptions).filter(
    (sub) => sub.active && sub.kind === 'message' && refs.includes(sub.source_ref),
  );
  const explicitIds = (String(p.text || '').match(/\bTASK-\d{5}\b/g) || []).filter((id) => s.tasks[id]);
  const taskIds = [...new Set([...explicitIds, ...matched.map((sub) => sub.task_id).filter(Boolean)])];
  const issueIds = [...new Set(matched.map((sub) => sub.issue_id))];
  const task = taskIds.length === 1 ? s.tasks[taskIds[0]!] : undefined;
  const issue = task?.issue_id || (issueIds.length === 1 ? issueIds[0] : null);
  const text = String(p.text || '')
    .replace(/^TASK-\d{5}[\s：:]+/, '')
    .trim();
  const base = {
    ...c,
    payload: { ...p, ...(issue ? { issue_id: issue } : {}), ...(task ? { task_id: task.task_id } : {}) },
  };
  if (!task || (p.message_type && p.message_type !== 'text')) return base;
  // Exact, bounded phrases, only in an explicitly correlated task thread. Trailing punctuation and emoji
  // are ignored ("好的👌", "我来负责～"); anything longer goes to the model and, at most, earns a
  // confirmation card. Delivery and QA phrases never change state on their own: they bring up the form.
  const phrase = text.replace(/[\s。．.！!？?~～，,、…\p{Extended_Pictographic}\u{FE0F}]+$/u, '');
  if (c.actor_key === task.primary_owner_key) {
    if (
      /^(收到|已收到|收到了|收到[，,]?谢谢|好的[，,]?收到|好的|好|ok|OK|了解|明白|知道了|嗯嗯?)$/u.test(
        phrase,
      )
    )
      return {
        ...base,
        event_type: 'human_reply',
        payload: { ...base.payload, interpretation: 'acknowledgement_only' },
      };
    if (
      /^(我接手|我来处理|我负责处理|我确认接单|接受这个任务|接单|我来负责|我负责|交给我|我来做|我接了|我来)$/u.test(
        phrase,
      )
    ) {
      const assignment = task.assignment_id ? s.assignments[task.assignment_id] : undefined;
      return {
        ...base,
        event_type: 'human_acceptance',
        payload: { ...base.payload, scope_revision: assignment?.scope_revision },
      };
    }
    if (/^(修改完成|已修复|改好了|修好了|已部署|搞定了|已完成|完成了|done|Done)$/u.test(phrase))
      return { ...base, event_type: 'delivery_reported', payload: { ...base.payload, text } };
    const blocker = text.match(/^(?:阻塞|被阻塞|卡住了)[：:]\s*(.{1,300})$/u);
    if (blocker) {
      const target = `human-note:${blocker[1]}`;
      return {
        ...base,
        event_type: 'blocked_reported',
        payload: {
          ...base.payload,
          dependencies: [
            ...task.dependencies.filter((d) => d.target_ref !== target),
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
          ],
        },
      };
    }
    if (/^(?:阻塞已解除|我的阻塞已解除|阻塞解除了)$/u.test(phrase))
      return { ...base, event_type: 'human_blocker_resolved', payload: base.payload };
  }
  // "验收通过" alone lacks the environment, version, coverage and evidence a verdict needs, so it brings
  // up the QA form for the verifier instead of being recorded (or bluntly rejected).
  if (
    c.actor_key === task.qa_owner_key &&
    /^(验收通过|测试通过|验收未通过|测试未通过|验收不通过)$/u.test(phrase)
  )
    return {
      ...base,
      event_type: 'qa_card_requested',
      payload: { ...base.payload, result_hint: /未通过|不通过/.test(phrase) ? 'fail' : 'pass' },
    };
  if (policy.decision_owners.includes(c.actor_key)) {
    const decision = text.match(/^(暂缓|取消|恢复)[：:]\s*(.{1,300})$/u);
    if (decision)
      return {
        ...base,
        event_type: ({ 暂缓: 'manual_defer', 取消: 'manual_cancel', 恢复: 'manual_resume' } as const)[
          decision[1] as '暂缓' | '取消' | '恢复'
        ],
        payload: {
          ...base.payload,
          expected_revision: task.revision,
          reason: decision[2],
          scope_unchanged: decision[1] === '恢复',
        },
      };
  }
  return base;
}
export function bindMessage(s: Ledger, messageId: string, taskId: string) {
  const t = s.tasks[taskId];
  if (t)
    s.subscriptions[`message:${messageId}:${taskId}`] = {
      task_id: taskId,
      issue_id: t.issue_id,
      kind: 'message',
      source_ref: messageId,
      active: !['cancelled', 'deferred', 'verified'].includes(t.state),
    };
}
export function decorateMessageEffects(s: Ledger, policy: Policy, chat: string | null) {
  for (const e of Object.values(s.outbox))
    if (
      e.capability.startsWith('message') &&
      !['succeeded', 'sending', 'unknown', 'cancelled'].includes(e.state)
    ) {
      const task = e.task_id ? s.tasks[e.task_id] : undefined,
        issue = task ? s.issues[task.issue_id] : e.issue_id ? s.issues[e.issue_id] : undefined;
      const source = issue?.case_ids
        .flatMap((id) => s.cases[id]?.observations || [])
        .map((o) => (o.payload || {}) as Record<string, any>)
        .find((p) => p.source_message_id);
      if (source && !e.request.reply_to) {
        e.request.reply_to = source.source_message_id;
        e.request.source_chat_id = source.source_chat_id;
        e.capability = 'message.reply';
        if (task) {
          bindMessage(s, source.source_message_id, task.task_id);
          if (source.source_thread) bindMessage(s, source.source_thread, task.task_id);
        } else if (issue) {
          s.subscriptions[`message:${source.source_message_id}:${issue.issue_id}`] = {
            issue_id: issue.issue_id,
            kind: 'message',
            source_ref: source.source_message_id,
            active: issue.lifecycle === 'open',
          };
        }
      }
      if (policy.transport === 'real')
        e.target = e.request.source_chat_id || source?.source_chat_id || chat || '';
      const identity = e.target_owner_key ? policy.identities[e.target_owner_key] : null;
      if (identity?.verified && !identity.synthetic && !e.request.suppress_mention)
        e.request.mention_open_id = identity.id;
    }
}
