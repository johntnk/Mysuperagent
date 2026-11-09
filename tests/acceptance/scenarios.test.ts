import { describe, it, expect, vi } from 'vitest';
import scenarios from '../../fixtures/scenarios.json';
import { runScenario, projection, type Scenario } from '../scenario-harness';
import { TaskState, TaskKind } from '../../src/domain/contracts';
describe('unchanged task-pack acceptance scenarios', () => {
  for (const raw of scenarios.scenarios) {
    const scenario = raw as unknown as Scenario;
    it(`${scenario.id}: ${scenario.title}`, () => {
      const { ledger, initial, policy, checkpoints } = runScenario(scenario);
      const actual = projection(ledger, initial, policy) as Record<string, any>;
      for (const [key, value] of Object.entries(scenario.expected)) {
        if (key === 'checkpoints') continue;
        if (key === 'confirmed_facts_exclude') {
          for (const fact of value) expect(actual.confirmed_facts).not.toContain(fact);
          continue;
        }
        expect(Object.hasOwn(actual, key), `unsupported expected assertion ${key}`).toBe(true);
        if (key.startsWith('max_')) expect(actual[key]).toBeLessThanOrEqual(value);
        else if (key === 'next_condition_not_before') expect(Date.parse(actual[key])).toBe(Date.parse(value));
        else if (Array.isArray(value)) {
          if (!value.length) expect(actual[key]).toEqual([]);
          for (const item of value) {
            if (item && typeof item === 'object') {
              const match = actual[key].find((x: any) =>
                Object.entries(item).every(([k, v]) => (v !== null && typeof v === 'object') || x[k] === v),
              );
              expect(match).toMatchObject(item);
            } else expect(actual[key]).toContain(item);
          }
        } else expect(actual[key]).toEqual(value);
      }
      for (const point of scenario.expected.checkpoints || []) {
        const state = checkpoints[point.after_event_id];
        expect(state).toBeDefined();
        const task = Object.values(state.tasks)[0],
          issue = Object.values(state.issues)[0];
        for (const [key, value] of Object.entries(point))
          if (key !== 'after_event_id') {
            const got: Record<string, unknown> = {
              task_state: task?.state,
              issue_lifecycle: issue?.lifecycle,
              committed_due_at: task?.schedule.committed_due_at,
              fake_messages_sent: state.fake.messages.length,
            };
            expect(Object.hasOwn(got, key)).toBe(true);
            expect(got[key]).toEqual(value);
          }
      }
      // Global invariants at every checkpoint, not just final projections.
      for (const s of Object.values(checkpoints)) {
        for (const t of Object.values(s.tasks)) {
          TaskState.parse(t.state);
          TaskKind.parse(t.kind);
          expect(Array.isArray(t.primary_owner_key)).toBe(false);
        }
        expect(
          Object.values(s.outbox).filter(
            (e) => e.capability.startsWith('internal.') && e.state === 'succeeded',
          ),
        ).toEqual([]);
        expect(new Set(s.fake.messages.map((m) => m.operation_id)).size).toBe(s.fake.messages.length);
      }
      expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    });
  }
});
