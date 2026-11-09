import { it, expect } from 'vitest';
import { emptyLedger, type Command } from '../../src/domain/contracts';
import { reduce, drainFake } from '../../src/domain/engine';
import { localPolicy } from '../../src/policy';
import { bindMessage, correlateConversation, decorateMessageEffects } from '../../src/conversation';
import { loadConfig, readiness } from '../../src/config';
const c = (id: string, type: string, payload: any, actor = 'system'): Command => ({
  event_id: id,
  event_type: type,
  actor_key: actor,
  occurred_at: '2030-01-07T10:00:00+08:00',
  payload,
});
it.each([null, undefined])(
  'split tasks do not inherit a different task owner from global suggestions (%s)',
  (unassigned) => {
    const p = {
      ...localPolicy(),
      mode: 'observe' as const,
      transport: 'real' as const,
      identities: { animation_owner: { id: 'ou_animation', verified: true, synthetic: false } },
    };
    let s = reduce(
      emptyLedger(p.project_id),
      c('split-source', 'feedback_observed', {
        case_id: 'case_split',
        text: '双请求协议需要改造；动画素材由动画同学提供。',
      }),
      p,
    );
    s = reduce(
      s,
      c('split-plan', 'analysis_completed', {
        decision_type: 'split_tasks',
        suggested_owner_keys: ['animation_owner'],
        proposed_task_changes: [
          {
            kind: 'implementation',
            title: '双请求协议',
            primary_owner_key: unassigned,
            deliverable: '协议实现',
          },
          {
            kind: 'implementation',
            title: 'Loop 素材',
            primary_owner_key: 'animation_owner',
            deliverable: '多版本动画',
          },
        ],
      }),
      p,
    );
    const tasks = Object.values(s.tasks),
      protocol = tasks.find((t) => t.title === '双请求协议')!,
      animation = tasks.find((t) => t.title === 'Loop 素材')!;
    expect(protocol.primary_owner_key).toBeNull();
    expect(protocol.state).toBe('needs_clarification');
    expect(protocol.assignment_id).toBeNull();
    expect(animation.primary_owner_key).toBe('animation_owner');
    expect(animation.state).toBe('pending_acceptance');
    expect(Object.values(s.assignments)).toHaveLength(1);
    expect(Object.values(s.assignments)[0].task_id).toBe(animation.task_id);
    expect(
      Object.values(s.outbox).filter(
        (e) => e.task_id === protocol.task_id && e.capability.startsWith('message'),
      ),
    ).toHaveLength(0);
  },
);
it('internal task backend in observe persists genuine task records while keeping messages unsent', () => {
  const p = {
    ...localPolicy(),
    mode: 'observe' as const,
    transport: 'real' as const,
    identities: { owner: { id: 'ou_verified', verified: true, synthetic: false } },
  };
  let s = emptyLedger(p.project_id);
  s = reduce(
    s,
    c('issue', 'feedback_observed', {
      case_id: 'case_a',
      text: '动作反馈',
      source_message_id: 'om_source',
      source_chat_id: 'oc_group',
    }),
    p,
  );
  s = reduce(
    s,
    c('plan', 'analysis_completed', {
      decision_type: 'assign_task',
      proposed_task_changes: [
        {
          task_id: 'R-1',
          kind: 'diagnosis',
          primary_owner_key: 'owner',
          deliverable: '核对动作数量',
          qa_owner_key: 'qa',
        },
      ],
    }),
    p,
  );
  expect(s.tasks['TASK-00001'].external_record).toEqual({
    platform: 'agent_ledger',
    record_id: 'TASK-00001',
    synthetic: false,
  });
  expect(Object.values(s.outbox).some((e) => e.capability.startsWith('work_item'))).toBe(false);
  expect(Object.values(s.outbox)[0].state).toBe('blocked');
  const { config, routing } = loadConfig();
  const missing = readiness(config, routing, {}).missing;
  expect(missing.some((x) => x.startsWith('feishuProject') || x.startsWith('fieldMappings'))).toBe(false);
});
it('original group thread routes ack, explicit acceptance and delivery without guessing QA', () => {
  const p = localPolicy();
  let s = emptyLedger(p.project_id);
  s = reduce(
    s,
    c('source', 'feedback_observed', {
      case_id: 'case_a',
      text: '反馈',
      source_message_id: 'om_source',
      source_chat_id: 'oc_group',
    }),
    p,
  );
  s = reduce(
    s,
    c('plan', 'analysis_completed', {
      decision_type: 'assign_task',
      proposed_task_changes: [
        {
          task_id: 'R-1',
          kind: 'diagnosis',
          primary_owner_key: 'owner',
          deliverable: '报告',
          qa_owner_key: 'qa',
        },
      ],
    }),
    p,
  );
  decorateMessageEffects(s, p, 'oc_group');
  s = drainFake(s, p);
  bindMessage(s, 'om_task_message', 'R-1');
  const reply = (id: string, text: string) =>
    c(id, 'feedback_observed', { text, source_parent_message_id: 'om_task_message' }, 'owner');
  s = reduce(s, correlateConversation(s, reply('ack', '收到'), p), p);
  expect(s.tasks['R-1'].state).toBe('pending_acceptance');
  s = reduce(s, correlateConversation(s, reply('accept', '我接手'), p), p);
  expect(s.tasks['R-1'].state).toBe('in_progress');
  s = reduce(s, correlateConversation(s, reply('delivered', '修改完成'), p), p);
  expect(s.tasks['R-1'].state).toBe('in_progress');
  expect(s.tasks['R-1'].delivery).toBeTruthy();
  expect(s.issues.issue_a.lifecycle).toBe('open');
});
it('an ambiguous shared thread does not assign a reply to either task', () => {
  const p = localPolicy();
  let s = emptyLedger(p.project_id);
  for (const id of ['a', 'b'])
    s = reduce(s, c(id, 'assignment_requested', { task_id: id, owner_key: 'owner' }, 'coordinator'), p);
  bindMessage(s, 'om_shared', 'a');
  bindMessage(s, 'om_shared', 'b');
  expect(
    correlateConversation(
      s,
      c('reply', 'feedback_observed', { source_parent_message_id: 'om_shared', text: '我接手' }, 'owner'),
      p,
    ).event_type,
  ).toBe('feedback_observed');
});
it('quoted acceptance and unbound actor do not acquire authority', () => {
  const p = localPolicy();
  let s = reduce(
    emptyLedger(p.project_id),
    c('a', 'assignment_requested', { task_id: 'a', owner_key: 'owner' }, 'coordinator'),
    p,
  );
  bindMessage(s, 'om_a', 'a');
  expect(
    correlateConversation(
      s,
      c('b', 'feedback_observed', { source_parent_message_id: 'om_a', text: '他说“我接手”' }, 'owner'),
      p,
    ).event_type,
  ).toBe('feedback_observed');
  expect(
    correlateConversation(
      s,
      c('d', 'feedback_observed', { source_parent_message_id: 'om_a', text: '我接手' }, 'stranger'),
      p,
    ).event_type,
  ).toBe('feedback_observed');
});
it('explicit task references work outside threads; owner block notes never clear an external dependency', () => {
  const p = localPolicy();
  let s = emptyLedger(p.project_id);
  s = reduce(
    s,
    c('task', 'assignment_requested', { task_id: 'TASK-00001', owner_key: 'owner' }, 'coordinator'),
    p,
  );
  const reply = (id: string, text: string) =>
    correlateConversation(s, c(id, 'feedback_observed', { text }, 'owner'), p);
  s = reduce(s, reply('accept', 'TASK-00001 我接手'), p);
  s = reduce(s, reply('block', 'TASK-00001 阻塞：等待参数确认'), p);
  expect(s.tasks['TASK-00001'].state).toBe('blocked');
  s.tasks['TASK-00001'].dependencies.push({
    dependency_id: 'artifact',
    kind: 'artifact',
    target_ref: 'ssml',
    required_condition: 'available',
    expected_version: 'v2',
    provider_owner_key: 'provider',
    status: 'waiting',
    source_ref: null,
    observed_at: null,
  });
  s = reduce(s, reply('unblock', 'TASK-00001 阻塞已解除'), p);
  expect(s.tasks['TASK-00001'].state).toBe('blocked');
  expect(s.tasks['TASK-00001'].dependencies.find((d) => d.dependency_id === 'artifact')?.status).toBe(
    'waiting',
  );
  s = reduce(
    s,
    c(
      'wrong-version',
      'dependency_confirmed_by_human',
      { task_id: 'TASK-00001', dependency_id: 'artifact', version: 'v1', evidence_ref: 'fixture-artifact' },
      'provider',
    ),
    p,
  );
  expect(s.tasks['TASK-00001'].state).toBe('blocked');
  s = reduce(
    s,
    c(
      'artifact-delivered',
      'dependency_confirmed_by_human',
      { task_id: 'TASK-00001', dependency_id: 'artifact', version: 'v2', evidence_ref: 'fixture-artifact' },
      'provider',
    ),
    p,
  );
  expect(s.tasks['TASK-00001'].state).toBe('in_progress');
});
it('confirmed message delivery never replaces the internal task backend during reconciliation', () => {
  const p = localPolicy();
  let s = reduce(
    emptyLedger(p.project_id),
    c('task', 'assignment_requested', { task_id: 'TASK-00001', owner_key: 'owner' }, 'coordinator'),
    p,
  );
  const operation = Object.values(s.outbox)[0];
  operation.state = 'unknown';
  const original = s.tasks['TASK-00001'].external_record;
  s = reduce(
    s,
    c('reconcile', 'reconciliation_result', {
      operation_id: operation.operation_id,
      authoritative: true,
      result: 'found_one',
      record_ref: 'om_verified',
      evidence_ref: 'fixture-manual-check',
    }),
    p,
  );
  expect(s.tasks['TASK-00001'].external_record).toEqual(original);
  expect(s.outbox[operation.operation_id].state).toBe('succeeded');
  expect(s.subscriptions['message:om_verified:TASK-00001'].task_id).toBe('TASK-00001');
});
