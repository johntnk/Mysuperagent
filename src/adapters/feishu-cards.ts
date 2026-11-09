import type { ProjectConfig, RoutingConfig } from '../config';
import { EventEnvelope, type Command } from '../domain/contracts';
import type { CardSpec } from '../domain/cards';
import { parseVersions } from './feishu-commands';

/**
 * Feishu interactive cards (card JSON 2.0) for the task loop: confirm a handoff, submit a delivery,
 * record a QA verdict, define acceptance. Untrusted text (titles, chat excerpts) is always `plain_text`;
 * only agent-authored sentences use markdown.
 */
const plain = (content: string) => ({ tag: 'plain_text', content: content.slice(0, 2000) });
const markdown = (content: string) => ({ tag: 'markdown', content });
const text = (content: string) => ({ tag: 'div', text: plain(content) });

const TITLES: Record<CardSpec['kind'], [string, string]> = {
  handoff: ['待确认接手', 'blue'],
  deliver: ['提交交付', 'turquoise'],
  qa: ['待验收', 'orange'],
  spec: ['补充验收标准', 'purple'],
};

export interface CardActionValue {
  v: 1;
  a: 'accept' | 'ack' | 'decline' | 'deliver' | 'qa' | 'spec';
  t: string;
  r: number;
  s?: number;
  result?: 'pass' | 'fail';
  vc?: string[];
}

function button(
  label: string,
  value: CardActionValue,
  type: 'primary' | 'default' | 'danger' = 'default',
  submit = false,
) {
  return {
    tag: 'button',
    name: `${value.a}_${value.result ?? 'go'}`,
    text: plain(label),
    type,
    ...(submit ? { form_action_type: 'submit' } : {}),
    behaviors: [{ type: 'callback', value }],
  };
}
function row(elements: unknown[]) {
  return {
    tag: 'column_set',
    flex_mode: 'flow',
    horizontal_spacing: '8px',
    columns: elements.map((e) => ({ tag: 'column', width: 'auto', elements: [e] })),
  };
}
function input(name: string, placeholder: string, value = '', required = false) {
  return {
    tag: 'input',
    name,
    required,
    placeholder: plain(placeholder),
    default_value: value,
    width: 'fill',
  };
}
function validationSelect(initial: 'all' | 'sample') {
  return {
    tag: 'select_static',
    name: 'validation',
    required: true,
    initial_option: initial,
    width: 'fill',
    placeholder: plain('验收范围'),
    options: [
      { text: plain('全量'), value: 'all' },
      { text: plain('抽样'), value: 'sample' },
    ],
  };
}
function versionInputs(card: CardSpec) {
  return card.version_components.map((component, i) =>
    input(`version__${i}`, `${component} 版本`, card.defaults[`version:${component}`] ?? '', true),
  );
}

export function renderCard(card: CardSpec, mentionOpenId?: string) {
  const [title, template] = TITLES[card.kind];
  const value = (a: CardActionValue['a'], extra: Partial<CardActionValue> = {}): CardActionValue => ({
    v: 1,
    a,
    t: card.task_id,
    r: card.revision,
    ...extra,
  });
  const elements: unknown[] = [];
  if (mentionOpenId && /^ou_[a-zA-Z0-9]+$/.test(mentionOpenId))
    elements.push(markdown(`<at id=${mentionOpenId}></at>`));
  elements.push(text(card.title), markdown(card.intro));
  for (const [label, v] of card.facts) elements.push(text(`${label}：${v}`));
  const formName = `${card.kind}_${card.task_id}_${card.revision}`.replace(/[^A-Za-z0-9_]/g, '_');
  if (card.kind === 'handoff')
    elements.push(
      row([
        button('确认接手', value('accept'), 'primary'),
        button('只是收到', value('ack')),
        button('不是我负责', value('decline'), 'danger'),
      ]),
    );
  if (card.kind === 'deliver')
    elements.push({
      tag: 'form',
      name: formName,
      elements: [
        input('artifact_ref', '交付物链接或说明（必填）', '', true),
        input('test_entry_ref', '测试入口：链接、包名或步骤（必填）', '', true),
        input('environment', '交付到的环境', card.defaults.environment ?? '', true),
        ...versionInputs(card),
        input('note', '补充说明（可选）'),
        button(
          '提交交付',
          value('deliver', { s: card.scope_revision ?? card.revision, vc: card.version_components }),
          'primary',
          true,
        ),
      ],
    });
  if (card.kind === 'qa')
    elements.push({
      tag: 'form',
      name: formName,
      elements: [
        input('environment', '验收所用环境', card.defaults.environment ?? '', true),
        ...versionInputs(card),
        validationSelect(card.validation),
        input('evidence', '验收证据链接（录屏/记录，多个用逗号分隔，必填）', '', true),
        row([
          button('验收通过', value('qa', { result: 'pass', vc: card.version_components }), 'primary', true),
          button('验收不通过', value('qa', { result: 'fail', vc: card.version_components }), 'danger', true),
        ]),
      ],
    });
  if (card.kind === 'spec')
    elements.push({
      tag: 'form',
      name: formName,
      elements: [
        input('expected', '期望行为（必填）', card.defaults.expected ?? '', true),
        input('environment', '验收环境（必填）', card.defaults.environment ?? '', true),
        input('versions', '版本要求，如 service=1.4.2,client=2.0', card.defaults.versions ?? ''),
        input('scope', '验收范围说明（必填）', card.defaults.scope ?? '', true),
        validationSelect(card.validation),
        button('保存验收标准', value('spec'), 'primary', true),
      ],
    });
  return {
    schema: '2.0',
    config: { update_multi: true },
    header: {
      title: plain(`${title} · ${card.task_id}`),
      subtitle: plain(`修订 ${card.revision}`),
      template,
    },
    body: { elements },
  };
}

