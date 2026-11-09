import { readFile, mkdir, open, realpath, unlink } from 'node:fs/promises';
import { resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, parseEnv } from 'node:util';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ModelRequestError, type ModelUsage } from '../src/analysis/openai-response';
import { normalizeHistory, sha256 } from '../src/replay/source';
import {
  applyDecision,
  initialReplayState,
  nextTrigger,
  observerInput,
  OpenAIHistoryPlanner,
  OBSERVER_INSTRUCTIONS,
  HistoryDecision,
  prepareTrigger,
  validateDecision,
  quarantinedDecision,
} from '../src/replay/observer';
import { ReplayStore } from '../src/replay/store';
import { writeReplayReport } from '../src/replay/report';
import { estimatedPrice, modelPrices } from '../src/replay/pricing';

const appRoot = fileURLToPath(new URL('../', import.meta.url).href);
const args = parseArgs({
  options: {
    input: { type: 'string' },
    limit: { type: 'string', default: '20' },
    resume: { type: 'string' },
    model: { type: 'string' },
    'on-invalid': { type: 'string', default: 'stop' },
    'max-input-chars': { type: 'string', default: '80000' },
    'max-cost-usd': { type: 'string', default: '5' },
    'max-calls': { type: 'string', default: '40' },
    'max-output-tokens': { type: 'string', default: '4000' },
    'timeout-seconds': { type: 'string', default: '180' },
    inspect: { type: 'boolean', default: false },
  },
}).values;
const positive = (v: string | undefined, max: number) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0 || n > max) throw new Error('invalid_replay_limit');
  return n;
};
const limit = positive(args.limit, 10000),
  maxCost = positive(args['max-cost-usd'], 1000),
  maxCalls = positive(args['max-calls'], 10000);
const maxOutputTokens = positive(args['max-output-tokens'], 16000),
  timeout = positive(args['timeout-seconds'], 600) * 1000;
const maxInputCharacters = positive(args['max-input-chars'], 500000),
  invalidPolicy = args['on-invalid'];
if (!['stop', 'record'].includes(invalidPolicy!)) throw new Error('invalid_validation_policy');
if (!Number.isInteger(limit) || !Number.isInteger(maxCalls) || !Number.isInteger(maxOutputTokens))
  throw new Error('integer_limit_required');
// Your own group export (see docs/history-replay.md); it stays local and is never committed.
const sourcePath = resolve(args.input ?? resolve(appRoot, 'data/history/messages.json'));
const sourceBytes = await readFile(sourcePath),
  sourceHash = sha256(sourceBytes),
  events = normalizeHistory(JSON.parse(sourceBytes.toString('utf8')));
if (args.inspect) {
  console.log(
    JSON.stringify(
      {
        source: sourcePath,
        sha256: sourceHash,
        total_events: events.length,
        original_body_missing: events.filter((e) =>
          e.limitations.includes('original_revision_unavailable_body_delayed_until_update'),
        ).length,
        first_available_at: events[0]?.available_at,
        last_available_at: events.at(-1)?.available_at,
        people_initial_count: 0,
        network_calls: 0,
      },
      null,
      2,
    ),
  );
} else await run();

