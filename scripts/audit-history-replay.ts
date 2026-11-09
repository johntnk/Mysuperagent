import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, parseEnv } from 'node:util';
import { Script } from 'node:vm';
import { DatabaseSync } from 'node:sqlite';
import { sha256, normalizeHistory } from '../src/replay/source';
import {
  initialReplayState,
  prepareTrigger,
  observerInput,
  validateDecision,
  applyDecision,
} from '../src/replay/observer';
import type { ReplayStep } from '../src/replay/store';

const args = parseArgs({
  options: { directory: { type: 'string' }, snapshot: { type: 'boolean', default: false } },
}).values;
if (!args.directory) throw new Error('directory_required');
const appRoot = fileURLToPath(new URL('../', import.meta.url).href),
  directory = resolve(args.directory);
const within = relative(resolve(appRoot, 'artifacts'), directory);
if (!within || within.startsWith('..') || isAbsolute(within))
  throw new Error('audit_directory_outside_artifacts');
const manifest = JSON.parse(await readFile(resolve(directory, 'manifest.json'), 'utf8'));
if (manifest.status === 'running') throw new Error('audit_requires_stopped_run');
const sourceBytes = await readFile(manifest.source_path),
  events = normalizeHistory(JSON.parse(sourceBytes.toString('utf8')));
const db = new DatabaseSync(resolve(directory, 'replay.sqlite'), { readOnly: true });
const steps: ReplayStep[] = db
  .prepare('SELECT record FROM steps ORDER BY number')
  .all()
  .map((r: any) => JSON.parse(r.record));
const finalState = JSON.parse((db.prepare('SELECT state FROM checkpoint WHERE id=1').get() as any).state);
const attempts = db
  .prepare('SELECT id,status,reserved_cost,actual_cost,record FROM attempts ORDER BY id')
  .all() as any[];
db.close();
const violations: { step?: number; code: string; detail?: string }[] = [];
let state = initialReplayState();
for (const step of steps) {
  const trigger = step.trigger;
  if (manifest.test_scope_kind === 'targeted_prefix_probe' && trigger.kind === 'message')
    while (state.cursor < events.length && events[state.cursor].event_id !== trigger.event.event_id)
      state = prepareTrigger(state, { kind: 'message', event: events[state.cursor] });
  if (trigger.kind === 'message' && events[state.cursor]?.event_id !== trigger.event.event_id)
    violations.push({ step: step.number, code: 'source_sequence_mismatch' });
  try {
    const prepared = prepareTrigger(state, trigger),
      input = observerInput(prepared, trigger);
    if (sha256(JSON.stringify(step.input)) !== step.input_sha256)
      violations.push({ step: step.number, code: 'stored_input_hash_mismatch' });
    if (sha256(JSON.stringify(input)) !== step.input_sha256)
      violations.push({ step: step.number, code: 'reconstructed_input_mismatch' });
    for (const source of (step.input as any).source_messages) {
      if (!prepared.seen.some((e) => e.event_id === source.event_id) || source.available_at > prepared.now!)
        violations.push({ step: step.number, code: 'future_source' });
    }
    const accepted = !step.evaluation || step.evaluation.status === 'accepted';
    if (accepted) validateDecision(prepared, input, step.decision);
    else if (
      step.decision.emit ||
      step.decision.proposal.coordination ||
      step.decision.proposal.proposed_task_changes.length ||
      step.decision.role_observations.length
    )
      violations.push({ step: step.number, code: 'quarantine_applied_side_effects' });
    state = applyDecision(prepared, trigger, step.decision);
  } catch (e: any) {
    violations.push({
      step: step.number,
      code: 'reconstruction_error',
      detail: String(e.message).slice(0, 160),
    });
    break;
  }
}
if (JSON.stringify(state) !== JSON.stringify(finalState)) violations.push({ code: 'checkpoint_mismatch' });
if (sha256(sourceBytes) !== manifest.source_sha256) violations.push({ code: 'source_file_changed' });
if (state.cursor !== manifest.processed_source_events || steps.length !== manifest.model_steps)
  violations.push({ code: 'manifest_count_mismatch' });
