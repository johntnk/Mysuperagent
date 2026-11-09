import { it, expect } from 'vitest';
import { seed, submit, cmd, policy as fixturePolicy, emptyPlan } from '../coordination-fixture';
import { reduce, drainFake, followupDue } from '../../src/domain/engine';
import { renderCard, normalizeCardAction } from '../../src/adapters/feishu-cards';
import { loadConfig } from '../../src/config';
import type { Command, Effect, Ledger } from '../../src/domain/contracts';
import type { CardSpec } from '../../src/domain/cards';

/** A group where owner / qa / coordinator are bound Feishu members, as the card callback needs. */
function feishu() {
  const { config, routing } = loadConfig();
  const cfg: any = structuredClone(config),
    rt: any = structuredClone(routing);
  cfg.mode = 'observe';
  cfg.capabilities.readFeishuEvents = true;
  cfg.feishu.appId = 'cli_fixture';
  cfg.feishu.tenantKey = 'tenant_fixture';
  cfg.allowlists.feishuChatIds = ['oc_group'];
  cfg.allowlists.feishuOpenIds = ['ou_owner', 'ou_qa', 'ou_coord'];
  rt.members = [
    ['owner', 'ou_owner'],
    ['qa', 'ou_qa'],
    ['coordinator', 'ou_coord'],
  ].map(([personKey, feishuOpenId]) => ({
    personKey,
    displayName: personKey,
    feishuOpenId,
    enabled: true,
    domains: [],
    defaultRole: personKey === 'coordinator' ? 'coordinator' : 'domain_owner',
  }));
  return { config: cfg, routing: rt };
}
const { config, routing } = feishu();
const policy = fixturePolicy();
let clicks = 0;

/** Finds the rendered button for `action` and builds the callback Feishu would POST for that click. */
function click(
  card: CardSpec,
  action: string,
  openId: string,
  form: Record<string, string> = {},
  result?: string,
) {
  const callbacks = (node: any): any[] =>
    !node || typeof node !== 'object'
      ? []
      : [
          ...(Array.isArray(node.behaviors)
            ? node.behaviors.filter((b: any) => b.type === 'callback').map((b: any) => b.value)
            : []),
          ...Object.values(node).flatMap(callbacks),
        ];
  const value = callbacks(renderCard(card)).find((v) => v.a === action && (!result || v.result === result));
  if (!value) throw new Error(`no ${action} button on ${card.kind} card`);
  clicks++;
  const command = normalizeCardAction(
    {
      schema: '2.0',
      header: {
        event_id: `card-evt-${clicks}`,
        event_type: 'card.action.trigger',
        app_id: 'cli_fixture',
        tenant_key: 'tenant_fixture',
        create_time: String(Date.parse('2030-01-07T03:00:00Z') * 1000 + clicks),
      },
      event: {
        operator: { open_id: openId },
        action: { tag: 'button', value, form_value: form },
        context: { open_message_id: 'om_card', open_chat_id: 'oc_group' },
      },
    },
    config,
    routing,
    '2030-01-07T03:00:00.000Z',
  );
  if ('ignored' in command) throw new Error(command.ignored);
  return command as Command;
}
const run = (s: Ledger, c: Command) => drainFake(reduce(s, c, policy), policy);
const cards = (s: Ledger, purpose?: string) =>
  Object.values(s.outbox).filter(
    (e: Effect) => e.request.card && (!purpose || e.request.purpose === purpose),
  );
const latestCard = (s: Ledger, kind: CardSpec['kind'], recipient: string) =>
  cards(s)
    .filter((e) => e.request.card.kind === kind && e.target_owner_key === recipient)
    .at(-1)!.request.card as CardSpec;

function registered() {
  const { s, plan } = seed();
  plan.tasks[0].dependencies = [];
  return drainFake(submit(s, plan), policy);
}

it('a task goes from handoff to verified through card clicks only, with no JSON typed by anyone', () => {
  let s = registered();
  const id = 'TASK-00001';
  expect(s.tasks[id].state).toBe('pending_acceptance');
  // 1. The owner gets a handoff card with three buttons.
  const handoff = latestCard(s, 'handoff', 'owner');
  expect(JSON.stringify(renderCard(handoff))).toMatch(/确认接手.*只是收到.*不是我负责/s);
  s = run(s, click(handoff, 'accept', 'ou_owner'));
  expect(s.tasks[id].state).toBe('in_progress');
  // 2. Accepting brings up the delivery form, pre-filled with the required environment and version.
  const deliver = latestCard(s, 'deliver', 'owner');
  expect(deliver.defaults).toMatchObject({ environment: 'lab', 'version:service': 'release_2' });
  s = run(
    s,
    click(deliver, 'deliver', 'ou_owner', {
      artifact_ref: 'https://example.invalid/patch',
      test_entry_ref: 'https://example.invalid/build',
      environment: 'lab',
      version__0: 'release_2',
    }),
  );
  expect(s.tasks[id].state).toBe('ready_for_qa');
  // 3. The verifier gets the QA form. Sampling cannot verify a full-scope task.
  const qa = latestCard(s, 'qa', 'qa');
  const form = { environment: 'lab', version__0: 'release_2', evidence: 'https://example.invalid/recording' };
  s = run(s, click(qa, 'qa', 'ou_qa', { ...form, validation: 'sample' }, 'pass'));
  expect(s.tasks[id].state).toBe('ready_for_qa');
  expect(s.audit.at(-1)).toMatchObject({ type: 'qa_rejected', reason: 'scope_incomplete' });
  s = run(s, click(qa, 'qa', 'ou_qa', { ...form, validation: 'all' }, 'pass'));
  expect(s.tasks[id].state).toBe('verified');
  expect(s.fake.messages.some((m) => (m.body as any).purpose === 'qa_result')).toBe(true);
});

