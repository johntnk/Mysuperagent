import { it, expect } from 'vitest';
import { z } from 'zod';
import { seed, submit, cmd, source, emptyPlan, at } from '../coordination-fixture';
import { reduce } from '../../src/domain/engine';
import { validateCoordination } from '../../src/domain/coordination';
import { CoordinationPlan } from '../../src/domain/coordination-schema';
import { HistoryDecision } from '../../src/replay/observer';
const first = (s: any): any => Object.values(s.tasks)[0];
it('quiet registration persists structured cases, acceptance, dependencies and external links; only the owner gets a handoff card', () => {
  const { s, plan } = seed(
    '开发负责修复转圈次数；测试 lab，版本 release_2，等待移动 SSML。https://project.example.invalid/p/1000001',
  );
  const out = submit(s, plan),
    t = first(out);
  expect(out.audit.some((a) => a.type === 'rejected')).toBe(false);
  expect(t.task_id).toBe('TASK-00001');
  expect(t.external_refs).toEqual(['https://project.example.invalid/p/1000001']);
  expect(t.acceptance_spec.version_requirements).toEqual({ service: 'release_2' });
  expect(t.acceptance_spec.case_ids).toHaveLength(1);
  expect(t.dependencies[0]).toMatchObject({
    target_ref: '移动 SSML',
    status: 'waiting',
    provider_owner_key: 'provider',
  });
  // notify=false: no group notice. The named owner still receives a handoff card to confirm or decline.
  expect(Object.values(out.outbox).map((e) => [e.request.purpose, e.target_owner_key])).toEqual([
    ['handoff', 'owner'],
  ]);
  expect(Object.values(out.outbox)[0].request.card).toMatchObject({ kind: 'handoff', task_id: 'TASK-00001' });
  expect(t.state).toBe('pending_acceptance');
});
it('17 separately evidenced items remain 17 cases even when grouped into one task', () => {
  const { s, plan } = seed(Array.from({ length: 17 }, (_, i) => `${i + 1}. 反馈 ${i + 1}`).join('\n'));
  const items = Object.values(s.source_items);
  plan.dispositions = items.map((i) => ({ ...plan.dispositions[0], item_id: i.item_id }));
  const task = plan.tasks[0];
  task.source_item_ids = items.map((i) => i.item_id);
  task.primary_owner_key = null;
  task.owner_evidence = null;
  task.acceptance.versions = [];
  task.dependencies = [];
  const out = submit(s, plan);
  expect(Object.keys(out.tasks)).toHaveLength(1);
  expect(Object.keys(out.cases)).toHaveLength(17);
  expect(first(out).acceptance_spec.case_ids).toHaveLength(17);
  expect(items).toHaveLength(17);
});
it('deduplication and edited-source revisions preserve identity; stale analysis rolls back', () => {
  let { s, p, plan, item } = seed();
  s = submit(s, plan);
  const again = submit(s, plan);
  expect(Object.keys(again.tasks)).toHaveLength(1);
  expect(again.audit.at(-1)?.type).toBe('duplicate_ignored');
  const revised = reduce(s, source('修订：次数问题已重新描述', 'source', 'r2', '2030-01-07T02:01:00Z'), p);
  expect(revised.source_items[item.item_id].observations).toHaveLength(2);
  expect(revised.source_items[item.item_id].text).toContain('修订');
  const stale = submit(revised, emptyPlan(), 'old-run', {
    current_item_ids: [],
    expected_source_revisions: { [item.item_id]: 'r1' },
  });
  expect(stale.audit.at(-1)?.reason).toBe('coordination_stale_source_revision');
  expect(stale.tasks).toEqual(revised.tasks);
  const late = reduce(revised, source('更旧正文', 'source', 'r0', '2030-01-06T02:00:00Z'), p);
  expect(late.source_items[item.item_id].revision).toBe('r2');
});
it('evidence cannot assign a jointly mentioned person or borrow a mention from another numbered item', () => {
  const { s, plan } = seed('1. 开发 资源 一起处理动作问题\n2. 还有次数问题');
  const [a, b] = Object.values(s.source_items);
  plan.tasks[0].owner_evidence = { item_id: a.item_id, quote: a.text };
  plan.tasks[0].acceptance.versions = [];
  const context = {
    items: [a, b],
    current_item_ids: [],
    tasks: {},
    people: ['owner', 'provider', 'qa'],
    now: at,
  };
  expect(() => validateCoordination(plan, context)).toThrow('coordination_owner_subject_unbound');
  expect(b.mentions).toEqual([]);
  plan.tasks[0].source_item_ids = [b.item_id];
  plan.tasks[0].owner_evidence = { item_id: b.item_id, quote: b.text };
  expect(() => validateCoordination(plan, context)).toThrow('coordination_owner_subject_unbound');
});
it('scoped updates change unaccepted fields, while stale revisions and human decisions are protected', () => {
  let { s, p, plan } = seed();
  s = submit(s, plan);
  const id = first(s).task_id;
  const update = structuredClone(plan);
  Object.assign(update.tasks[0], { internal_task_id: id, expected_revision: 1, title: '补齐动作编排' });
  s = submit(s, update, 'update');
  expect(s.tasks[id].title).toBe('补齐动作编排');
  expect(s.tasks[id].revision).toBe(2);
  expect(s.assignments[s.tasks[id].assignment_id!].scope_revision).toBe(2);
  expect(submit(s, update, 'stale').audit.at(-1)?.reason).toBe('coordination_stale_revision');
  s = reduce(
    s,
    cmd(
      'handoff',
      'manual_reassignment',
      { task_id: id, expected_revision: 2, new_owner_key: 'provider', reason: '人工接管' },
      'coordinator',
    ),
    p,
  );
  update.tasks[0].expected_revision = s.tasks[id].revision;
  update.tasks[0].title = '模型覆盖';
  const preserved = submit(s, update, 'after-human');
  expect(preserved.tasks[id].primary_owner_key).toBe('provider');
  expect(preserved.tasks[id].title).toBe('补齐动作编排');
  expect(preserved.audit.some((a) => a.reason === 'scope_update_requires_human_confirmation')).toBe(true);
});
it('historical acceptance and delivery claims are sourced observations, not invented QA', () => {
  let { s, plan, item } = seed();
  s = submit(s, plan);
  const t = first(s),
    update = emptyPlan();
  update.reports = ['accepted', 'delivery_claimed', 'qa_claimed'].map((kind) => ({
    internal_task_id: t.task_id,
    expected_revision: t.revision,
    source_item_id: item.item_id,
    kind: kind as any,
    summary: '原聊天声明',
    scope: '动作本体抽样',
  }));
  s = submit(s, update, 'reports', { current_item_ids: [] });
  expect(first(s).observed_progress).toHaveLength(3);
  expect(first(s).state).toBe('pending_acceptance');
  expect(s.qa_reports).toHaveLength(0);
});
it('missing coverage, external task IDs and dependency cycles cannot partially mutate the ledger', () => {
  const { s, plan } = seed();
  const missing = structuredClone(plan);
  missing.dispositions = [];
  const bad = submit(s, missing);
  expect(bad.audit.at(-1)?.reason).toBe('coordination_source_coverage_incomplete');
  expect(Object.keys(bad.tasks)).toHaveLength(0);
  const foreign = structuredClone(plan);
  foreign.tasks[0].internal_task_id = '1000001';
  foreign.tasks[0].expected_revision = 1;
  expect(submit(s, foreign).audit.at(-1)?.reason).toBe('coordination_unknown_internal_task');
  const cycle = structuredClone(plan);
  cycle.tasks[0].dependencies[0].kind = 'task';
  cycle.tasks[0].dependencies[0].target_ref = 'work';
  expect(submit(s, cycle).audit.at(-1)?.reason).toBe('dependency_cycle');
  expect(Object.keys(submit(s, cycle).tasks)).toHaveLength(0);
});
it('reminders survive unrelated events and JSON restart, and explicit cancellation requires source evidence', () => {
  let { s, p, plan, item } = seed();
  plan.reminders = [
    {
      action: 'set',
      key: 'check',
      task_key: 'work',
      expected_task_revision: null,
      at: '2030-01-08T02:00:00Z',
      reason: '核对交付',
      source_item_ids: [item.item_id],
    },
  ];
  s = submit(s, plan);
  s = JSON.parse(JSON.stringify(reduce(s, source('文档更新', 'other'), p)));
  expect(s.reminders.check.state).toBe('pending');
  const cancel = emptyPlan();
  cancel.reminders = [
    {
      ...plan.reminders[0],
      action: 'cancel',
      task_key: 'TASK-00001',
      expected_task_revision: 1,
      at: null,
      reason: '暂缓',
    },
  ];
  expect(submit(s, cancel, 'bad-cancel', { current_item_ids: [] }).audit.at(-1)?.reason).toBe(
    'coordination_reminder_cancel_evidence_required',
  );
  const decision = source('决定暂缓这一项', 'defer');
  s = reduce(s, decision, p);
  const d = Object.values(s.source_items).find((i) => i.source_id === 'defer')!;
  cancel.dispositions = [
    { ...plan.dispositions[0], item_id: d.item_id, category: 'decision', task_keys: ['TASK-00001'] },
  ];
  cancel.reminders[0].source_item_ids = [d.item_id];
  s = submit(s, cancel, 'cancel', { current_item_ids: [d.item_id] });
  expect(s.reminders.check.state).toBe('cancelled');
});
it('task revision changes invalidate its prior reminder; due checks respect work hours and never double fire', () => {
  let { s, p, plan, item } = seed();
  plan.reminders = [
    {
      action: 'set',
      key: 'check',
      task_key: 'work',
      expected_task_revision: null,
      at: '2030-01-07T03:00:00Z',
      reason: '检查',
      source_item_ids: [item.item_id],
    },
  ];
  s = submit(s, plan);
  const revised = reduce(
    s,
    cmd(
      'reassign',
      'manual_reassignment',
      { task_id: 'TASK-00001', expected_revision: 1, new_owner_key: 'provider', reason: '换人' },
      'coordinator',
    ),
    p,
  );
  expect(revised.reminders.check.state).toBe('cancelled');
  s = reduce(
    s,
    cmd('night', 'coordination_reminder_fired', { reminder_id: 'check' }, 'system', '2030-01-07T15:00:00Z'),
    p,
  );
  expect(s.reminders.check.state).toBe('pending');
  s = reduce(
    s,
    cmd('day', 'coordination_reminder_fired', { reminder_id: 'check' }, 'system', '2030-01-08T02:00:00Z'),
    p,
  );
  expect(s.reminders.check.state).toBe('fired');
  s = reduce(
    s,
    cmd('again', 'coordination_reminder_fired', { reminder_id: 'check' }, 'system', '2030-01-08T02:01:00Z'),
    p,
  );
  expect(Object.values(s.outbox).filter((e) => e.request.purpose === 'followup')).toHaveLength(1);
});
it('model schemas remain closed objects with every property required', () => {
  function visit(x: any) {
    if (!x || typeof x !== 'object') return;
    if (x.type === 'object') {
      expect(x.additionalProperties).toBe(false);
      expect([...(x.required ?? [])].sort()).toEqual(Object.keys(x.properties ?? {}).sort());
    }
    Object.values(x).forEach(visit);
  }
  visit(z.toJSONSchema(CoordinationPlan, { target: 'draft-7' }));
  visit(z.toJSONSchema(HistoryDecision, { target: 'draft-7' }));
});
it('a date-only target preserves stated precision without inventing a reminder time', () => {
  const { s, plan } = seed();
  plan.tasks[0].target_at = '2030-01-09';
  const out = submit(s, plan);
  expect(first(out)?.schedule.target_at).toBe('2030-01-09');
  expect(Object.keys(out.reminders)).toHaveLength(0);
  plan.tasks[0].target_at = '2030-02-31';
  expect(submit(s, plan).audit.at(-1)?.reason).toBe('coordination_invalid_target_date');
});
it('an unrelated decision cannot cancel another task reminder by omitting its binding', () => {
  let { s, p, plan, item } = seed();
  plan.reminders = [
    {
      action: 'set',
      key: 'bound-check',
      task_key: 'work',
      expected_task_revision: null,
      at: '2030-01-08T02:00:00Z',
      reason: '检查',
      source_item_ids: [item.item_id],
    },
  ];
  s = submit(s, plan);
  s = reduce(s, source('取消另一个事项', 'other'), p);
  const other = Object.values(s.source_items).find((i) => i.source_id === 'other')!,
    cancel = emptyPlan();
  cancel.dispositions = [
    { ...plan.dispositions[0], item_id: other.item_id, category: 'decision', task_keys: [] },
  ];
  cancel.reminders = [
    {
      action: 'cancel',
      key: 'bound-check',
      task_key: null,
      expected_task_revision: null,
      at: null,
      reason: '取消',
      source_item_ids: [other.item_id],
    },
  ];
  const out = submit(s, cancel, 'unrelated-cancel', { current_item_ids: [other.item_id] });
  expect(out.audit.at(-1)?.reason).toBe('coordination_reminder_binding_mismatch');
  expect(out.reminders['bound-check'].state).toBe('pending');
});
it('repeated platform mention entries for the same person do not turn one owner into multiple owners', () => {
  const { s, plan, item } = seed();
  s.source_items[item.item_id].mentions.push({ id: 'owner', name: '开发' });
  expect(first(submit(s, plan))?.primary_owner_key).toBe('owner');
});
it('numbering restarted in a second section preserves both sets of source items', () => {
  const { s } = seed('今天：\n1. 修次数\n2. 修朝向\n下周：\n1. 补素材\n2. 补标注');
  const items = Object.values(s.source_items);
  expect(items.filter((i) => i.label !== 'preamble')).toHaveLength(4);
  expect(new Set(items.map((i) => i.item_id)).size).toBe(items.length);
});
it('coordinated tasks retain the existing intake issue and its runtime evidence', () => {
  let { s, p, plan } = seed();
  s = reduce(
    s,
    cmd('intake', 'feedback_observed', {
      case_id: 'case_intake',
      text: '动作次数反馈',
      run_refs: ['trace-existing'],
    }),
    p,
  );
  const issue = Object.values(s.issues)[0];
  s.cases.case_intake.source_event_ids.push('source');
  const out = submit(s, plan, 'plan-with-intake', { issue_id: issue.issue_id });
  expect(first(out)?.issue_id).toBe(issue.issue_id);
  expect(Object.keys(out.issues)).toHaveLength(1);
  expect(out.cases.case_intake.run_refs).toContain('trace-existing');
});
it('a primary assignee and an explicitly named dependency provider remain separate roles', () => {
  const { s, plan, item } = seed('开发负责修复转圈次数，强依赖资源提供移动 SSML；版本 release_2。');
  plan.tasks[0].owner_evidence = { item_id: item.item_id, quote: item.text };
  const out = submit(s, plan);
  expect(first(out)?.primary_owner_key).toBe('owner');
  expect(first(out)?.dependencies[0].provider_owner_key).toBe('provider');
  plan.tasks[0].dependencies = [];
  expect(submit(s, plan).audit.at(-1)?.reason).toBe('coordination_owner_subject_unbound');
});
