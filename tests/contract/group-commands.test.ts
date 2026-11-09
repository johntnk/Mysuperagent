import { it, expect } from 'vitest';
import { loadConfig } from '../../src/config';
import { normalizeFeishu, messageText } from '../../src/adapters/feishu';
import { reduce, drainFake } from '../../src/domain/engine';
import { emptyLedger, newTask, type Command } from '../../src/domain/contracts';
import { localPolicy } from '../../src/policy';
function incoming(text: string, type = 'text') {
  const { config, routing } = loadConfig(),
    cfg: any = config;
  cfg.mode = 'observe';
  cfg.capabilities.readFeishuEvents = true;
  cfg.feishu.appId = 'app_fixture';
  cfg.feishu.tenantKey = 'tenant_fixture';
  cfg.feishu.receiveScope = 'full_group_users';
  cfg.feishu.requiredReceiveScopes = ['im:message.group_msg'];
  cfg.feishu.grantedScopes = ['im:message.group_msg'];
  cfg.allowlists.feishuChatIds = ['oc_fixture'];
  cfg.allowlists.feishuOpenIds = ['ou_fixture'];
  routing.members[0].enabled = true;
  (routing.members[0] as any).feishuOpenId = 'ou_fixture';
  return normalizeFeishu(
    {
      header: {
        event_id: 'evt',
        app_id: 'app_fixture',
        tenant_key: 'tenant_fixture',
        event_type: 'im.message.receive_v1',
      },
      event: {
        sender: { sender_type: 'user', sender_id: { open_id: 'ou_fixture' } },
        message: {
          message_id: 'om_fixture',
          chat_id: 'oc_fixture',
          create_time: '1893974400000',
          message_type: type,
          content: JSON.stringify(
            type === 'text' ? { text } : { zh_cn: { title: '测试反馈', content: [[{ tag: 'text', text }]] } },
          ),
        },
      },
    },
    config,
    routing,
  ) as Command;
}
it('rich posts preserve visible feedback and links without treating embedded text as a command', () => {
  expect(
    messageText(
      'post',
      JSON.stringify({
        zh_cn: {
          title: '反馈',
          content: [
            [
              { tag: 'text', text: '动作异常 ' },
              { tag: 'a', text: '测试记录', href: 'https://fixture.example/case' },
            ],
            [{ tag: 'img', image_key: 'fixture' }],
          ],
        },
      }),
    ),
  ).toContain('https://fixture.example/case');
  expect(incoming('/agent cancel TASK-00001 1 测试', 'post').event_type).toBe('feedback_observed');
});
it('group status requests can read a closed task and reply with its current revision without reopening it', () => {
  const command = incoming('/agent status TASK-00001'),
    policy = localPolicy();
  let s = emptyLedger(policy.project_id);
  s.tasks['TASK-00001'] = newTask('TASK-00001', 'issue', policy.project_id, {
    state: 'cancelled',
    primary_owner_key: command.actor_key,
    revision: 4,
  });
  s = drainFake(reduce(s, command, policy), policy);
  expect(s.tasks['TASK-00001'].state).toBe('cancelled');
  expect(s.fake.messages).toHaveLength(1);
  expect((s.fake.messages[0].body as any).text).toContain('修订 4');
  expect((s.fake.messages[0].body as any).reply_to).toBe('om_fixture');
});
it('rejected stale group commands return a durable reason and leave the task unchanged', () => {
  const command = incoming('/agent due TASK-00001 1 2030-01-08T18:00:00+08:00'),
    policy = localPolicy();
  let s = emptyLedger(policy.project_id);
  s.tasks['TASK-00001'] = newTask('TASK-00001', 'issue', policy.project_id, {
    state: 'in_progress',
    primary_owner_key: command.actor_key,
    revision: 4,
  });
  s = drainFake(reduce(s, command, policy), policy);
  expect(s.tasks['TASK-00001'].schedule.committed_due_at).toBeNull();
  expect(s.tasks['TASK-00001'].revision).toBe(4);
  expect((s.fake.messages[0].body as any).text).toContain('任务已有更新');
});
