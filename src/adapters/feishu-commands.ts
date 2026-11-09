/**
 * Text commands typed in the group, e.g.
 *   /agent accept TASK-00001
 *   /agent deliver TASK-00001 产物=https://… 入口=https://… 环境=staging 版本=service:1.4.2
 *   /agent qa TASK-00001 通过 范围=全量 证据=https://…
 *
 * People type these on phones: the revision number is optional (defaults to "the current one"),
 * full-width punctuation and smart quotes are accepted, and JSON still works for scripted callers.
 * A malformed command never throws; it becomes `command_invalid` so the sender gets a usage reply.
 */
export type ParsedCommand =
  | { kind: 'command'; event_type: string; payload: Record<string, unknown> }
  | { kind: 'invalid'; reason: string };

const VERBS: Record<string, string> = {
  status: 'status',
  状态: 'status',
  accept: 'accept',
  接手: 'accept',
  接单: 'accept',
  ack: 'ack',
  收到: 'ack',
  decline: 'decline',
  退回: 'decline',
  due: 'due',
  承诺: 'due',
  cancel: 'cancel',
  取消: 'cancel',
  defer: 'defer',
  暂缓: 'defer',
  resume: 'resume',
  恢复: 'resume',
  reassign: 'reassign',
  改派: 'reassign',
  deliver: 'deliver',
  交付: 'deliver',
  qa: 'qa',
  验收: 'qa',
  spec: 'spec',
  验收标准: 'spec',
  block: 'block',
  阻塞: 'block',
  unblock: 'unblock',
  解除阻塞: 'unblock',
  dependency: 'dependency',
  依赖: 'dependency',
  'issue-qa': 'issue-qa',
  'issue-spec': 'issue-spec',
  help: 'help',
  帮助: 'help',
};

const KEYS: Record<string, string> = {
  产物: 'artifact_ref',
  交付物: 'artifact_ref',
  artifact: 'artifact_ref',
  入口: 'test_entry_ref',
  测试入口: 'test_entry_ref',
  entry: 'test_entry_ref',
  环境: 'environment',
  env: 'environment',
  environment: 'environment',
  版本: 'version',
  version: 'version',
  versions: 'version',
  说明: 'note',
  备注: 'note',
  note: 'note',
  范围: 'validation',
  验证: 'validation',
  validation: 'validation',
  证据: 'evidence',
  evidence: 'evidence',
  期望: 'expected',
  expected: 'expected',
  范围描述: 'scope',
  scope: 'scope',
  原因: 'reason',
  reason: 'reason',
};

export const COMMAND_USAGE = (p: string) =>
  [
    `可用命令（修订号可省略，默认当前修订）：`,
    `${p} status TASK-00001 查看任务`,
    `${p} accept TASK-00001 确认接手；${p} ack TASK-00001 只记收到；${p} decline TASK-00001 退回`,
    `${p} deliver TASK-00001 产物=链接 入口=链接 环境=staging 版本=service:1.4.2`,
    `${p} qa TASK-00001 通过|不通过 范围=全量|抽样 证据=链接 [环境=… 版本=…]`,
    `${p} spec TASK-00001 期望=… 环境=… 版本=service:1.4.2 范围=原用例完整动作 验证=全量|抽样`,
    `${p} block TASK-00001 原因说明；${p} unblock TASK-00001`,
    `${p} due TASK-00001 2030-01-08 18:00`,
    `协调人：${p} cancel|defer|resume TASK-00001 原因；${p} reassign TASK-00001 @成员 原因`,
  ].join('\n');

const unquote = (v: string) => v.trim().replace(/^["'“”‘’「『]+|["'“”‘’」』]+$/g, '');
const half = (v: string) => v.normalize('NFKC');

function splitList(v: string) {
  return v
    .split(/[,，、;；\s]+/)
    .map((x) => unquote(x))
    .filter(Boolean);
}
/** `service:1.4.2,client:2.0` or `service=1.4.2` -> {service: '1.4.2'}; a bare `1.4.2` -> {'*': '1.4.2'}. */
export function parseVersions(v: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of splitList(v)) {
    const m = part.match(/^([^:=：＝]+)[:=：＝](.+)$/);
    if (m) out[m[1].trim()] = m[2].trim();
    else out['*'] = part;
  }
  return out;
}
function parseValidation(v: string | undefined) {
  if (!v) return undefined;
  if (/^(全量|all|full)$/i.test(v)) return 'all';
  if (/^(抽样|sample|sampled)$/i.test(v)) return 'sample';
  return undefined;
}

/** Converts `2030-01-08 18:00` / `2030-01-08` (local, in `timeZone`) or ISO strings into ISO with offset. */
export function parseDue(text: string, timeZone: string, dayEnd = '18:00'): string | null {
  const v = half(text).trim();
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(v))
    return Number.isFinite(Date.parse(v)) ? v : null;
  const m = v.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T](\d{1,2}):(\d{2}))?$/);
  if (!m) return null;
  const [, y, mo, d, h, mi] = m;
  const [dh, dm] = dayEnd.split(':');
  const local = `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}T${(h ?? dh).padStart(2, '0')}:${mi ?? dm}:00`;
  const guess = new Date(`${local}Z`);
  const name =
    new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' })
      .formatToParts(guess)
      .find((p) => p.type === 'timeZoneName')?.value ?? 'GMT';
  const offset = name === 'GMT' ? '+00:00' : name.replace('GMT', '');
  const iso = `${local}${offset}`;
  return Number.isFinite(Date.parse(iso)) ? iso : null;
}

