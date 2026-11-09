import { it, expect, vi, beforeEach } from 'vitest';
import { parseCommand } from '../../src/adapters/feishu-commands';
import {
  normalizeFeishu,
  FeishuMessageAdapter,
  FeishuClient,
  RetryableFailure,
  resetFeishuTokenCache,
  messageImageKeys,
} from '../../src/adapters/feishu';
import { cardCallback } from '../../src/adapters/feishu-callback';
import { renderCard } from '../../src/adapters/feishu-cards';
import { loadConfig } from '../../src/config';
import { reduce, drainFake } from '../../src/domain/engine';
import { emptyLedger, newTask, type Command } from '../../src/domain/contracts';
import { localPolicy } from '../../src/policy';
import { handoffCard } from '../../src/domain/cards';

const opts = { prefix: '/agent', timeZone: 'Asia/Shanghai', dayEnd: '18:00' };
beforeEach(() => resetFeishuTokenCache());

it('commands typed on a phone work: no revision, full-width punctuation, smart quotes, Chinese verbs', () => {
  expect(parseCommand('/agent accept TASK-00001', opts)).toEqual({
    kind: 'command',
    event_type: 'human_acceptance',
    payload: { task_id: 'TASK-00001' },
  });
  expect(parseCommand('/agent 接手 task-00001 3', opts)).toMatchObject({
    payload: { task_id: 'TASK-00001', scope_revision: 3 },
  });
  expect(
    parseCommand(
      '/agent deliver TASK-00002 产物＝https://example.invalid/p 入口：https://example.invalid/t 环境=staging 版本=service:1.4.2,client:2.0 修复了转圈',
      opts,
    ),
  ).toMatchObject({
    event_type: 'delivery_reported',
    payload: {
      artifact_ref: 'https://example.invalid/p',
      test_entry_ref: 'https://example.invalid/t',
      environment: 'staging',
      version_refs: { service: '1.4.2', client: '2.0' },
      note: '修复了转圈',
    },
  });
  expect(
    parseCommand('/agent 验收 TASK-00002 通过 范围=全量 证据=“https://example.invalid/rec”', opts),
  ).toMatchObject({
    event_type: 'qa_reported',
    payload: {
      result: 'pass',
      scope: { validation: 'all' },
      evidence_refs: ['https://example.invalid/rec'],
      confirm_displayed_scope: true,
    },
  });
  expect(parseCommand('/agent due TASK-00002 2030-01-08 18:00', opts)).toMatchObject({
    payload: { committed_due_at: '2030-01-08T18:00:00+08:00' },
  });
  expect(parseCommand('/agent deliver TASK-00002 {“artifact_ref”:“p”}', opts)).toMatchObject({
    payload: { artifact_ref: 'p' },
  });
});

it('malformed commands become a usage reply instead of an HTTP error', () => {
  expect(parseCommand('/agent deliver TASK-1 {broken', opts)).toEqual({
    kind: 'invalid',
    reason: 'json_invalid',
  });
  expect(parseCommand('/agent qa TASK-00001 范围=全量', opts)).toEqual({
    kind: 'invalid',
    reason: 'qa_result_missing',
  });
  expect(parseCommand('/agent frobnicate TASK-00001', opts)).toEqual({
    kind: 'invalid',
    reason: 'unknown_command',
  });
  expect(parseCommand('/agentx accept TASK-00001', opts)).toBeNull();
  expect(parseCommand('请看 /agent accept', opts)).toBeNull();
});

function group(text: string, extra: Record<string, unknown> = {}) {
  const { config, routing } = loadConfig();
  const cfg: any = structuredClone(config),
    rt: any = structuredClone(routing);
  cfg.mode = 'observe';
  cfg.capabilities.readFeishuEvents = true;
  cfg.feishu.appId = 'cli_fixture';
  cfg.feishu.tenantKey = 'tenant_fixture';
  cfg.feishu.receiveScope = 'full_group_users';
  cfg.feishu.grantedScopes = [...cfg.feishu.requiredReceiveScopes];
  cfg.allowlists.feishuChatIds = ['oc_group'];
  cfg.allowlists.feishuOpenIds = ['ou_member'];
  rt.members[0].enabled = true;
  rt.members[0].feishuOpenId = 'ou_member';
  const body = {
    header: {
      event_id: 'evt-1',
      app_id: 'cli_fixture',
      tenant_key: 'tenant_fixture',
      event_type: 'im.message.receive_v1',
    },
    event: {
      sender: { sender_type: 'user', sender_id: { open_id: 'ou_member' } },
      message: {
        message_id: 'om_msg',
        chat_id: 'oc_group',
        create_time: '1893974400000',
        message_type: 'text',
        content: JSON.stringify({ text }),
        ...extra,
      },
    },
  };
  return { body, config: cfg, routing: rt };
}

