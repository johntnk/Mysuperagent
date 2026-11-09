import type { ProjectConfig, RoutingConfig } from '../config';
import { rejectionText } from '../domain/engine';
import { normalizeCardAction } from './feishu-cards';

/**
 * Handles a verified `card.action.trigger`: turns the click into a domain command, records it, and
 * answers with the toast Feishu shows to the clicking person (the response must arrive within 3 s).
 */
const toast = (type: 'success' | 'info' | 'warning' | 'error', content: string) =>
  Response.json({ toast: { type, content } });
const IGNORED_TOAST: Record<string, string> = {
  identity_unbound: '你的飞书账号还没有绑定为项目成员，这次操作没有记录。',
  chat_not_allowlisted: '这个群没有启用协调助手。',
};
export async function cardCallback(
  body: any,
  config: ProjectConfig,
  routing: RoutingConfig,
  forward: (path: string, body?: unknown) => Promise<Response>,
) {
  const c = normalizeCardAction(body, config, routing);
  if ('ignored' in c) return toast('warning', IGNORED_TOAST[c.ignored] ?? '这次操作无法识别，没有记录。');
  let result: any;
  try {
    const r = await forward('/ingest', c);
    if (!r.ok) return toast('error', '服务暂时不可用，请稍后重试。');
    result = await r.json();
  } catch {
    return toast('error', '服务暂时不可用，请稍后重试。');
  }
  if (result.duplicate) return toast('info', '这次操作已经处理过了。');
  if (result.rejected) return toast('error', `未执行：${rejectionText(result.rejected)}。`);
  const state = result.task?.state;
  const done: Record<string, string> = {
    human_acceptance:
      state === 'blocked' ? '已确认接手；依赖满足后再开始交付。' : '已确认接手，交付表单已发到群里。',
    human_reply: '已记录：收到（还没有确认接手）。',
    assignment_declined: '已退回，协调人会重新安排负责人。',
    delivery_reported:
      state === 'ready_for_qa' ? '交付已提交，已通知验收人。' : '已记录交付，还缺的信息已在群里列出。',
    qa_reported: state === 'verified' ? '验收通过，已记录。' : '已记录：验收未通过，任务回到处理中。',
    acceptance_defined: '验收标准已保存，负责人需要重新确认接手。',
  };
  return toast('success', done[c.event_type] ?? '已记录。');
}
