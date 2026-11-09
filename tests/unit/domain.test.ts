import { it, expect } from 'vitest';
import { emptyLedger, newTask, newIssue, type Command } from '../../src/domain/contracts';
import { reduce, drainFake, planEffect } from '../../src/domain/engine';
import { localPolicy, effectBlock } from '../../src/policy';
import { assertAcyclic } from '../../src/domain/rules';
import { loadConfig } from '../../src/config';
import scenarios from '../../fixtures/scenarios.json';
import { scenarioSeed, type Scenario } from '../scenario-harness';
const event = (type: string, payload: any, actor = 'coordinator'): Command => ({
  event_id: crypto.randomUUID(),
  event_type: type,
  actor_key: actor,
  occurred_at: '2030-01-07T10:00:00+08:00',
  payload,
});
it('credentials never enable real adapters; unknown/mismatched modes fail', () => {
  expect(
    loadConfig({ MODEL_API_KEY: 'not-a-real-secret', FEISHU_APP_SECRET: 'not-a-real-secret' }).policy
      .transport,
  ).toBe('fake');
  expect(() => loadConfig({ MODE: 'pilot' })).toThrow('MODE_CONFIG_MISMATCH');
});
it('rejects dependency cycles and missing targets remain unsatisfied', () => {
  const a = newTask('a', 'i', 'p'),
    b = newTask('b', 'i', 'p');
  const dep = (id: string) => ({
    dependency_id: id,
    kind: 'task' as const,
    target_ref: id,
    required_condition: 'verified',
    expected_version: null,
    provider_owner_key: null,
    status: 'waiting' as const,
    observed_at: null,
    source_ref: null,
  });
  a.dependencies = [dep('b')];
  b.dependencies = [dep('a')];
  expect(() => assertAcyclic({ a, b })).toThrow('dependency_cycle');
});
it('independent issues: one cancelled never stalls the other accepted issue', () => {
  const p = localPolicy();
  let s = emptyLedger(p.project_id);
  for (const id of ['a', 'b'])
    s = drainFake(
      reduce(
        s,
        event('assignment_requested', { task_id: id, issue_id: `i_${id}`, owner_key: 'owner', summary: id }),
        p,
      ),
      p,
    );
  s = reduce(s, event('manual_cancel', { task_id: 'a', expected_revision: 1, reason: 'scope cancelled' }), p);
  s = reduce(s, event('human_acceptance', { task_id: 'b', scope_revision: 1 }, 'owner'), p);
  expect(s.tasks.a.state).toBe('cancelled');
  expect(s.tasks.b.state).toBe('in_progress');
  expect(s.tasks.b.external_record?.platform).toBe('agent_ledger');
  expect(s.fake.creates).toBe(0);
});
it('mode downgrade and old mock proposals cannot flush to real pilot', () => {
  const p = localPolicy();
  let s = emptyLedger(p.project_id);
  const e = planEffect(s, p, event('external_effect_requested', {}), {
    operation_id: 'op',
    capability: 'message.send',
  });
  expect(effectBlock({ ...p, mode: 'pilot', transport: 'real', environment: 'test' }, e)).toBe(
    'planned_mode_changed',
  );
  expect(effectBlock({ ...p, mode: 'observe', transport: 'real' }, { ...e, planned_mode: 'observe' })).toBe(
    'observe_read_only',
  );
});
it('failed QA preserves failure record and returns the task to implementation', () => {
  const sc = scenarios.scenarios.find((s) => s.id === 'S11') as unknown as Scenario;
  const { ledger, policy } = scenarioSeed(sc);
  const c = structuredClone(sc.events[0]);
  c.payload.result = 'fail';
  const s = reduce(ledger, c, policy);
  expect(s.tasks.task_s11.state).toBe('in_progress');
  expect(s.qa_reports[0].payload.result).toBe('fail');
  expect(s.issues.issue_s11.lifecycle).toBe('open');
});
it('a later-arriving old human event cannot undo a newer handoff', () => {
  const p = localPolicy();
  let s = emptyLedger(p.project_id);
  s = reduce(s, event('assignment_requested', { task_id: 'a', owner_key: 'owner' }), p);
  s = reduce(
    s,
    event('manual_reassignment', {
      task_id: 'a',
      expected_revision: 1,
      new_owner_key: 'new',
      reason: 'handoff',
    }),
    p,
  );
  s = reduce(
    s,
    {
      ...event('human_reply', { task_id: 'a', interpretation: 'acknowledgement_only' }, 'owner'),
      occurred_at: '2030-01-06T10:00:00+08:00',
    },
    p,
  );
  expect(s.tasks.a.primary_owner_key).toBe('new');
  expect(s.audit.at(-1)?.reason).toBe('late_human_event');
});
it('QA cannot pass without evidence references even if all text labels match', () => {
  const sc = scenarios.scenarios.find((s) => s.id === 'S11') as unknown as Scenario;
  const { ledger, policy } = scenarioSeed(sc);
  const c = structuredClone(sc.events[0]);
  c.payload.evidence_refs = [];
  const s = reduce(ledger, c, policy);
  expect(s.tasks.task_s11.state).toBe('ready_for_qa');
  expect(s.qa_reports[0].reason).toBe('evidence_incomplete');
});
it('one accepted actor cannot declare acceptance for another owner', () => {
  const sc = scenarios.scenarios.find((s) => s.id === 'S07') as unknown as Scenario;
  const { ledger, policy } = scenarioSeed(sc);
  const s = reduce(ledger, { ...sc.events[0], actor_key: 'stranger' }, policy);
  expect(s.tasks.task_s07.state).toBe('pending_acceptance');
  expect(s.audit.at(-1)?.reason).toBe('not_current_owner');
});