function keyValues(tokens: string[]) {
  const kv: Record<string, string> = {};
  const rest: string[] = [];
  for (const token of tokens) {
    const m = token.match(/^([^=＝:：\s]+)\s*[=＝:：]\s*(.*)$/);
    const key = m ? (KEYS[half(m[1]).toLowerCase()] ?? KEYS[m[1]]) : undefined;
    if (m && key) kv[key] = kv[key] ? `${kv[key]},${unquote(m[2])}` : unquote(m[2]);
    else rest.push(token);
  }
  return { kv, rest: rest.join(' ').trim() };
}

function parseJson(raw: string): Record<string, unknown> | null {
  for (const candidate of [raw, raw.replace(/[“”]/g, '"').replace(/[‘’]/g, "'")]) {
    try {
      const v = JSON.parse(candidate);
      if (v && typeof v === 'object' && !Array.isArray(v)) return v;
    } catch {
      /* try the next normalisation */
    }
  }
  return null;
}

export function parseCommand(
  text: string,
  options: { prefix: string; timeZone: string; dayEnd?: string },
): ParsedCommand | null {
  const trimmed = text.trim();
  const prefix = options.prefix.trim();
  if (!trimmed.toLowerCase().startsWith(prefix.toLowerCase())) return null;
  const body = trimmed.slice(prefix.length);
  if (body && !/^\s/.test(body)) return null; // e.g. "/agentx" is not our command
  const tokens = body
    .trim()
    .split(/[\s　]+/)
    .filter(Boolean);
  const verb = VERBS[half(tokens[0] ?? '').toLowerCase()] ?? VERBS[tokens[0] ?? ''];
  if (!verb) return { kind: 'invalid', reason: tokens[0] ? 'unknown_command' : 'command_missing' };
  if (verb === 'help') return { kind: 'command', event_type: 'command_help', payload: {} };
  const target = half(tokens[1] ?? '').toUpperCase();
  if (!/^[A-Z][A-Z0-9_]*-\d+$/.test(target) && !/^ISSUE_/i.test(tokens[1] ?? ''))
    return { kind: 'invalid', reason: 'task_id_missing' };
  const id = /^ISSUE_/i.test(tokens[1] ?? '') ? tokens[1] : target;
  let index = 2;
  let revision: number | undefined;
  const rev = half(tokens[2] ?? '').match(/^(?:r|rev|修订)?(\d+)$/i);
  if (rev) {
    revision = Number(rev[1]);
    index = 3;
  }
  const tail = tokens.slice(index);
  const raw = body
    .trim()
    .split(/[\s　]+/)
    .slice(index)
    .join(' ');
  const json = raw.startsWith('{') ? parseJson(raw) : undefined;
  if (json === null) return { kind: 'invalid', reason: 'json_invalid' };
  const expected = revision === undefined ? {} : { expected_revision: revision };
  const task = { task_id: id, ...expected };
  const { kv, rest } = keyValues(tail);

  switch (verb) {
    case 'status':
      return { kind: 'command', event_type: 'task_status_requested', payload: { task_id: id } };
    case 'accept':
      return {
        kind: 'command',
        event_type: 'human_acceptance',
        payload: { task_id: id, ...(revision === undefined ? {} : { scope_revision: revision }) },
      };
    case 'ack':
      return {
        kind: 'command',
        event_type: 'human_reply',
        payload: { ...task, interpretation: 'acknowledgement_only' },
      };
    case 'decline':
      return {
        kind: 'command',
        event_type: 'assignment_declined',
        payload: { ...task, reason: kv.reason ?? (rest || '负责人表示不由其负责') },
      };
    case 'due': {
      const due = parseDue(tail.join(' '), options.timeZone, options.dayEnd);
      if (!due) return { kind: 'invalid', reason: 'date_invalid' };
      return {
        kind: 'command',
        event_type: 'human_due_commitment',
        payload: { ...task, committed_due_at: due },
      };
    }
    case 'cancel':
    case 'defer':
    case 'resume': {
      const reason = kv.reason ?? rest;
      if (!reason) return { kind: 'invalid', reason: 'decision_reason_required' };
      const types = { cancel: 'manual_cancel', defer: 'manual_defer', resume: 'manual_resume' } as const;
      return {
        kind: 'command',
        event_type: types[verb],
        payload: { ...task, reason, scope_unchanged: verb === 'resume' },
      };
    }
    case 'reassign': {
      const m = rest.match(/^@?(\S+)\s+(.+)$/s);
      if (!m) return { kind: 'invalid', reason: 'reassignment_invalid' };
      return {
        kind: 'command',
        event_type: 'manual_reassignment',
        payload: { ...task, new_owner_name: m[1], reason: m[2] },
      };
    }
    case 'deliver': {
      if (json) return { kind: 'command', event_type: 'delivery_reported', payload: { ...json, ...task } };
      return {
        kind: 'command',
        event_type: 'delivery_reported',
        payload: {
          ...task,
          artifact_ref: kv.artifact_ref,
          test_entry_ref: kv.test_entry_ref,
          environment: kv.environment,
          version_refs: kv.version ? parseVersions(kv.version) : undefined,
          note: kv.note ?? (rest || undefined),
        },
      };
    }
    case 'qa': {
      if (json)
        return {
          kind: 'command',
          event_type: 'qa_reported',
          payload: { ...json, ...task, task_revision: revision ?? (json.task_revision as number) },
        };
      const verdict = tail.find((x) => /^(通过|不通过|未通过|pass|fail|passed|failed)$/i.test(half(x)));
      if (!verdict) return { kind: 'invalid', reason: 'qa_result_missing' };
      const result = /^(通过|pass|passed)$/i.test(half(verdict)) ? 'pass' : 'fail';
      const evidence = splitList(kv.evidence ?? '');
      return {
        kind: 'command',
        event_type: 'qa_reported',
        payload: {
          ...task,
          ...(revision === undefined ? {} : { task_revision: revision }),
          result,
          environment: kv.environment,
          version_refs: kv.version ? parseVersions(kv.version) : undefined,
          scope: { validation: parseValidation(kv.validation) },
          evidence_refs: evidence,
          confirm_displayed_scope: true,
        },
      };
    }
    case 'spec': {
      if (json) return { kind: 'command', event_type: 'acceptance_defined', payload: { ...json, ...task } };
      return {
        kind: 'command',
        event_type: 'acceptance_defined',
        payload: {
          ...task,
          complete_from_task: true,
          acceptance_input: {
            expected_behavior: kv.expected,
            environment: kv.environment,
            version_requirements: kv.version ? parseVersions(kv.version) : undefined,
            scope_description: kv.scope,
            validation: parseValidation(kv.validation),
          },
        },
      };
    }
    case 'block': {
      if (json) return { kind: 'command', event_type: 'blocked_reported', payload: { ...json, ...task } };
      const reason = kv.reason ?? rest;
      if (!reason) return { kind: 'invalid', reason: 'blocker_required' };
      return { kind: 'command', event_type: 'blocked_reported', payload: { ...task, blocker_text: reason } };
    }
    case 'unblock':
      return { kind: 'command', event_type: 'human_blocker_resolved', payload: task };
    case 'dependency': {
      if (json)
        return {
          kind: 'command',
          event_type: 'dependency_confirmed_by_human',
          payload: { ...json, ...task },
        };
      const [dependency_id] = rest.split(/\s+/);
      return {
        kind: 'command',
        event_type: 'dependency_confirmed_by_human',
        payload: {
          ...task,
          dependency_id,
          evidence_ref: splitList(kv.evidence ?? '')[0],
          version: kv.version ? Object.values(parseVersions(kv.version))[0] : undefined,
        },
      };
    }
    case 'issue-qa':
    case 'issue-spec': {
      if (!json) return { kind: 'invalid', reason: 'json_required' };
      return {
        kind: 'command',
        event_type: verb === 'issue-qa' ? 'issue_acceptance_reported' : 'issue_acceptance_defined',
        payload: { ...json, issue_id: id, issue_revision: revision, expected_revision: revision },
      };
    }
  }
  return { kind: 'invalid', reason: 'unknown_command' };
}
