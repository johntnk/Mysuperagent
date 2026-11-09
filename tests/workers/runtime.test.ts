import { env, exports as workerExports } from 'cloudflare:workers';
import { runInDurableObject, evictDurableObject, reset, introspectWorkflowInstance } from 'cloudflare:test';
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import type { Env } from '../../src/coordinator';
import { SqliteLedger } from '../../src/storage';
import { newTask, type Ledger } from '../../src/domain/contracts';
import { loadConfig } from '../../src/config';
import { seed, source } from '../coordination-fixture';
import { reduce } from '../../src/domain/engine';
import { emptyProposal } from '../../src/analysis/planner';
const bindings = env as unknown as Env;
const entry = (workerExports as unknown as { default: Fetcher }).default;
const send = async (body: any) =>
  entry.fetch(
    new Request('http://localhost/api/mock/events', { method: 'POST', body: JSON.stringify(body) }),
  );
const event = (id: string, type: string, payload: any, actor = 'system') => ({
  event_id: id,
  event_type: type,
  actor_key: actor,
  occurred_at: '2030-01-07T10:00:00+08:00',
  payload,
});
const stub = () => bindings.PROJECT.get(bindings.PROJECT.idFromName('demo-project'));
const state = async () => (await (await stub().fetch('https://project/state')).json()) as Ledger;
beforeEach(() =>
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('BUSINESS_NETWORK_FORBIDDEN');
    }),
  ),
);
afterEach(async () => {
  vi.unstubAllGlobals();
  await reset();
});
it('structured coordination survives SQLite eviction and proceeds through dependency, delivery and scoped QA', async () => {
  await state();
  await runInDurableObject(stub(), (instance) => {
    const agent = instance as any,
      { routing } = loadConfig(agent.env);
    for (const m of routing.members)
      if (['agent_owner', 'qa_lead', 'retrieval_owner'].includes(m.personKey)) m.enabled = true;
    agent.env = { ...agent.env, ROUTING_CONFIG_JSON: JSON.stringify(routing) };
  });
  const { s: prepared, plan } = seed('开发负责修复转圈次数；测试 lab，版本 release_2；等待 ssml_2。');
  const original = Object.values(prepared.events)[0];
  original.payload.mentions = [{ id: 'agent_owner', name: '开发' }];
  const task = plan.tasks[0];
  task.primary_owner_key = 'agent_owner';
  task.acceptance.qa_owner_key = 'qa_lead';
  Object.assign(task.dependencies[0], {
    provider_owner_key: 'retrieval_owner',
    expected_version: 'ssml_2',
    required_condition: 'available',
  });
  plan.reminders = [
    {
      action: 'set',
      key: 'handoff-check',
      task_key: 'work',
      expected_task_revision: null,
      at: '2030-01-08T02:00:00Z',
      reason: '检查交付',
      source_item_ids: task.source_item_ids,
    },
  ];
  const post = async (id: string, type: string, payload: any, actor = 'system') => {
    const response = await send(event(id, type, payload, actor));
    expect(response.status).toBe(200);
    await response.json();
  };
  const originalResponse = await send(original);
  expect(originalResponse.status).toBe(200);
  await originalResponse.json();
  await post('structured-plan', 'analysis_completed', {
    coordination: plan,
    notify: false,
    current_item_ids: task.source_item_ids,
  });
  await evictDurableObject(stub());
  let s = await state(),
    t = s.tasks['TASK-00001'];
  expect(s.audit.filter((a) => a.type === 'rejected')).toEqual([]);
  expect(t.dependencies[0].expected_version).toBe('ssml_2');
  expect(Object.keys(s.source_items)).toHaveLength(1);
  expect(s.reminders['handoff-check'].state).toBe('pending');
  // notify=false: no group summary; the named owner gets exactly one handoff card.
  expect(s.fake.messages.map((m) => [(m.body as any).purpose, m.recipient])).toEqual([
    ['handoff', 'agent_owner'],
  ]);
  await post(
    'accept-structured',
    'human_acceptance',
    { task_id: t.task_id, scope_revision: t.revision },
    'agent_owner',
  );
  s = await state();
  t = s.tasks[t.task_id];
  expect(t.state).toBe('blocked');
  expect(s.reminders['handoff-check'].state).toBe('cancelled');
  await post('dep-wrong', 'dependency_observed', {
    dependency_id: t.dependencies[0].dependency_id,
    status: 'available',
    version: 'ssml_1',
    source_ref: 'artifact',
  });
  expect((await state()).tasks[t.task_id].state).toBe('blocked');
  await post('dep-correct', 'dependency_observed', {
    dependency_id: t.dependencies[0].dependency_id,
    status: 'available',
    version: 'ssml_2',
    source_ref: 'artifact',
  });
  expect((await state()).tasks[t.task_id].state).toBe('in_progress');
  await post('claimed-done', 'delivery_reported', { task_id: t.task_id }, 'agent_owner');
  expect((await state()).tasks[t.task_id].state).toBe('in_progress');
  await post(
    'material-delivery',
    'delivery_reported',
    {
      task_id: t.task_id,
      artifact_ref: 'patch',
      test_entry_ref: 'test_entry',
      environment: 'lab',
      version_refs: { service: 'release_2' },
    },
    'agent_owner',
  );
  t = (await state()).tasks[t.task_id];
  expect(t.state).toBe('ready_for_qa');
  const qa = {
    task_id: t.task_id,
    task_revision: t.revision,
    result: 'pass',
    environment: 'lab',
    version_refs: { service: 'release_2' },
    case_ids: t.acceptance_spec.case_ids,
    scope: t.acceptance_spec.scope,
    evidence_types: ['human_qa'],
    evidence_refs: ['test-record'],
  };
  await post(
    'sample-only',
    'qa_reported',
    { ...qa, scope: { ...qa.scope, validation: 'sample' } },
    'qa_lead',
  );
  expect((await state()).tasks[t.task_id].state).toBe('ready_for_qa');
  await post('wrong-verifier', 'qa_reported', qa, 'agent_owner');
  expect((await state()).tasks[t.task_id].state).toBe('ready_for_qa');
  await post('full-qa', 'qa_reported', qa, 'qa_lead');
  await evictDurableObject(stub());
  s = await state();
  expect(s.tasks[t.task_id].state).toBe('verified');
  expect(s.qa_reports.map((r) => r.accepted)).toEqual([false, false, true]);
  expect(vi.mocked(fetch)).not.toHaveBeenCalled();
});
it('old snapshots without newer collections acquire them without losing existing records', async () => {
  await state();
  await runInDurableObject(stub(), (_instance, ctx) => {
    const store = new SqliteLedger(ctx.storage, 'demo-project');
    store.mutate((s) => {
      const old: any = s;
      delete old.source_items;
      delete old.reminders;
      old.attention.push('legacy-kept');
      return { ledger: old, result: null };
    });
  });
  await evictDurableObject(stub());
  const restored = await state();
  expect(restored.source_items).toEqual({});
  expect(restored.reminders).toEqual({});
  expect(restored.attention).toContain('legacy-kept');
});
it('a source edited while analysis runs cannot be overwritten by the old workflow result', async () => {
  await state();
  await runInDurableObject(stub(), (instance, ctx) => {
    const agent = instance as any,
      store = new SqliteLedger(ctx.storage, 'demo-project'),
      { policy } = loadConfig(agent.env),
      old = source('原始反馈', 'editing', 'r1');
    store.mutate((s) => {
      const next = reduce(s, old, policy);
      next.runs.r = {
        run_id: 'r',
        event_id: old.event_id,
        issue_id: null,
        expected_revision: 0,
        state: 'running',
        started_at: new Date().toISOString(),
        model_calls: 0,
        tool_reads: 0,
      };
      return { ledger: next, result: null };
    });
    const context = agent.runContext('r'),
      item = context.input.current_source_items[0];
    expect(context.run.source_revisions[item.item_id]).toBe('r1');
    store.mutate((s) => ({
      ledger: reduce(
        s,
        { ...source('修改后的反馈', 'editing', 'r2', '2030-01-07T02:02:00Z'), event_id: 'edited-event' },
        policy,
      ),
      result: null,
    }));
    const proposal = emptyProposal();
    proposal.coordination = {
      tasks: [],
      reports: [],
      reminders: [],
      dispositions: [
        {
          item_id: item.item_id,
          category: 'context',
          task_keys: [],
          related_item_id: null,
          reason: '旧分析',
          expected_behavior: null,
          observed_behavior: null,
          resource_refs: [],
        },
      ],
    };
    expect(
      agent.finishRun({ run_id: 'r', result: { status: 'completed', proposal, model_calls: 1 } }).accepted,
    ).toBe(false);
    const after = store.read();
    expect(after.runs.r.state).toBe('needs_attention');
    expect(after.audit.at(-1)?.reason).toBe('coordination_stale_source_revision');
    expect(after.source_items[item.item_id].text).toBe('修改后的反馈');
    expect(after.source_items[item.item_id].category).toBe('unclassified');
  });
});
it('commits events before ACK, preserves SQLite across eviction, and deduplicates after recovery', async () => {
  const c = event('feedback-1', 'feedback_observed', { case_id: 'case-one', text: '合成转圈反馈' });
  const r = await send(c);
  expect(r.status).toBe(200);
  const ack: any = await r.json();
  expect(ack.accepted).toBe(true);
  const before = await state();
  expect(Object.values(before.events).some((e) => e.event_id === 'feedback-1')).toBe(true);
  await using introspection = await introspectWorkflowInstance(bindings.ISSUE_ROUND, ack.run_id);
  await introspection.waitForStatus('complete');
  expect((await state()).runs[ack.run_id].state).toBe('completed');
  await evictDurableObject(stub());
  const again = await send(c);
  expect(((await again.json()) as any).duplicate).toBe(true);
  const restored = await state();
  expect(Object.keys(restored.cases)).toEqual(['case-one']);
  expect(restored.runs[ack.run_id].state).toBe('completed');
  expect(vi.mocked(fetch)).not.toHaveBeenCalled();
});
it('SQLite transaction rollback prevents partial acknowledgement state', async () => {
  await state();
  await runInDurableObject(stub(), (_instance, ctx) => {
    const store = new SqliteLedger(ctx.storage, 'demo-project');
    expect(() =>
      store.mutate((s) => {
        s.attention.push('must-rollback');
        ctx.storage.sql.exec(
          "INSERT INTO agent_records(collection, id, json, touched_at) VALUES('events', 'x', '{}', '2030-01-01')",
        );
        throw new Error('injected-disk-failure');
      }),
    ).toThrow('injected-disk-failure');
    expect(store.read().attention).not.toContain('must-rollback');
    expect(
      ctx.storage.sql.exec("SELECT * FROM agent_records WHERE collection = 'events' AND id = 'x'").toArray(),
    ).toHaveLength(0);
  });
});
it('sending outbox entries recover to unknown, never a blind duplicate create', async () => {
  await state();
  await runInDurableObject(stub(), (_instance, ctx) => {
    const store = new SqliteLedger(ctx.storage, 'demo-project');
    store.mutate((s) => {
      s.outbox.op = {
        operation_id: 'op',
        project_id: s.project_id,
        issue_id: null,
        task_id: null,
        expected_revision: 0,
        planned_mode: 'mock',
        capability: 'work_item.create',
        target: 'fake',
        target_owner_key: null,
        request_ref: 'fixture',
        request: {},
        state: 'sending',
        attempt_count: 1,
        last_error: null,
        external_result_ref: null,
        requires_operation_id: null,
        next_attempt_at: null,
        created_at: '2030-01-07T02:00:00Z',
      };
      return { ledger: s, result: null };
    });
  });
  await evictDurableObject(stub());
  expect((await state()).outbox.op.state).toBe('unknown');
  expect((await state()).fake.creates).toBe(0);
});
it('connector early, repeated and late results are durable, correlated and do not close issues', async () => {
  await state();
  await runInDurableObject(stub(), (_instance, ctx) => {
    new SqliteLedger(ctx.storage, 'demo-project').mutate((s) => {
      s.connector.op = {
        operation_id: 'op',
        run_id: 'run',
        source_id: 'catalog',
        capability: 'animation.catalog',
        params: {},
        state: 'pending',
        notification_pending: false,
        expires_at: '2030-01-08T00:00:00Z',
      };
      return { ledger: s, result: null };
    });
  });
  const body = {
    operation_id: 'op',
    run_id: 'run',
    source_id: 'catalog',
    result: { status: 'found', data: { id: 1 }, version: null },
  };
  const post = async (x: any) => {
    const r = await stub().fetch('https://project/connector/result', {
      method: 'POST',
      body: JSON.stringify(x),
    });
    return { status: r.status, body: (await r.json()) as any };
  };
  expect((await post({ ...body, run_id: 'wrong' })).status).toBe(400);
  expect((await post(body)).status).toBe(200);
  await evictDurableObject(stub());
  expect((await post(body)).body.duplicate).toBe(true);
  expect((await state()).connector.op.notification_pending).toBe(true);
  expect(Object.keys((await state()).issues)).toHaveLength(0);
});
it('real ingress and unauthenticated remote state access are disabled by default', async () => {
  expect((await entry.fetch(new Request('https://public.example/api/state'))).status).toBe(401);
  expect(
    (
      await entry.fetch(
        new Request('http://localhost/integrations/feishu/events', { method: 'POST', body: '{}' }),
      )
    ).status,
  ).toBe(403);
});
it('Connector read retries stay idempotent at the budget limit and revoked sources are not leased', async () => {
  await state();
  await runInDurableObject(stub(), (instance, ctx) => {
    const agent = instance as any,
      original = agent.env,
      config: any = loadConfig().config;
    config.mode = 'observe';
    config.capabilities.readEvidence = true;
    config.evidenceConnector.enabled = true;
    config.allowlists.evidenceSourceIds = ['catalog'];
    config.budgets.toolReadsPerRun = 1;
    agent.env = { ...original, MODE: 'observe', PROJECT_CONFIG_JSON: JSON.stringify(config) };
    try {
      const store = new SqliteLedger(ctx.storage, 'demo-project');
      store.mutate((s) => {
        s.runs.read_run = {
          run_id: 'read_run',
          event_id: 'fixture',
          issue_id: null,
          expected_revision: 0,
          state: 'running',
          started_at: new Date().toISOString(),
          model_calls: 0,
          tool_reads: 0,
        };
        return { ledger: s, result: null };
      });
      const request = {
        operation_id: 'read-1',
        run_id: 'read_run',
        project_id: 'demo-project',
        source_id: 'catalog',
        capability: 'animation.catalog',
        params: { q: '转圈' },
        expires_at: new Date(Date.now() + 60000).toISOString(),
      };
      agent.queueRead(request);
      agent.queueRead(request);
      expect(store.read().runs.read_run.tool_reads).toBe(1);
      expect(() => agent.queueRead({ ...request, params: { q: '跳舞' } })).toThrow('read_operation_conflict');
      expect(() => agent.queueRead({ ...request, operation_id: 'read-2' })).toThrow('read_budget_exceeded');
      config.allowlists.evidenceSourceIds = [];
      agent.env.PROJECT_CONFIG_JSON = JSON.stringify(config);
      expect(agent.pollReads().requests).toHaveLength(0);
    } finally {
      agent.env = original;
    }
  });
});
it('internal SQLite tasks complete a group handoff / blocking / delivery / QA flow while another issue stays deferred', async () => {
  const post = async (id: string, type: string, payload: any, actor = 'system') => {
    const r = await send(event(id, type, payload, actor));
    expect(r.status).toBe(200);
    return r.json() as Promise<any>;
  };
  const feedback = await post('group-feedback', 'feedback_observed', {
    case_id: 'case_group',
    text: '合成数量错误反馈',
    source_message_id: 'om_source',
    source_chat_id: 'oc_fixture',
  });
  const spec = {
    expected_behavior: '指定动作完整执行',
    case_ids: ['case_group'],
    environment: 'test_lab',
    version_requirements: { service: 'release_2' },
    scope: { description: '原 case 逐项回归', validation: 'all' },
    qa_owner_key: 'qa_lead',
    required_evidence_types: ['human_qa', 'playback_evidence'],
  };
  await post('plan-group', 'analysis_completed', {
    issue_id: 'issue_group',
    decision_type: 'assign_task',
    proposed_task_changes: [
      {
        task_id: 'TASK-1',
        kind: 'implementation',
        title: '核对动作执行数量',
        deliverable: '提交修复版本和原 case 回归',
        primary_owner_key: 'agent_owner',
        qa_owner_key: 'qa_lead',
        acceptance_spec: spec,
      },
    ],
  });
  let s = await state();
  expect(s.tasks['TASK-1'].external_record?.platform).toBe('agent_ledger');
  expect(s.fake.creates).toBe(0);
  expect(s.fake.messages[0].body).toMatchObject({ reply_to: 'om_source' });
  await post(
    'ack-group',
    'feedback_observed',
    { source_parent_message_id: 'om_source', text: '收到' },
    'agent_owner',
  );
  expect((await state()).tasks['TASK-1'].state).toBe('pending_acceptance');
  await post(
    'accept-group',
    'feedback_observed',
    { source_parent_message_id: 'om_source', text: '我接手' },
    'agent_owner',
  );
  expect((await state()).tasks['TASK-1'].state).toBe('in_progress');
  await post(
    'blocked-group',
    'blocked_reported',
    {
      task_id: 'TASK-1',
      dependencies: [
        {
          dependency_id: 'dep1',
          kind: 'artifact',
          target_ref: 'ssml',
          required_condition: 'available',
          expected_version: 'ssml_2',
          provider_owner_key: 'retrieval_owner',
          status: 'waiting',
        },
      ],
    },
    'agent_owner',
  );
  await post('dependency-group', 'dependency_observed', {
    dependency_id: 'dep1',
    status: 'available',
    version: 'ssml_2',
    source_ref: 'fixture_artifact',
  });
  await post('other-plan', 'analysis_completed', {
    issue_id: 'issue_other',
    decision_type: 'assign_task',
    proposed_task_changes: [
      {
        task_id: 'TASK-2',
        kind: 'diagnosis',
        primary_owner_key: 'retrieval_owner',
        qa_owner_key: 'qa_lead',
        deliverable: '待补充材料',
      },
    ],
  });
  await post(
    'defer-other',
    'manual_defer',
    { task_id: 'TASK-2', expected_revision: 1, reason: '等素材' },
    'coordinator',
  );
  await post(
    'delivery-group',
    'delivery_reported',
    {
      task_id: 'TASK-1',
      artifact_ref: 'fixture_patch',
      test_entry_ref: 'fixture_entry',
      environment: 'test_lab',
      version_refs: { service: 'release_2' },
    },
    'agent_owner',
  );
  s = await state();
  expect(s.tasks['TASK-1'].state).toBe('ready_for_qa');
  expect(s.tasks['TASK-2'].state).toBe('deferred');
  const qa = {
    result: 'pass',
    environment: 'test_lab',
    version_refs: { service: 'release_2' },
    case_ids: spec.case_ids,
    scope: spec.scope,
    evidence_types: spec.required_evidence_types,
    evidence_refs: ['fixture_qa', 'fixture_video'],
  };
  await post(
    'task-qa',
    'qa_reported',
    { ...qa, task_id: 'TASK-1', task_revision: s.tasks['TASK-1'].revision },
    'qa_lead',
  );
  expect((await state()).issues.issue_group.lifecycle).toBe('open');
  await post(
    'issue-spec',
    'issue_acceptance_defined',
    { issue_id: 'issue_group', expected_revision: 1, acceptance_spec: spec },
    'coordinator',
  );
  await post(
    'issue-qa',
    'issue_acceptance_reported',
    { ...qa, issue_id: 'issue_group', issue_revision: 2 },
    'qa_lead',
  );
  await using run = await introspectWorkflowInstance(bindings.ISSUE_ROUND, feedback.run_id);
  await run.waitForStatus('complete');
  await evictDurableObject(stub());
  s = await state();
  expect(s.tasks['TASK-1'].state).toBe('verified');
  expect(s.issues.issue_group.lifecycle).toBe('verified');
  expect(s.tasks['TASK-2'].state).toBe('deferred');
  expect(s.fake.creates).toBe(0);
  expect(vi.mocked(fetch)).not.toHaveBeenCalled();
});

