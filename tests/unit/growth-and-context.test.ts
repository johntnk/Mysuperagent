import { it, expect } from 'vitest';
import {
  Assignment,
  emptyLedger,
  newIssue,
  newTask,
  type Command,
  type Ledger,
} from '../../src/domain/contracts';
import { reduce, followupDue } from '../../src/domain/engine';
import { setFollowup } from '../../src/followups';
import { localPolicy } from '../../src/policy';
import { contextFor } from '../../src/analysis/planner';
import { loadConfig } from '../../src/config';
import { observeSource } from '../../src/domain/source-items';

const policy = localPolicy();
const monday = '2030-01-07T01:00:00.000Z'; // 09:00 in Asia/Shanghai

function waitingTasks(n: number) {
  const s = emptyLedger(policy.project_id);
  for (let i = 1; i <= n; i++) {
    const id = `TASK-${String(i).padStart(5, '0')}`;
    s.issues[`issue_${i}`] = newIssue(`issue_${i}`, s.project_id);
    const t = newTask(id, `issue_${i}`, s.project_id, {
      primary_owner_key: 'owner',
      state: 'pending_acceptance',
    });
    t.assignment_id = `assignment_${id}_1`;
    s.assignments[t.assignment_id] = Assignment.parse({
      assignment_id: t.assignment_id,
      task_id: id,
      owner_key: 'owner',
      scope_revision: 1,
      status: 'proposed',
      assigned_at: null,
      acknowledged_at: null,
      accepted_at: null,
      ended_at: null,
      handoff_reason: null,
      source_refs: [],
    });
    setFollowup(
      s,
      t,
      { event_id: 'seed', event_type: 'seed', actor_key: 'system', occurred_at: monday, payload: {} },
      policy,
    );
    s.tasks[id] = t;
  }
  return s;
}

it('a week of five-minute cron ticks does not grow the ledger with tick events', () => {
  let s: Ledger = waitingTasks(5);
  const start = JSON.stringify(s).length;
  let reduced = 0;
  for (let tick = 0; tick < 7 * 288; tick++) {
    const now = new Date(Date.parse(monday) + tick * 300000).toISOString();
    // Same pre-check as ProjectAgent.tick(): only tasks that are actually due reach the reducer.
    for (const t of Object.values(s.tasks))
      if (followupDue(s, t, now, policy)) {
        reduced++;
        s = reduce(
          s,
          {
            event_id: `timer:${t.task_id}:${t.revision}:${now.slice(0, 16)}`,
            event_type: 'timer_fired',
            actor_key: 'system',
            occurred_at: now,
            payload: { task_id: t.task_id, expected_revision: t.revision },
          },
          policy,
        );
      }
  }
  expect(Object.keys(s.events)).toHaveLength(0);
  // Two reminders per task per workday (cooldown + daily cap): 5 tasks x 5 workdays x 2.
  expect(reduced).toBe(50);
  expect(Object.values(s.outbox).filter((e) => e.request.purpose === 'followup')).toHaveLength(50);
  // Growth follows the reminders actually planned, not the 2,016 ticks (previously ~400 KB per day).
  expect(JSON.stringify(s).length - start).toBeLessThan(50 * 4000);
});

function busyProject() {
  const s = emptyLedger(policy.project_id);
  for (let i = 1; i <= 80; i++) {
    const issue = i % 2 ? 'issue_hot' : `issue_${i}`;
    s.issues[issue] ??= newIssue(issue, s.project_id);
    const t = newTask(`TASK-${String(i).padStart(5, '0')}`, issue, s.project_id, {
      title: `任务 ${i} ` + '标题'.repeat(30),
      deliverable: '交付物说明'.repeat(60),
      state: 'pending_acceptance',
      primary_owner_key: 'owner',
    });
    s.tasks[t.task_id] = t;
    s.issues[issue].task_ids.push(t.task_id);
  }
  for (let i = 0; i < 400; i++)
    observeSource(s, {
      event_id: `m${i}`,
      event_type: 'source_message_observed',
      actor_key: 'owner',
      occurred_at: monday,
      source_event_id: `om_${i}`,
      source_revision: 'r1',
      payload: { text: `消息 ${i} ` + '讨论内容'.repeat(400) },
    });
  return s;
}

it('the analysis input always fits the budget and keeps the current message and related tasks first', () => {
  const { routing } = loadConfig();
  const s = busyProject();
  const current: Command = {
    event_id: 'current',
    event_type: 'feedback_observed',
    actor_key: 'owner',
    occurred_at: monday,
    source_event_id: 'om_current',
    payload: { text: '当前反馈 ' + '复现细节'.repeat(1500), issue_id: 'issue_hot' },
  };
  observeSource(s, current);
  const full = s.source_items[Object.keys(s.source_items).at(-1)!].text;
  for (const budget of [30000, 60000, 120000]) {
    const input = contextFor(s, current, routing, budget);
    expect(JSON.stringify(input).length).toBeLessThanOrEqual(budget);
    expect(input.current_source_items[0].text).toBe(full);
    const tasks = input.current_assignments as { related: boolean }[];
    expect(tasks.length).toBeGreaterThan(0);
    // Unrelated tasks are only present when every kept related task fits too.
    if (tasks.some((t) => !t.related)) expect(tasks.filter((t) => t.related)).toHaveLength(20);
  }
});

it('an enormous message is shortened only as a last resort, and marked as truncated', () => {
  const { routing } = loadConfig();
  const s = emptyLedger(policy.project_id);
  const huge: Command = {
    event_id: 'huge',
    event_type: 'feedback_observed',
    actor_key: 'owner',
    occurred_at: monday,
    source_event_id: 'om_huge',
    payload: { text: '开头说明。' + '日志'.repeat(30000) },
  };
  observeSource(s, huge);
  const input = contextFor(s, huge, routing, 20000);
  expect(JSON.stringify(input).length).toBeLessThanOrEqual(20000);
  expect(input.current_source_items[0]).toMatchObject({ truncated: true });
  expect(input.current_source_items[0].text.startsWith('开头说明。')).toBe(true);
});
