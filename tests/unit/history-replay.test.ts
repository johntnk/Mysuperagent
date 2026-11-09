import { describe, it, expect, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { normalizeHistory } from '../../src/replay/source';
import {
  applyDecision,
  initialReplayState,
  nextTrigger,
  observerInput,
  prepareTrigger,
  validateDecision,
  OpenAIHistoryPlanner,
  quarantinedDecision,
  type HistoryDecision,
} from '../../src/replay/observer';
import { estimatedPrice } from '../../src/replay/pricing';
import { emptyProposal } from '../../src/analysis/planner';
import { ReplayStore } from '../../src/replay/store';
import { writeReplayReport } from '../../src/replay/report';
const at = (n: number) => new Date(Date.UTC(2026, 7, 24, 6, n)).toISOString();
const row = (id: string, text: string, minute: number, extra: any = {}) => ({
  message_id: id,
  create_time: String(Date.parse(at(minute))),
  update_time: String(Date.parse(at(minute))),
  updated: false,
  msg_type: 'text',
  sender: { id: 'p1' },
  body: { content: JSON.stringify({ text }) },
  ...extra,
});
const decision = (): HistoryDecision => ({
  emit: false,
  utterance: '',
  reason: '已有真人讨论，暂时记录。',
  evidence_refs: [],
  role_observations: [],
  task_reports: [],
  proposal: emptyProposal(),
  next_check_at: null,
  next_check_reason: null,
});
function prepare(rows: any[]) {
  const events = normalizeHistory(rows);
  let state = initialReplayState();
  for (const event of events) state = prepareTrigger(state, { kind: 'message', event });
  const trigger = { kind: 'message' as const, event: events.at(-1)! };
  return { state, trigger, input: observerInput(state, trigger), events };
}

describe('historical replay isolation', () => {
  it('starts with no people, and future identity/role changes cannot alter an earlier input', () => {
    expect(initialReplayState().people).toEqual({});
    const source = [
      row('m1', '客户端需要接入。', 0),
      row('m2', '我负责模型。', 5, { sender: { id: 'p2' }, mentions: [{ id: 'p3', name: '未来负责人' }] }),
    ];
    const first = normalizeHistory(source)[0],
      state = prepareTrigger(initialReplayState(), { kind: 'message', event: first });
    const before = observerInput(state, { kind: 'message', event: first });
    source[1].body.content = JSON.stringify({ text: '未来决定：取消' });
    const another = normalizeHistory(source)[0];
    expect(
      observerInput(prepareTrigger(initialReplayState(), { kind: 'message', event: another }), {
        kind: 'message',
        event: another,
      }),
    ).toEqual(before);
    expect(Object.keys(state.people)).toEqual(['p1']);
    expect(JSON.stringify(before)).not.toContain('未来');
  });
  it('does not expose edited text until its revision time and preserves older known versions', () => {
    const late = row('m1', '后来才添加的结论', 0, { updated: true, update_time: String(Date.parse(at(10))) });
    const events = normalizeHistory([late, row('m2', '先前讨论', 5)]);
    expect(events.map((x) => x.message_id)).toEqual(['m2', 'm1']);
    expect(events[1].available_at).toBe(at(10));
    expect(events[1].limitations).toContain('original_revision_unavailable_body_delayed_until_update');
    const versions = normalizeHistory([{ versions: [row('m1', '初稿', 0), late] }]);
    expect(versions.map((x) => x.text)).toEqual(['初稿', '后来才添加的结论']);
  });
  it('rejects future citations, invented people and unsupported responsibility quotes', () => {
    const { state, input } = prepare([row('m1', '我来处理客户端。', 0)]);
    const d = decision();
    d.evidence_refs = ['future'];
    expect(() => validateDecision(state, input, d)).toThrow('replay_unseen_evidence');
    d.evidence_refs = [];
    d.role_observations = [
      {
        person_key: 'p2',
        responsibility: '模型',
        certainty: 'explicit',
        evidence: { event_id: state.seen[0].event_id, quote: '我来处理客户端。' },
      },
    ];
    expect(() => validateDecision(state, input, d)).toThrow('replay_unknown_person');
    d.role_observations[0].person_key = 'p1';
    d.role_observations[0].evidence.quote = '我是项目总负责人';
    expect(() => validateDecision(state, input, d)).toThrow('replay_unbound_quote');
  });
  it('links names only at the message containing the actual identity binding', () => {
    const events = normalizeHistory([
      row('m1', '', 0, {
        msg_type: 'system',
        sender: {},
        body: { content: JSON.stringify({ template: 'invite', to_chatters: ['小林'] }) },
      }),
      row('m2', '@_user_1 请看客户端', 1, { mentions: [{ id: 'p2', name: '小林', key: '@_user_1' }] }),
    ]);
    const a = prepareTrigger(initialReplayState(), { kind: 'message', event: events[0] });
    expect(a.people['name:小林']).toBeDefined();
    expect(a.people.p2).toBeUndefined();
    const b = prepareTrigger(a, { kind: 'message', event: events[1] });
    expect(b.people.p2.name).toBe('小林');
    expect(b.people['name:小林']).toBeUndefined();
    expect(b.people.p2.roles).toEqual([]);
  });
  it('keeps hypothetical outputs out of source messages and historical acknowledgement out of task acceptance', () => {
    const { state, trigger, input } = prepare([row('m1', '我来处理客户端。', 0)]);
    const d = decision(),
      ref = state.seen[0].event_id;
    d.emit = true;
    d.utterance = 'SIMULATED_ONLY 请提交交付版本。';
    d.evidence_refs = [ref];
    d.proposal.decision_type = 'create_issue';
    d.proposal.fact_refs = [ref];
    d.proposal.proposed_task_changes = [
      {
        task_id: null,
        kind: 'implementation',
        title: '客户端接入',
        objective: '客户端接入',
        deliverable: '可测客户端',
        primary_owner_key: 'p1',
        collaborator_keys: [],
        qa_owner_key: null,
      },
    ];
    const a = applyDecision(state, trigger, validateDecision(state, input, d));
    expect(Object.keys(a.ledger.tasks)).toEqual(['TASK-00001']);
    expect(Object.values(a.ledger.outbox).every((x) => x.state === 'blocked')).toBe(true);
    const event = normalizeHistory([row('m2', '收到', 1)])[0],
      b = prepareTrigger(a, { kind: 'message', event });
    const reply = decision();
    reply.task_reports = [
      {
        task_id: 'TASK-00001',
        title: '客户端接入',
        kind: 'acknowledged',
        summary: '历史中回复收到',
        scope: '原聊天语境',
        evidence: { event_id: event.event_id, quote: '收到' },
      },
    ];
    const c = applyDecision(
      b,
      { kind: 'message', event },
      validateDecision(b, observerInput(b, { kind: 'message', event }), reply),
    );
    expect(c.ledger.tasks['TASK-00001'].state).toBe('pending_acceptance');
    expect(Object.values(c.ledger.assignments)[0].status).toBe('proposed');
    expect(JSON.stringify(observerInput(c, { kind: 'message', event }))).not.toContain('SIMULATED_ONLY');
    expect(c.seen).toHaveLength(2);
  });
  it('uses historical timers before the next message without reading that message', () => {
    const { state, trigger } = prepare([row('m1', '等接口说明', 0)]);
    const d = decision();
    d.next_check_at = at(5);
    d.next_check_reason = '等待接口说明';
    const a = applyDecision(state, trigger, d),
      future = normalizeHistory([row('m2', '未来秘密', 10)])[0],
      timer = nextTrigger(a, future);
    expect(timer.kind).toBe('timer');
    const b = prepareTrigger(a, timer);
    expect(b.now).toBe(at(5));
    expect(b.cursor).toBe(1);
    expect(JSON.stringify(observerInput(b, timer))).not.toContain('未来秘密');
  });
  it('does not treat claimed delivery or sampled QA as formal acceptance', () => {
    const { state, input, trigger } = prepare([row('m1', '舞蹈抽样验收通过，融合还待测试。', 0)]);
    const d = decision();
    d.task_reports = [
      {
        task_id: null,
        title: '舞蹈',
        kind: 'qa_claimed',
        summary: '只报告舞蹈抽样通过',
        scope: '抽样；融合未验收',
        evidence: { event_id: state.seen[0].event_id, quote: state.seen[0].text },
      },
    ];
    const s = applyDecision(state, trigger, validateDecision(state, input, d));
    expect(s.task_reports[0].scope).toContain('融合未验收');
    expect(s.ledger.qa_reports).toHaveLength(0);
  });
  it('has a single official model destination, no tools, no stored conversation and no supplied routing preload', async () => {
    const { input } = prepare([row('m1', '测试', 0)]),
      transport = vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              id: 'resp_1',
              model: 'gpt-6-astra',
              status: 'completed',
              usage: { input_tokens: 10, output_tokens: 20 },
              output: [
                { type: 'message', content: [{ type: 'output_text', text: JSON.stringify(decision()) }] },
              ],
            }),
            { status: 200 },
          ),
      );
    const planner = new OpenAIHistoryPlanner(
      {
        apiKey: 'test-only',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-6-astra',
        maxOutputTokens: 4000,
      },
      transport as typeof fetch,
    );
    const result = await planner.plan(input, new AbortController().signal);
    expect(result.usage.output_tokens).toBe(20);
    const [url, request] = transport.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(request.body as string);
    expect(url).toBe('https://api.openai.com/v1/responses');
    expect(body.store).toBe(false);
    expect(body.tools).toBeUndefined();
    expect(body.previous_response_id).toBeUndefined();
    expect(request.redirect).toBe('error');
    expect(body.service_tier).toBe('default');
  });
  it('persists checkpoint and decisions atomically and makes local reports with escaped content', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'history-test-'));
    try {
      const { state, trigger, input } = prepare([row('m1', '</script><script>bad()</script>', 0)]),
        d = decision();
      let store = new ReplayStore(dir);
      const id = store.startAttempt(input, 0.1);
      const step = {
        number: 1,
        trigger,
        at: state.now!,
        decision: d,
        input,
        input_sha256: 'hash',
        usage: { input_tokens: 10, output_tokens: 20, cached_input_tokens: 0 },
        estimated_cost_usd: 0.002,
        response_id: 'resp',
        model: 'gpt-6-astra',
        latency_ms: 1,
        created_task_ids: [],
        people_count: 1,
        task_count: 0,
      };
      store.saveStep(id, step, state);
      store.close();
      store = new ReplayStore(dir);
      expect(store.checkpoint()?.cursor).toBe(1);
      expect(store.steps()).toHaveLength(1);
      expect(store.usedCost()).toBe(0.002);
      await writeReplayReport(dir, store.steps(), state, {
        processed_source_events: 1,
        model: 'gpt-6-astra',
      });
      store.close();
      expect(await readFile(join(dir, 'outputs.jsonl'), 'utf8')).toBe('');
      expect(await readFile(join(dir, 'report.html'), 'utf8')).not.toContain('</script><script>bad()');
      expect((await readFile(join(dir, 'source-events.jsonl'), 'utf8')).trim().split('\n')).toHaveLength(1);
    } finally {
      if (dirname(resolve(dir)) !== resolve(tmpdir()) || !basename(dir).startsWith('history-test-'))
        throw new Error('test_cleanup_path_invalid');
      await rm(dir, { recursive: true, force: true });
    }
  });
  it('prices cached input once, handles long context, and refuses unknown rates', () => {
    const usage = { input_tokens: 140884, output_tokens: 12168, cached_input_tokens: 27778 };
    expect(estimatedPrice('gpt-6-astra', usage)).toBeCloseTo(1.767238, 8);
    expect(estimatedPrice('gpt-6-luna', usage)).toBeCloseTo(0.01767238, 8);
    expect(
      estimatedPrice('gpt-6-luna', { input_tokens: 300000, output_tokens: 10000, cached_input_tokens: 0 }),
    ).toBeCloseTo(0.0675, 8);
    expect(() => estimatedPrice('unknown', usage)).toThrow('REPLAY_MODEL_PRICING_NOT_CONFIGURED');
    expect(() =>
      estimatedPrice('gpt-6-luna', { input_tokens: 10, output_tokens: 5, cached_input_tokens: 20 }),
    ).toThrow('invalid_model_usage');
  });
  it('records an invalid response without applying roles, tasks or a simulated message', async () => {
    const { state, trigger } = prepare([row('m1', '工作讨论', 0)]),
      next = applyDecision(state, trigger, quarantinedDecision('replay_unseen_evidence'));
    expect(next.cursor).toBe(1);
    expect(next.ledger.tasks).toEqual({});
    expect(next.last_output).toBeNull();
    expect(Object.values(next.people)[0].roles).toEqual([]);
    const dir = await mkdtemp(join(tmpdir(), 'history-test-'));
    try {
      const store = new ReplayStore(dir),
        input = { safe: 'current source only' },
        id = store.startAttempt(input, 0.01);
      store.failAttempt(id, 'network_timeout', null, { response_id: null });
      expect(store.attempts()[0].record.input).toEqual(input);
      expect(store.usedCost()).toBe(0.01);
      store.close();
    } finally {
      if (dirname(resolve(dir)) !== resolve(tmpdir()) || !basename(dir).startsWith('history-test-'))
        throw new Error('test_cleanup_path_invalid');
      await rm(dir, { recursive: true, force: true });
    }
  });
});