async function run() {
  const variables: Record<string, string | undefined> = {
    ...parseEnv(
      await readFile(resolve(appRoot, '.dev.vars'), 'utf8').catch((e: any) => {
        if (e.code === 'ENOENT') return '';
        throw e;
      }),
    ),
    ...Object.fromEntries(
      ['MODEL_API_KEY', 'MODEL_BASE_URL', 'MODEL_ID']
        .filter((k) => process.env[k])
        .map((k) => [k, process.env[k]]),
    ),
  };
  const apiKey = variables.MODEL_API_KEY,
    baseUrl = variables.MODEL_BASE_URL,
    model = args.model ?? variables.MODEL_ID;
  if (!apiKey || !baseUrl || !model) throw new Error('MODEL_CONFIGURATION_MISSING');
  if (baseUrl !== 'https://api.openai.com/v1') throw new Error('UNSUPPORTED_MODEL_ENDPOINT');
  const prices = modelPrices(model),
    price = (u: ModelUsage) => estimatedPrice(model, u);
  const implementationFiles = [
    'src/replay/source.ts',
    'src/replay/observer.ts',
    'src/replay/store.ts',
    'src/replay/report.ts',
    'src/replay/pricing.ts',
    'src/analysis/openai-response.ts',
    'src/analysis/planner.ts',
    'src/domain/engine.ts',
    'src/domain/contracts.ts',
    'src/domain/coordination.ts',
    'src/domain/coordination-schema.ts',
    'src/domain/source-items.ts',
    'src/domain/rules.ts',
    'src/policy.ts',
    'src/followups.ts',
    'scripts/history-replay.ts',
  ];
  const implementation = Object.fromEntries(
    await Promise.all(implementationFiles.map(async (p) => [p, sha256(await readFile(resolve(appRoot, p)))])),
  );
  const implementationHash = sha256(JSON.stringify(implementation));
  const artifacts = resolve(appRoot, 'artifacts');
  await mkdir(artifacts, { recursive: true });
  const directory = args.resume
    ? resolve(args.resume)
    : resolve(
        artifacts,
        `history-replay-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 6)}`,
      );
  if (args.resume) {
    const actual = await realpath(directory),
      root = await realpath(artifacts),
      rel = relative(root, actual);
    if (rel.startsWith('..') || isAbsolute(rel) || !rel) throw new Error('resume_outside_artifacts');
  } else await mkdir(directory, { recursive: false });
  const lock = resolve(directory, 'run.lock'),
    handle = await open(lock, 'wx');
  let store: ReplayStore | undefined;
  try {
    store = new ReplayStore(directory);
    const prior = store.meta<any>('identity');
    if (args.resume) {
      if (
        !prior ||
        prior.source_sha256 !== sourceHash ||
        prior.model !== model ||
        prior.implementation_sha256 !== implementationHash
      )
        throw new Error('resume_source_model_or_code_changed');
      if (store.attempts().some((x) => x.status === 'started'))
        throw new Error('prior_model_call_outcome_unknown_do_not_repeat');
    } else
      store.setMeta('identity', {
        source_path: sourcePath,
        source_sha256: sourceHash,
        model,
        implementation_sha256: implementationHash,
        implementation,
        started_at: new Date().toISOString(),
        branch: null,
        commit: null,
        git_status: 'workspace_not_a_git_repository',
        seed: null,
        seed_reason: 'provider does not guarantee deterministic replay',
      });
    const planner = new OpenAIHistoryPlanner({ apiKey, baseUrl, model, maxOutputTokens });
    let state = store.checkpoint() ?? initialReplayState(),
      status = 'running',
      failure: string | null = null,
      transientFailures = 0;
    const goal = Math.min(limit, events.length);
    store.setMeta('executions', [
      ...(store.meta<any[]>('executions') ?? []),
      { started_at: new Date().toISOString(), args, model, start_cursor: state.cursor },
    ]);
    console.log(
      JSON.stringify({
        status: 'starting',
        artifact_directory: directory,
        model,
        source_events: events.length,
        resume_cursor: state.cursor,
        limit: goal,
        max_cost_usd: maxCost,
        max_calls: maxCalls,
        preloaded_people: 0,
        external_business_connections: false,
      }),
    );
    while (state.cursor < goal) {
      if (store.attempts().length >= maxCalls) {
        status = 'stopped_call_budget';
        break;
      }
      const trigger = nextTrigger(state, events[state.cursor]),
        prepared = prepareTrigger(state, trigger),
        input = observerInput(prepared, trigger);
      const inputText = JSON.stringify(input);
      if (inputText.length > maxInputCharacters) {
        status = 'stopped_input_budget';
        break;
      }
      // UTF-8 bytes conservatively bound token count for byte-based BPE; reserve full output limit before each call.
      const upperInput =
        Buffer.byteLength(
          inputText +
            OBSERVER_INSTRUCTIONS +
            JSON.stringify(z.toJSONSchema(HistoryDecision, { target: 'draft-7' })),
          'utf8',
        ) + 1024;
      const reserve = price({
        input_tokens: upperInput,
        output_tokens: maxOutputTokens,
        cached_input_tokens: 0,
      });
      if (store.usedCost() + reserve > maxCost) {
        status = 'stopped_cost_budget';
        break;
      }
      const attempt = store.startAttempt(input, reserve),
        started = Date.now();
      let response: Awaited<ReturnType<typeof planner.plan>> | undefined,
        committed = false;
      try {
        response = await planner.plan(input, AbortSignal.timeout(timeout));
        const decision = validateDecision(prepared, input, response.data, true);
        const updated = applyDecision(prepared, trigger, decision),
          priorIds = new Set(Object.keys(state.ledger.tasks));
        const step = {
          number: store.steps().length + 1,
          trigger,
          at: prepared.now!,
          decision,
          input,
          input_sha256: sha256(inputText),
          usage: response.usage,
          estimated_cost_usd: price(response.usage),
          response_id: response.response_id,
          model: response.model,
          latency_ms: Date.now() - started,
          created_task_ids: Object.keys(updated.ledger.tasks).filter((id) => !priorIds.has(id)),
          people_count: Object.keys(updated.people).length,
          task_count: Object.keys(updated.ledger.tasks).length,
          service_tier: response.service_tier,
          evaluation: { status: 'accepted' as const, reason: null, raw_decision: null },
        };
        store.saveStep(attempt, step, updated);
        committed = true;
        state = updated;
        transientFailures = 0;
        failure = null;
        console.log(
          JSON.stringify({
            step: step.number,
            source_events: state.cursor,
            trigger: trigger.kind,
            at: step.at,
            emit: decision.emit,
            people: step.people_count,
            tasks: step.task_count,
            input_tokens: step.usage.input_tokens,
            output_tokens: step.usage.output_tokens,
            estimated_cost_usd: Number(store.usedCost().toFixed(6)),
            latency_ms: step.latency_ms,
          }),
        );
        await exportFiles();
      } catch (error: any) {
        if (committed) throw error;
        failure =
          error instanceof ModelRequestError
            ? error.code
            : response
              ? String(error.message)
                  .replace(/[^a-zA-Z0-9_:-]/g, '')
                  .slice(0, 120)
              : `network_${error.name ?? 'error'}_${error.cause?.code ?? 'unknown'}`;
        if (response && !failure.startsWith('replay_')) throw error;
        const usage = response?.usage ?? (error instanceof ModelRequestError ? error.usage : null);
        const cost = usage ? price(usage) : failure.startsWith('MODEL_HTTP_') ? 0 : null;
        const permanent = /MODEL_HTTP_(400|401|402|403|404|422)|insufficient_quota|billing/.test(failure);
        const transient =
          !response &&
          (failure.startsWith('network_') || /MODEL_HTTP_(429|5\d\d)/.test(failure)) &&
          !permanent;
        if (transient && transientFailures < 2) {
          store.failAttempt(attempt, failure, cost, { usage, response_id: null });
          transientFailures++;
          console.log(
            JSON.stringify({ status: 'retrying_transport', reason: failure, retry: transientFailures }),
          );
          await exportFiles();
          await new Promise((resolve) => setTimeout(resolve, transientFailures * 5000));
          continue;
        }
        if (invalidPolicy === 'record' && !permanent) {
          const decision = quarantinedDecision(failure),
            updated = applyDecision(prepared, trigger, decision);
          const step = {
            number: store.steps().length + 1,
            trigger,
            at: prepared.now!,
            decision,
            input,
            input_sha256: sha256(inputText),
            usage: usage ?? { input_tokens: 0, output_tokens: 0, cached_input_tokens: 0 },
            estimated_cost_usd: cost ?? reserve,
            response_id:
              response?.response_id ?? (error instanceof ModelRequestError ? error.response_id : null) ?? '',
            model,
            latency_ms: Date.now() - started,
            created_task_ids: [],
            people_count: Object.keys(updated.people).length,
            task_count: Object.keys(updated.ledger.tasks).length,
            evaluation: {
              status: response ? ('rejected' as const) : ('model_error' as const),
              reason: failure,
              raw_decision: response?.data ?? null,
            },
          };
          store.saveStep(attempt, step, updated);
          state = updated;
          transientFailures = 0;
          console.log(
            JSON.stringify({
              status: 'quarantined',
              step: step.number,
              source_events: state.cursor,
              reason: failure,
              estimated_cost_usd: store.usedCost(),
            }),
          );
          failure = null;
          await exportFiles();
          continue;
        }
        store.failAttempt(attempt, failure, cost, {
          usage,
          response_id: response?.response_id ?? null,
          decision: response?.data ?? null,
        });
        status = 'stopped_model_or_validation_error';
        console.log(JSON.stringify({ status, reason: failure, charged_or_reserved_usd: store.usedCost() }));
        break;
      }
    }
    if (state.cursor === events.length) status = 'completed_all';
    else if (state.cursor >= goal) status = 'completed_limit';
    await exportFiles();
    console.log(
      JSON.stringify({
        status,
        processed_source_events: state.cursor,
        model_steps: store.steps().length,
        outputs: store.steps().filter((s) => s.decision.emit).length,
        estimated_cost_usd: store.usedCost(),
        artifact_directory: directory,
      }),
    );
    if (failure) process.exitCode = 1;
    async function exportFiles() {
      const unchanged = sha256(await readFile(sourcePath)) === sourceHash;
      const steps = store!.steps(),
        attempts = store!.attempts();
      const manifest = {
        ...store!.meta<any>('identity'),
        last_updated_at: new Date().toISOString(),
        status,
        failure,
        command: {
          script: 'history-replay',
          limit,
          max_calls: maxCalls,
          max_cost_usd: maxCost,
          max_output_tokens: maxOutputTokens,
          max_input_characters: maxInputCharacters,
          on_invalid: invalidPolicy,
          timeout_seconds: timeout / 1000,
          resume: Boolean(args.resume),
        },
        runtime: process.version,
        source_unchanged: unchanged,
        total_source_events: events.length,
        processed_source_events: state.cursor,
        model_steps: steps.length,
        model_attempts: attempts.length,
        output_count: steps.filter((x) => x.decision.emit).length,
        silent_count: steps.filter(
          (x) => !x.decision.emit && (!x.evaluation || x.evaluation.status === 'accepted'),
        ).length,
        rejected_count: steps.filter((x) => x.evaluation?.status === 'rejected').length,
        model_error_count: steps.filter((x) => x.evaluation?.status === 'model_error').length,
        executions: store!.meta('executions'),
        estimated_cost_usd: store!.usedCost(),
        usage: steps.reduce(
          (a, s) => ({
            input_tokens: a.input_tokens + s.usage.input_tokens,
            output_tokens: a.output_tokens + s.usage.output_tokens,
            cached_input_tokens: a.cached_input_tokens + s.usage.cached_input_tokens,
          }),
          { input_tokens: 0, output_tokens: 0, cached_input_tokens: 0 },
        ),
        prices,
        requested_service_tier: 'default',
        initial_people: 0,
        identity_source: 'observed_messages_only',
        agent_output_reinserted: false,
        actual_messages_sent: 0,
        cloudflare_calls: 0,
        feishu_calls: 0,
        internal_api_calls: 0,
        edited_original_body_unavailable: events.filter((e) =>
          e.limitations.includes('original_revision_unavailable_body_delayed_until_update'),
        ).length,
        test_scope:
          '真实历史观察式回放：模型、逐条身份/职责识别、现有任务领域状态机；不验证真人响应、外部接口或云端运行时。',
      };
      store!.setMeta('latest_manifest', manifest);
      await writeReplayReport(directory, steps, state, manifest);
      if (!unchanged) throw new Error('source_history_changed_during_replay');
    }
  } finally {
    store?.close();
    await handle.close();
    await unlink(lock);
  }
}