export type Ignored = { ignored: string };

function splitList(v: unknown) {
  return String(v ?? '')
    .split(/[,，、;；\s]+/)
    .map((x) => x.trim())
    .filter(Boolean);
}

/** `card.action.trigger` callback -> the same domain command a typed `/agent ...` would produce. */
export function normalizeCardAction(
  body: any,
  config: ProjectConfig,
  routing: RoutingConfig,
  received_at = new Date().toISOString(),
): Command | Ignored {
  const header = body?.header ?? {};
  if (header.app_id !== config.feishu.appId || header.tenant_key !== config.feishu.tenantKey)
    return { ignored: 'tenant_or_app_mismatch' };
  if (header.event_type !== 'card.action.trigger') return { ignored: 'event_not_subscribed' };
  const event = body.event ?? {};
  const chat = event.context?.open_chat_id;
  if (!config.allowlists.feishuChatIds.includes(chat as never)) return { ignored: 'chat_not_allowlisted' };
  const openId = event.operator?.open_id;
  const person = routing.members.find(
    (m) =>
      m.enabled && m.feishuOpenId === openId && config.allowlists.feishuOpenIds.includes(openId as never),
  );
  if (!person) return { ignored: 'identity_unbound' };
  let value: CardActionValue;
  try {
    value = typeof event.action?.value === 'string' ? JSON.parse(event.action.value) : event.action?.value;
  } catch {
    return { ignored: 'card_value_invalid' };
  }
  if (!value || value.v !== 1 || typeof value.t !== 'string' || !Number.isInteger(value.r))
    return { ignored: 'card_value_invalid' };
  const form: Record<string, unknown> = event.action?.form_value ?? {};
  const created = Number(header.create_time);
  const millis = created > 1e15 ? created / 1000 : created > 1e11 ? created : Date.parse(received_at);
  const occurred_at = new Date(millis).toISOString();
  const eventId = String(header.event_id ?? '');
  if (!eventId) return { ignored: 'event_id_missing' };
  const envelope = EventEnvelope.parse({
    schema_version: '1.0',
    event_id: eventId,
    project_id: config.projectKey,
    source: 'feishu_card',
    source_event_id: `card:${eventId}`,
    source_revision: null,
    actor: { kind: 'human', source_actor_id: openId, person_key: person.personKey },
    thread_refs: [{ source: 'feishu', thread_id: event.context?.open_message_id ?? eventId }],
    occurred_at,
    received_at,
    payload_ref: `feishu-card:${eventId}`,
    correlation_ids: { message_id: event.context?.open_message_id ?? '' },
    provenance: {
      trust: 'verified_source',
      method: 'feishu_card_callback',
      observed_at: received_at,
      synthetic: false,
    },
  });
  const versions = () =>
    Object.fromEntries(
      (value.vc ?? []).map((component, i) => [component, String(form[`version__${i}`] ?? '').trim()]),
    );
  const origin = {
    source_chat_id: chat,
    source_message_id: event.context?.open_message_id,
    via_card: true,
    task_id: value.t,
  };
  const base = {
    event_id: eventId,
    occurred_at,
    actor_key: person.personKey,
    source_event_id: `card:${eventId}`,
    envelope,
  };
  switch (value.a) {
    case 'accept':
      return { ...base, event_type: 'human_acceptance', payload: { ...origin, scope_revision: value.r } };
    case 'ack':
      return {
        ...base,
        event_type: 'human_reply',
        payload: { ...origin, expected_revision: value.r, interpretation: 'acknowledgement_only' },
      };
    case 'decline':
      return {
        ...base,
        event_type: 'assignment_declined',
        payload: { ...origin, expected_revision: value.r, reason: '负责人通过卡片表示不由其负责' },
      };
    case 'deliver':
      return {
        ...base,
        event_type: 'delivery_reported',
        payload: {
          ...origin,
          scope_revision: value.s ?? value.r,
          artifact_ref: String(form.artifact_ref ?? '').trim() || undefined,
          test_entry_ref: String(form.test_entry_ref ?? '').trim() || undefined,
          environment: String(form.environment ?? '').trim() || undefined,
          version_refs: versions(),
          note: String(form.note ?? '').trim() || undefined,
        },
      };
    case 'qa':
      return {
        ...base,
        event_type: 'qa_reported',
        payload: {
          ...origin,
          expected_revision: value.r,
          task_revision: value.r,
          result: value.result === 'pass' ? 'pass' : 'fail',
          environment: String(form.environment ?? '').trim() || undefined,
          version_refs: versions(),
          scope: { validation: form.validation === 'sample' ? 'sample' : 'all' },
          evidence_refs: splitList(form.evidence),
          confirm_displayed_scope: true,
        },
      };
    case 'spec':
      return {
        ...base,
        event_type: 'acceptance_defined',
        payload: {
          ...origin,
          expected_revision: value.r,
          complete_from_task: true,
          acceptance_input: {
            expected_behavior: String(form.expected ?? '').trim() || undefined,
            environment: String(form.environment ?? '').trim() || undefined,
            version_requirements: form.versions ? parseVersions(String(form.versions)) : undefined,
            scope_description: String(form.scope ?? '').trim() || undefined,
            validation: form.validation === 'sample' ? 'sample' : 'all',
          },
        },
      };
  }
  return { ignored: 'card_action_unknown' };
}
