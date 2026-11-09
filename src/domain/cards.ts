import type { Task } from './contracts';

/**
 * Channel-neutral description of an interactive card. The domain decides *what* a person can confirm;
 * channel adapters (Feishu today) decide how it looks. Every button or form submission comes back as an
 * ordinary, authenticated command from that person, so a card never bypasses the domain rules.
 */
export type CardKind = 'handoff' | 'deliver' | 'qa' | 'spec';
export interface CardSpec {
  kind: CardKind;
  task_id: string;
  revision: number;
  /** Task title; derived from chat or model output, so adapters must render it as plain text. */
  title: string;
  /** One agent-authored sentence explaining why the card was sent. */
  intro: string;
  /** Label / value pairs. Values may contain untrusted text. */
  facts: [string, string][];
  /** Pre-filled form values. */
  defaults: Record<string, string>;
  /** Components that need a version (e.g. `service`), one input each. */
  version_components: string[];
  validation: 'all' | 'sample';
  /**
   * Deliver cards are checked against the accepted scope rather than the task revision, so an unrelated
   * change (e.g. a committed due date) does not invalidate a card that is already in the chat.
   */
  scope_revision?: number;
}

const PLACEHOLDER_EXPECTED = '待明确验收目标';
const PLACEHOLDER_SCOPE = '待明确范围';

export function acceptanceGaps(t: Task) {
  const a = t.acceptance_spec;
  const gaps: string[] = [];
  if (!a.expected_behavior || a.expected_behavior === PLACEHOLDER_EXPECTED) gaps.push('期望行为');
  if (!a.environment) gaps.push('验收环境');
  if (!a.qa_owner_key) gaps.push('验收人');
  if (!a.case_ids.length) gaps.push('关联用例');
  if (!a.scope.description || a.scope.description === PLACEHOLDER_SCOPE) gaps.push('验收范围');
  if (!a.required_evidence_types.length) gaps.push('证据类型');
  return gaps;
}

const versionsText = (v: Record<string, string | null>) =>
  Object.entries(v)
    .map(([k, x]) => `${k}=${x ?? '未定'}`)
    .join('，') || '未要求';
const validationText = (v: 'all' | 'sample') => (v === 'all' ? '全量' : '抽样');

function base(t: Task, kind: CardKind, intro: string): CardSpec {
  return {
    kind,
    task_id: t.task_id,
    revision: t.revision,
    title: t.title,
    intro,
    facts: [],
    defaults: {},
    version_components: [],
    validation: t.acceptance_spec.scope.validation,
  };
}

export function handoffCard(t: Task, intro = '这项工作需要你确认是否接手。'): CardSpec {
  const card = base(t, 'handoff', intro);
  const a = t.acceptance_spec;
  card.facts = [
    ['交付物', t.deliverable],
    ['验收', a.expected_behavior],
    ...t.dependencies
      .filter((d) => d.status !== 'satisfied')
      .map((d): [string, string] => [
        '依赖',
        `${d.target_ref.replace(/^human-note:/, '')}（${d.required_condition}）`,
      ]),
  ];
  return card;
}

export function deliverCard(
  t: Task,
  scopeRevision: number | undefined,
  intro = '完成后在这里提交交付信息，齐全后会自动交给验收人。',
): CardSpec {
  const card = base(t, 'deliver', intro);
  card.scope_revision = scopeRevision;
  const a = t.acceptance_spec;
  card.facts = [
    ['交付物', t.deliverable],
    ['验收环境', a.environment ?? '未定'],
    ['版本要求', versionsText(a.version_requirements)],
  ];
  card.version_components = Object.keys(a.version_requirements);
  card.defaults = {
    environment: a.environment ?? '',
    ...Object.fromEntries(
      card.version_components.map((k) => [`version:${k}`, a.version_requirements[k] ?? '']),
    ),
  };
  return card;
}

export function qaCard(t: Task, intro = '这项工作已修待测，请按下面的范围验收。'): CardSpec {
  const card = base(t, 'qa', intro);
  const a = t.acceptance_spec,
    d = (t.delivery ?? {}) as Record<string, unknown>;
  card.facts = [
    ['期望行为', a.expected_behavior],
    ['验收范围', `${a.scope.description}（${validationText(a.scope.validation)}）`],
    ['关联用例', a.case_ids.join('、') || '未定'],
    ['环境', a.environment ?? '未定'],
    ['版本', versionsText(a.version_requirements)],
    ['交付物', String(d.artifact_ref ?? '未提供')],
    ['测试入口', String(d.test_entry_ref ?? '未提供')],
  ];
  card.version_components = Object.keys(a.version_requirements);
  card.defaults = {
    environment: a.environment ?? '',
    ...Object.fromEntries(
      card.version_components.map((k) => [`version:${k}`, a.version_requirements[k] ?? '']),
    ),
  };
  return card;
}

export function specCard(t: Task, intro: string): CardSpec {
  const card = base(t, 'spec', intro);
  const a = t.acceptance_spec;
  card.facts = [
    ['交付物', t.deliverable],
    ['还缺', acceptanceGaps(t).join('、') || '无'],
  ];
  card.defaults = {
    expected: a.expected_behavior === PLACEHOLDER_EXPECTED ? '' : a.expected_behavior,
    environment: a.environment ?? '',
    versions: Object.entries(a.version_requirements)
      .map(([k, v]) => `${k}=${v ?? ''}`)
      .join(','),
    scope: a.scope.description === PLACEHOLDER_SCOPE ? '' : a.scope.description,
  };
  return card;
}

/** Plain-text fallback with the equivalent text command, used by channels without cards and in logs. */
export function cardText(card: CardSpec, prefix = '/agent') {
  const lines = [
    `任务 ${card.task_id}（修订 ${card.revision}）：${card.title}`,
    card.intro,
    ...card.facts.map(([k, v]) => `${k}：${v}`),
  ];
  const id = card.task_id;
  if (card.kind === 'handoff')
    lines.push(
      `回复「${prefix} accept ${id}」确认接手；「${prefix} ack ${id}」只记收到；「${prefix} decline ${id}」退回。`,
    );
  if (card.kind === 'deliver')
    lines.push(`完成后回复「${prefix} deliver ${id} 产物=链接 入口=链接 环境=… 版本=组件:版本」。`);
  if (card.kind === 'qa')
    lines.push(`验收后回复「${prefix} qa ${id} 通过|不通过 范围=全量|抽样 证据=链接」。`);
  if (card.kind === 'spec')
    lines.push(
      `回复「${prefix} spec ${id} 期望=… 环境=… 版本=组件:版本 范围=… 验证=全量|抽样」补充验收标准。`,
    );
  return lines.join('\n');
}