it('events we do not handle are acknowledged as ignored, so Feishu does not keep re-delivering them', () => {
  const { body, config, routing } = group('hello');
  expect(
    normalizeFeishu(
      { ...body, header: { ...body.header, event_type: 'im.chat.member.bot.added_v1' } },
      config,
      routing,
    ),
  ).toEqual({
    ignored: 'event_not_subscribed',
  });
  const other = structuredClone(body);
  other.event.message.chat_id = 'oc_other';
  expect(normalizeFeishu(other, config, routing)).toEqual({ ignored: 'chat_not_allowlisted' });
  const bot = structuredClone(body);
  bot.event.sender.sender_type = 'app';
  expect(normalizeFeishu(bot, config, routing)).toEqual({ ignored: 'not_human_sender' });
});

it('a malformed command in the group gets a reply with the reason and the usage', () => {
  const { body, config, routing } = group('/agent deliver TASK-00001 {broken');
  const c = normalizeFeishu(body, config, routing) as Command;
  expect(c.event_type).toBe('command_invalid');
  const policy = localPolicy();
  const s = drainFake(reduce(emptyLedger(policy.project_id), c, policy), policy);
  const reply = s.fake.messages[0].body as any;
  expect(reply.reply_to).toBe('om_msg');
  expect(reply.text).toContain('JSON 格式有误');
  expect(reply.text).toContain('/agent deliver TASK-00001 产物=');
});

it('screenshots in image and rich-text messages are found for the analysis', () => {
  expect(messageImageKeys('image', JSON.stringify({ image_key: 'img_v3_a' }))).toEqual(['img_v3_a']);
  expect(
    messageImageKeys(
      'post',
      JSON.stringify({
        zh_cn: {
          content: [
            [
              { tag: 'text', text: '截图' },
              { tag: 'img', image_key: 'img_v3_b' },
            ],
          ],
        },
      }),
    ),
  ).toEqual(['img_v3_b']);
  const { body, config, routing } = group('', {
    message_type: 'image',
    content: JSON.stringify({ image_key: 'img_v3_c' }),
  });
  expect((normalizeFeishu(body, config, routing) as Command).payload.image_keys).toEqual(['img_v3_c']);
});

function pilot() {
  const config: any = structuredClone(loadConfig().config);
  config.mode = 'pilot';
  config.feishu.appId = 'cli_fixture';
  config.feishu.grantedScopes = ['im:message:send_as_bot'];
  return config;
}

it('a network failure while getting the tenant token is retryable, never an unknown write', async () => {
  const transport = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
  const adapter = new FeishuMessageAdapter(pilot(), { FEISHU_APP_SECRET: 's' }, transport, () => {});
  await expect(
    adapter.execute({
      operation_id: 'op',
      capability: 'message.send',
      target: 'oc_group',
      request: { text: 'x' },
    } as any),
  ).rejects.toBeInstanceOf(RetryableFailure);
});

it('the tenant token is cached; unknown sends are resent only inside the one-hour uuid window', async () => {
  const transport = vi.fn(async (url: string) =>
    url.includes('/auth/')
      ? Response.json({ code: 0, tenant_access_token: 't', expire: 7200 })
      : Response.json({ code: 0, data: { message_id: 'om_sent' } }),
  );
  const client = new FeishuClient(pilot(), { FEISHU_APP_SECRET: 's' }, transport as any);
  await client.token();
  await client.token();
  expect(transport).toHaveBeenCalledTimes(1);
  const adapter = new FeishuMessageAdapter(pilot(), { FEISHU_APP_SECRET: 's' }, transport as any, () => {});
  const now = Date.parse('2030-01-07T02:00:00Z');
  expect(await adapter.reconcile({ first_attempt_at: '2030-01-07T01:30:00Z' } as any, now)).toEqual({
    status: 'retry_safe',
  });
  expect(await adapter.reconcile({ first_attempt_at: '2030-01-07T00:30:00Z' } as any, now)).toMatchObject({
    status: 'unknown',
  });
  expect(await adapter.reconcile({} as any, now)).toMatchObject({ status: 'unknown' });
});