it('stores one row per record: a ledger far beyond the per-row limit round-trips after eviction', async () => {
  await state();
  const big = 'x'.repeat(3000);
  await runInDurableObject(stub(), (_instance, ctx) => {
    const store = new SqliteLedger(ctx.storage, 'demo-project');
    store.mutate((s) => {
      for (let i = 0; i < 3500; i++)
        s.events[`synthetic-${i}`] = {
          event_id: `synthetic-${i}`,
          event_type: 'feedback_observed',
          actor_key: 'qa_lead',
          occurred_at: '2030-01-07T02:00:00Z',
          payload: { text: big },
        };
      return { ledger: s, result: null };
    });
    const rows = ctx.storage.sql
      .exec<{ n: number; biggest: number }>(
        "SELECT COUNT(*) AS n, MAX(LENGTH(json)) AS biggest FROM agent_records WHERE collection = 'events'",
      )
      .one();
    expect(rows.n).toBe(3500);
    expect(rows.biggest).toBeLessThan(10000);
  });
  await evictDurableObject(stub());
  const restored = await state();
  expect(Object.keys(restored.events)).toHaveLength(3500);
  expect(JSON.stringify(restored).length).toBeGreaterThan(10_000_000);
});
it('append-only logs keep their newest entries within the cap and unchanged rows are not rewritten', async () => {
  await state();
  await runInDurableObject(stub(), (_instance, ctx) => {
    const store = new SqliteLedger(ctx.storage, 'demo-project');
    store.mutate((s) => {
      for (let i = 0; i < 2500; i++)
        s.audit.push({ event_id: `e${i}`, type: 'note', at: '2030-01-07T02:00:00Z' });
      return { ledger: s, result: null };
    });
    const ledger = store.read();
    expect(ledger.audit).toHaveLength(2000);
    expect(ledger.audit.at(-1)?.event_id).toBe('e2499');
    expect(ledger.audit[0].event_id).toBe('e500');
    const before = ctx.storage.sql.exec('SELECT 1 FROM agent_log').toArray().length;
    const cursor = ctx.storage.sql.exec('SELECT 1');
    void cursor;
    store.mutate((s) => ({ ledger: s, result: null }));
    expect(ctx.storage.sql.exec('SELECT 1 FROM agent_log').toArray().length).toBe(before);
  });
});
it('dedup events and finished runs expire after the retention window; active work is kept', async () => {
  await state();
  await runInDurableObject(stub(), (_instance, ctx) => {
    let now = new Date('2030-01-07T02:00:00Z');
    const store = new SqliteLedger(ctx.storage, 'demo-project', () => now);
    store.mutate((s) => {
      for (const id of ['old-done', 'old-active'])
        s.events[id] = {
          event_id: id,
          event_type: 'feedback_observed',
          actor_key: 'x',
          occurred_at: now.toISOString(),
          payload: {},
        };
      s.runs.done = {
        run_id: 'done',
        event_id: 'old-done',
        issue_id: null,
        expected_revision: 0,
        state: 'completed',
        started_at: now.toISOString(),
        model_calls: 1,
        tool_reads: 0,
      };
      s.runs.active = {
        run_id: 'active',
        event_id: 'old-active',
        issue_id: null,
        expected_revision: 0,
        state: 'running',
        started_at: now.toISOString(),
        model_calls: 0,
        tool_reads: 0,
      };
      return { ledger: s, result: null };
    });
    now = new Date('2030-02-20T02:00:00Z');
    store.mutate((s) => ({ ledger: s, result: null }));
    const after = store.read();
    expect(Object.keys(after.events)).toEqual(['old-active']);
    expect(Object.keys(after.runs)).toEqual(['active']);
  });
});
it('an analysis that went stale while the model was thinking is re-queued (at most twice), not dropped', async () => {
  await state();
  await runInDurableObject(stub(), (instance, ctx) => {
    const agent = instance as any,
      store = new SqliteLedger(ctx.storage, 'demo-project');
    store.mutate((s) => {
      s.tasks['TASK-00009'] = { ...newTask('TASK-00009', 'issue_x', 'demo-project'), revision: 2 };
      s.runs.r0 = {
        run_id: 'r0',
        event_id: 'evt-busy',
        issue_id: null,
        expected_revision: 0,
        task_revisions: { 'TASK-00009': 1 },
        state: 'running',
        started_at: new Date().toISOString(),
        model_calls: 0,
        tool_reads: 0,
      };
      return { ledger: s, result: null };
    });
    const proposal = emptyProposal();
    expect(
      agent.finishRun({ run_id: 'r0', result: { status: 'completed', proposal, model_calls: 1 } }),
    ).toEqual({
      stale: true,
      requeued: 'r0-r1',
    });
    let s = store.read();
    expect(s.runs.r0.state).toBe('stale');
    expect(s.runs['r0-r1']).toMatchObject({
      state: 'queued',
      event_id: 'evt-busy',
      attempt: 1,
      retry_of: 'r0',
    });
    for (const [id, next] of [
      ['r0-r1', 'r0-r2'],
      ['r0-r2', undefined],
    ] as const) {
      store.mutate((l) => {
        l.runs[id].state = 'running';
        l.runs[id].task_revisions = { 'TASK-00009': 1 };
        return { ledger: l, result: null };
      });
      expect(
        agent.finishRun({ run_id: id, result: { status: 'completed', proposal, model_calls: 1 } }).requeued,
      ).toBe(next);
    }
    s = store.read();
    expect(Object.keys(s.runs).sort()).toEqual(['r0', 'r0-r1', 'r0-r2']);
  });
});