const codeMatches: Record<string, boolean> = {};
for (const [name, hash] of Object.entries(manifest.implementation)) {
  const bytes = await readFile(resolve(appRoot, name));
  codeMatches[name] = sha256(bytes) === hash;
  if (args.snapshot && codeMatches[name]) {
    const target = resolve(directory, 'code-snapshot', name),
      rel = relative(resolve(directory, 'code-snapshot'), target);
    if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('snapshot_path_invalid');
    await mkdir(dirname(target), { recursive: true });
    try {
      await writeFile(target, bytes, { flag: 'wx' });
    } catch (e: any) {
      if (e.code !== 'EEXIST') throw e;
      if (sha256(await readFile(target)) !== hash) throw new Error('existing_snapshot_different');
    }
  }
}
if (Object.values(codeMatches).some((x) => !x)) violations.push({ code: 'current_code_differs_from_run' });
const html = await readFile(resolve(directory, 'report.html'), 'utf8');
try {
  new Script(html.match(/<script nonce="replay-local">([\s\S]*)<\/script>/)![1]);
} catch {
  violations.push({ code: 'report_script_invalid' });
}
const secrets = parseEnv(await readFile(resolve(appRoot, '.dev.vars'), 'utf8'));
const key = process.env.MODEL_API_KEY ?? secrets.MODEL_API_KEY;
let secretOccurrences = 0;
if (key)
  for (const file of [
    'manifest.json',
    'state.json',
    'source-events.jsonl',
    'outputs.jsonl',
    'decisions.jsonl',
    'model-inputs.jsonl',
    'rejected-decisions.jsonl',
    'report.html',
    'report.md',
    'replay.sqlite',
  ]) {
    if ((await readFile(resolve(directory, file))).includes(Buffer.from(key))) secretOccurrences++;
  }
if (secretOccurrences) violations.push({ code: 'model_key_found_in_artifact' });
if (Object.values(state.ledger.outbox).some((effect) => effect.state !== 'blocked'))
  violations.push({ code: 'business_effect_not_blocked' });
const cost = attempts.reduce((sum, a) => sum + Number(a.actual_cost ?? a.reserved_cost), 0);
if (Math.abs(cost - Number(manifest.estimated_cost_usd)) > 1e-8) violations.push({ code: 'cost_mismatch' });
const counts: Record<string, number> = {};
for (const step of steps) {
  const k = step.evaluation?.status ?? 'accepted';
  counts[k] = (counts[k] ?? 0) + 1;
}
const reportKinds: Record<string, number> = {};
for (const r of state.task_reports) reportKinds[r.kind] = (reportKinds[r.kind] ?? 0) + 1;
const rejectedReasons: Record<string, number> = {};
for (const step of steps)
  if (step.evaluation?.reason)
    rejectedReasons[step.evaluation.reason] = (rejectedReasons[step.evaluation.reason] ?? 0) + 1;
const audit = {
  checked_at: new Date().toISOString(),
  passed: violations.length === 0,
  violations,
  processing_complete: state.cursor === events.length,
  source_events: state.cursor,
  total_source_events: events.length,
  steps: steps.length,
  model: manifest.model,
  model_attempts: attempts.length,
  evaluation_counts: counts,
  rejection_reasons: rejectedReasons,
  actual_utterances: 0,
  proposed_utterances: steps.filter((s) => s.decision.emit).length,
  normal_silence: steps.filter(
    (s) => (!s.evaluation || s.evaluation.status === 'accepted') && !s.decision.emit,
  ).length,
  timer_steps: steps.filter((s) => s.trigger.kind === 'timer').length,
  people_records: Object.keys(state.people).length,
  people_with_role_evidence: Object.values(state.people).filter((p) => p.roles.length).length,
  tasks: Object.keys(state.ledger.tasks).length,
  task_states: Object.fromEntries(
    [...new Set(Object.values(state.ledger.tasks).map((t) => t.state))].map((k) => [
      k,
      Object.values(state.ledger.tasks).filter((t) => t.state === k).length,
    ]),
  ),
  historical_report_kinds: reportKinds,
  estimated_cost_usd: cost,
  unknown_usage_attempts: attempts.filter((a) => a.actual_cost === null).length,
  source_unchanged: sha256(sourceBytes) === manifest.source_sha256,
  code_matches: codeMatches,
  api_key_artifact_occurrences: secretOccurrences,
  latency_ms: {
    min: Math.min(...steps.map((s) => s.latency_ms)),
    max: Math.max(...steps.map((s) => s.latency_ms)),
    sum: steps.reduce((n, s) => n + s.latency_ms, 0),
  },
  first_time: state.seen[0]?.available_at,
  last_time: state.seen.at(-1)?.available_at,
  limitation: '机械审计只证明输入隔离、状态重建、输出隔离及账本一致；不把结构校验通过当作业务判断正确。',
};
await writeFile(resolve(directory, 'audit.json'), JSON.stringify(audit, null, 2));
console.log(JSON.stringify(audit, null, 2));
if (!audit.passed) process.exitCode = 1;