it('cards are sent as interactive JSON 2.0 with untrusted text as plain_text and the mention resolved', async () => {
  const transport = vi.fn(async (url: string, _init?: any) =>
    url.includes('/auth/')
      ? Response.json({ code: 0, tenant_access_token: 't' })
      : Response.json({ code: 0, data: { message_id: 'om_sent' } }),
  );
  const task = newTask('TASK-00007', 'issue', 'demo-project', {
    title: '<at id=all></at> [链接](https://evil.invalid)',
    state: 'pending_acceptance',
    primary_owner_key: 'owner',
  });
  const card = handoffCard(task);
  await new FeishuMessageAdapter(pilot(), { FEISHU_APP_SECRET: 's' }, transport as any, () => {}).execute({
    operation_id: 'handoff:TASK-00007:1',
    capability: 'message.send',
    target: 'oc_group',
    request: { card, text: 'fallback', mention_open_id: 'ou_owner' },
  } as any);
  const payload = JSON.parse(transport.mock.calls[1][1].body);
  expect(payload.msg_type).toBe('interactive');
  const sent = JSON.parse(payload.content);
  expect(sent.schema).toBe('2.0');
  expect(JSON.stringify(sent)).toContain('<at id=ou_owner></at>');
  const title = sent.body.elements.find((e: any) => e.tag === 'div' && e.text.content.includes('evil'));
  expect(title.text.tag).toBe('plain_text');
  expect(
    sent.body.elements
      .filter((e: any) => e.tag === 'markdown')
      .map((e: any) => e.content)
      .join(),
  ).not.toContain('all');
  expect(renderCard(card).header.title.content).toContain('TASK-00007');
});

it('plain-text messages cannot smuggle tags such as @all', async () => {
  const transport = vi.fn(async (url: string, _init?: any) =>
    url.includes('/auth/')
      ? Response.json({ code: 0, tenant_access_token: 't' })
      : Response.json({ code: 0, data: { message_id: 'om_sent' } }),
  );
  await new FeishuMessageAdapter(pilot(), { FEISHU_APP_SECRET: 's' }, transport as any, () => {}).execute({
    operation_id: 'op-text',
    capability: 'message.send',
    target: 'oc_group',
    request: { text: '请看 <at user_id="all">所有人</at> & 1<2' },
  } as any);
  const text = JSON.parse(JSON.parse(transport.mock.calls[1][1].body).content).text;
  expect(text).not.toContain('<at');
  expect(text).toContain('＜at user_id="all"＞');
  expect(text).toContain('& 1＜2');
});

it('image download refuses oversized or non-image payloads', async () => {
  const transport = vi.fn(async (url: string) =>
    url.includes('/auth/')
      ? Response.json({ code: 0, tenant_access_token: 't' })
      : new Response(new Uint8Array(2048), {
          headers: { 'content-type': 'image/png', 'content-length': '2048' },
        }),
  );
  const client = new FeishuClient(pilot(), { FEISHU_APP_SECRET: 's' }, transport as any);
  expect(await client.messageImage('om_x', 'img_v3_a', 4096)).toMatch(/^data:image\/png;base64,/);
  expect(await client.messageImage('om_x', 'img_v3_a', 1024)).toBeNull();
  await expect(client.messageImage('../om', 'img', 4096)).rejects.toThrow('image_ref_invalid');
});

it('card clicks answer with a precise toast: success, rejection reason, duplicate, unbound user', async () => {
  const { config, routing } = group('x');
  const body = (openId: string) => ({
    header: {
      event_id: `e-${openId}`,
      event_type: 'card.action.trigger',
      app_id: 'cli_fixture',
      tenant_key: 'tenant_fixture',
    },
    event: {
      operator: { open_id: openId },
      action: { value: { v: 1, a: 'accept', t: 'TASK-00001', r: 1 } },
      context: { open_message_id: 'om_card', open_chat_id: 'oc_group' },
    },
  });
  const reply = async (result: unknown, openId = 'ou_member') => {
    const res = await cardCallback(body(openId), config, routing, async () => Response.json(result));
    return ((await res.json()) as any).toast;
  };
  expect(await reply({ accepted: true, task: { state: 'in_progress' } })).toMatchObject({ type: 'success' });
  expect(await reply({ accepted: true, rejected: 'not_current_owner' })).toEqual({
    type: 'error',
    content: '未执行：需由当前主负责人确认。',
  });
  expect(await reply({ accepted: true, duplicate: true })).toMatchObject({ type: 'info' });
  expect(await reply({}, 'ou_stranger')).toMatchObject({
    type: 'warning',
    content: expect.stringContaining('没有绑定'),
  });
});
