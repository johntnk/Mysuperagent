import { it, expect, vi } from 'vitest';
import { loadConfig } from '../../src/config';
import { planEvidenceReads, evidenceForModel } from '../../src/analysis/evidence-plan';
import { boundedPlan, emptyProposal, OpenAIPlanner } from '../../src/analysis/planner';
const query = {
  kind: 'animation_catalog' as const,
  query: '转圈',
  clip_id: null,
  trace_id: null,
  catalog_id: null,
  from: null,
  to: null,
};
function connected() {
  const config: any = loadConfig().config;
  config.mode = 'observe';
  config.capabilities.readEvidence = true;
  config.evidenceConnector.enabled = true;
  config.evidenceConnector.sources.animationLibrary.sourceId = 'catalog';
  config.allowlists.evidenceSourceIds = ['catalog'];
  return config;
}
it('model reads map to fixed sources, deduplicate across retries and obey the total read budget', () => {
  const config = connected(),
    run = { run_id: 'run', tool_reads: 0 };
  const first = planEvidenceReads([query, query], config, run, [], 0);
  expect(first.requests).toHaveLength(1);
  expect(first.requests[0]).toMatchObject({
    source_id: 'catalog',
    capability: 'animation.catalog',
    params: { q: '转圈' },
  });
  expect(planEvidenceReads([query], config, run, first.requests, 500).requests).toHaveLength(0);
  expect(
    planEvidenceReads([query], config, { ...run, tool_reads: config.budgets.toolReadsPerRun }, [])
      .unavailable,
  ).toContain('animation_catalog: read_budget_exceeded');
  config.allowlists.evidenceSourceIds = [];
  expect(planEvidenceReads([query], config, run, []).requests).toHaveLength(0);
  expect(planEvidenceReads([query], loadConfig().config, run, []).requests).toHaveLength(0);
});
it('evidence references retain original operation and source; truncated content is explicitly partial', () => {
  const [r] = evidenceForModel(
    [
      {
        operation_id: 'read-original',
        source_id: 'catalog',
        capability: 'animation.catalog',
        params: { q: '转圈' },
        result: {
          observed_at: '2030-01-01T00:00:00Z',
          result: { status: 'found', version: null, data: { rows: ['x'.repeat(2000)] } },
        },
      },
    ],
    1000,
  );
  expect(r).toMatchObject({
    evidence_id: 'read-original',
    source_id: 'catalog',
    version: null,
    truncated: true,
  });
  expect(r.data.warning).toContain('not proof of absence');
});
it('feedback review reads require an explicit bounded time range and stay attached as evidence', () => {
  const config = connected();
  config.evidenceConnector.sources.feedback.sourceId = 'reviews';
  config.allowlists.evidenceSourceIds.push('reviews');
  const run = { run_id: 'group-case-run', tool_reads: 0 };
  expect(planEvidenceReads([{ ...query, kind: 'feedback_reviews' }], config, run, []).unavailable).toContain(
    'feedback_reviews: explicit_range_up_to_24h_required',
  );
  const p = planEvidenceReads(
    [
      {
        ...query,
        kind: 'feedback_reviews',
        from: '2030-01-01T00:00:00+08:00',
        to: '2030-01-02T00:00:00+08:00',
      },
    ],
    config,
    run,
    [],
  );
  expect(p.requests[0]).toMatchObject({
    run_id: 'group-case-run',
    source_id: 'reviews',
    capability: 'feedback.list',
    params: { limit: 50, qualityStatus: 'unacceptable' },
  });
});
it('planner can cite read evidence but cannot invent trace or clip identifiers', async () => {
  const { config } = loadConfig(),
    input = {
      event: { event_id: 'e' } as any,
      issue: null,
      evidence: [{ evidence_id: 'read-1', data: { clip_id: 'clip-known' } }],
      allowed_people: [],
    };
  const plan = {
    ...emptyProposal(),
    fact_refs: ['read-1'],
    evidence_requests: [{ ...query, clip_id: 'clip-known' }],
  };
  expect(await boundedPlan({ plan: vi.fn().mockResolvedValue(plan) }, input, config)).toMatchObject({
    status: 'completed',
  });
  plan.evidence_requests[0].clip_id = 'clip-invented';
  expect(await boundedPlan({ plan: vi.fn().mockResolvedValue(plan) }, input, config)).toMatchObject({
    status: 'needs_attention',
    reason: 'planner_unbound_resource',
  });
});
it('bounded planner times out even if an injected provider ignores AbortSignal', async () => {
  const config = loadConfig().config;
  config.budgets.runTimeoutSeconds = 0.01;
  expect(
    await boundedPlan(
      { plan: () => new Promise(() => {}) },
      { event: { event_id: 'e' } as any, issue: null, evidence: [], allowed_people: [] },
      config,
    ),
  ).toMatchObject({ status: 'needs_attention', reason: 'planner_timeout', model_calls: 1 });
});
it('OpenAI adapter uses the configured Astra Responses schema without saving requests', async () => {
  const config = loadConfig().config;
  config.mode = 'observe';
  config.capabilities.modelInference = true;
  const transport = vi.fn().mockResolvedValue(
    Response.json({
      status: 'completed',
      output: [
        { type: 'message', content: [{ type: 'output_text', text: JSON.stringify(emptyProposal()) }] },
      ],
    }),
  );
  const planner = new OpenAIPlanner(
    { MODEL_API_KEY: 'synthetic', MODEL_BASE_URL: 'https://api.openai.com/v1', MODEL_ID: 'gpt-6-astra' },
    config,
    transport,
  );
  await planner.plan(
    { event: { event_id: 'e' } as any, issue: null, evidence: [], allowed_people: [] },
    new AbortController().signal,
  );
  const [url, options] = transport.mock.calls[0],
    body = JSON.parse(options.body);
  expect(url).toBe('https://api.openai.com/v1/responses');
  expect(body).toMatchObject({
    model: 'gpt-6-astra',
    store: false,
    text: { format: { type: 'json_schema', strict: true } },
  });
  expect(body.text.format.schema.required).toContain('evidence_requests');
});