it('the wrong person clicking, or a stale card, changes nothing', () => {
  let s = registered();
  const handoff = latestCard(s, 'handoff', 'owner');
  const before = s.tasks['TASK-00001'];
  s = run(s, click(handoff, 'accept', 'ou_qa'));
  expect(s.tasks['TASK-00001']).toEqual(before);
  expect(s.audit.at(-1)).toMatchObject({ type: 'rejected', reason: 'not_current_owner' });
  const unbound = normalizeCardAction(
    {
      header: {
        event_id: 'x',
        event_type: 'card.action.trigger',
        app_id: 'cli_fixture',
        tenant_key: 'tenant_fixture',
      },
      event: {
        operator: { open_id: 'ou_stranger' },
        action: { value: { v: 1, a: 'accept', t: 'TASK-00001', r: 1 } },
        context: { open_chat_id: 'oc_group' },
      },
    },
    config,
    routing,
  );
  expect(unbound).toEqual({ ignored: 'identity_unbound' });
});

it('declining hands the task back to the coordinator instead of nagging the wrong person', () => {
  let s = registered();
  s = run(s, click(latestCard(s, 'handoff', 'owner'), 'decline', 'ou_owner'));
  const t = s.tasks['TASK-00001'];
  expect(t).toMatchObject({ state: 'needs_clarification', primary_owner_key: null, next_condition: null });
  const notice = Object.values(s.outbox).find((e) => e.request.purpose === 'reassignment_needed')!;
  expect(notice).toMatchObject({ target_owner_key: 'coordinator', state: 'succeeded' });
  expect(notice.request.text).toContain('reassign TASK-00001');
});

it('missing acceptance criteria go to the verifier as a form; saving them re-confirms the scope with the owner', () => {
  const { s: seeded, plan } = seed();
  plan.tasks[0].dependencies = [];
  plan.tasks[0].acceptance.environment = null;
  let s = drainFake(submit(seeded, plan), policy);
  s = run(s, click(latestCard(s, 'handoff', 'owner'), 'accept', 'ou_owner'));
  const spec = latestCard(s, 'spec', 'qa');
  expect(spec.facts.find(([k]) => k === '还缺')?.[1]).toContain('验收环境');
  s = run(
    s,
    click(spec, 'spec', 'ou_qa', {
      expected: '转三圈',
      environment: 'lab',
      versions: 'service=release_2',
      scope: '原用例完整动作',
      validation: 'all',
    }),
  );
  const t = s.tasks['TASK-00001'];
  expect(t.acceptance_spec).toMatchObject({ environment: 'lab', qa_owner_key: 'qa' });
  expect(t.state).toBe('pending_acceptance');
  expect(latestCard(s, 'handoff', 'owner').intro).toContain('验收标准已更新');
});

it('a natural-language claim in chat becomes a one-click confirmation for that person only', () => {
  let s = registered();
  s = run(s, click(latestCard(s, 'handoff', 'owner'), 'accept', 'ou_owner'));
  const t = s.tasks['TASK-00001'];
  s = run(s, {
    ...cmd('chat-fixed', 'source_message_observed', { text: '转圈那个我改好了，晚点发包' }, 'owner'),
    source_event_id: 'chat-fixed',
    source_revision: 'r1',
  });
  const item = Object.values(s.source_items).find((i) => i.event_id === 'chat-fixed')!;
  const plan = emptyPlan();
  plan.dispositions = [
    {
      item_id: item.item_id,
      category: 'context',
      task_keys: [],
      related_item_id: null,
      reason: '进展声明',
      expected_behavior: null,
      observed_behavior: null,
      resource_refs: [],
    },
  ];
  plan.reports = [
    {
      internal_task_id: t.task_id,
      expected_revision: t.revision,
      source_item_id: item.item_id,
      kind: 'delivery_claimed',
      summary: '负责人表示已修改',
      scope: '转圈次数',
    },
  ];
  s = run(
    s,
    cmd('analysis-claim', 'analysis_completed', {
      coordination: plan,
      notify: false,
      current_item_ids: [item.item_id],
    }),
  );
  expect(s.tasks[t.task_id].state).toBe('in_progress'); // a claim is not a delivery
  const claim = cards(s, 'claim_confirmation');
  expect(claim).toHaveLength(1);
  expect(claim[0]).toMatchObject({ target_owner_key: 'owner' });
  expect(claim[0].request.card.kind).toBe('deliver');
});

it('reminders name the task, say what is expected and carry the same buttons', () => {
  let s = registered();
  const t = s.tasks['TASK-00001'];
  const due = t.next_condition!.not_before!;
  expect(followupDue(s, t, due, policy)).toBe(true);
  s = run(
    s,
    cmd('tick', 'timer_fired', { task_id: t.task_id, expected_revision: t.revision }, 'system', due),
  );
  const reminder = Object.values(s.outbox).find((e) => e.request.purpose === 'followup')!;
  expect(reminder.request.card.kind).toBe('handoff');
  expect(reminder.request.text).toContain('TASK-00001');
  expect(reminder.request.text).toContain('提醒');
  expect(reminder.request.text).toContain('/agent accept TASK-00001');
  expect(Object.keys(s.events).some((k) => k.includes('timer_fired'))).toBe(false);
});
