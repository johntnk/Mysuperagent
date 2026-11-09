import { it, expect } from 'vitest';
import {
  initialReplayState,
  prepareTrigger,
  applyDecision,
  validateDecision,
  observerInput,
  nextTrigger,
  type HistoryDecision,
} from '../../src/replay/observer';
import { normalizeHistory } from '../../src/replay/source';
import { emptyProposal } from '../../src/analysis/planner';
const event = (id: string, text: string, minute: number) =>
  normalizeHistory([
    {
      message_id: id,
      create_time: String(Date.UTC(2026, 8, 24, 12, minute)),
      update_time: String(Date.UTC(2026, 8, 24, 12, minute)),
      msg_type: 'text',
      sender: { id: 'p1' },
      body: { content: JSON.stringify({ text }) },
    },
  ])[0];
const quiet = (): HistoryDecision => ({
  emit: false,
  utterance: '',
  reason: '记录',
  evidence_refs: [],
  role_observations: [],
  task_reports: [],
  proposal: emptyProposal(),
  next_check_at: null,
  next_check_reason: null,
});
it('an unrelated quiet message cannot erase a scheduled historical check', () => {
  const a = event('a', '明天下午检查交付', 0),
    d = quiet();
  d.next_check_at = '2026-09-25T10:00:00.000Z';
  d.next_check_reason = '核对交付';
  const planned = applyDecision(
    prepareTrigger(initialReplayState(), { kind: 'message', event: a }),
    { kind: 'message', event: a },
    d,
  );
  const b = event('b', '补充一个文档链接', 1),
    next = applyDecision(
      prepareTrigger(planned, { kind: 'message', event: b }),
      { kind: 'message', event: b },
      quiet(),
    );
  expect(next.next_check?.at).toBe(d.next_check_at);
});
it('numbered feedback retains every source item before a model decides to speak', () => {
  const a = event('list', '1. 转三圈只转一次\n2. 角色朝向错误\n3. 当前TTS作为保底', 0);
  const state = prepareTrigger(initialReplayState(), { kind: 'message', event: a });
  expect(Object.values((state.ledger as any).source_items ?? {})).toHaveLength(3);
});
it('an unbound nickname claim is held separately without losing independent historical facts', () => {
  const known = event('known', '先记录人员', 0);
  let state = prepareTrigger(initialReplayState(), { kind: 'message', event: known });
  const a = {
    ...event('nickname', '强哥负责模型；外部任务 https://project.example.invalid/p/1000001 已交付', 1),
    sender_id: 'p2',
  };
  state = prepareTrigger(state, { kind: 'message', event: a });
  const d = quiet();
  d.role_observations = [
    {
      person_key: 'p1',
      responsibility: '模型',
      certainty: 'inferred',
      evidence: { event_id: a.event_id, quote: '强哥负责模型' },
    },
  ];
  d.task_reports = [
    {
      task_id: '1000001',
      title: '外部任务',
      kind: 'delivery_claimed',
      summary: '原文报告交付',
      scope: '未提供回归证据',
      evidence: { event_id: a.event_id, quote: '已交付' },
    },
  ];
  const input = observerInput(state, { kind: 'message', event: a });
  state = applyDecision(state, { kind: 'message', event: a }, validateDecision(state, input, d));
  expect(state.people.p1.roles).toHaveLength(0);
  expect(state.unresolved_roles).toHaveLength(1);
  expect(state.task_reports[0]).toMatchObject({ task_id: null, external_task_ref: '1000001' });
  d.task_reports[0].task_id = 'forged';
  expect(() => validateDecision(state, input, d)).toThrow('replay_unknown_task');
});
it('multiple reminders survive restart and fire independently without future input or clock reversal', () => {
  const a = event('wait', '待两个交付', 0);
  let s = prepareTrigger(initialReplayState(), { kind: 'message', event: a });
  const item = Object.values(s.ledger.source_items)[0];
  const d = quiet();
  d.proposal.coordination = {
    tasks: [],
    reports: [],
    dispositions: [
      {
        item_id: item.item_id,
        category: 'context',
        task_keys: [],
        related_item_id: null,
        reason: '等待记录',
        expected_behavior: null,
        observed_behavior: null,
        resource_refs: [],
      },
    ],
    reminders: [1, 2].map((n) => ({
      action: 'set',
      key: `check-${n}`,
      task_key: null,
      expected_task_revision: null,
      at: `2026-09-24T12:0${n}:00.000Z`,
      reason: `检查${n}`,
      source_item_ids: [item.item_id],
    })),
  };
  s = JSON.parse(JSON.stringify(applyDecision(s, { kind: 'message', event: a }, d)));
  const future = event('future', '未来秘密', 10);
  const one = nextTrigger(s, future);
  expect(one.kind).toBe('timer');
  s = prepareTrigger(s, one);
  expect(s.ledger.reminders['check-1'].state).toBe('fired');
  const two = nextTrigger(s, future);
  expect(two.kind).toBe('timer');
  s = prepareTrigger(s, two);
  expect(s.ledger.reminders['check-2'].state).toBe('fired');
  expect(nextTrigger(s, future).kind).toBe('message');
  expect(JSON.stringify(observerInput(s, two))).not.toContain('未来秘密');
});
