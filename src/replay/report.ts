import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { ReplayState } from './observer';
import type { ReplayStep } from './store';

const localTime = (at: string) =>
  new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(at));
const code = (text: string) => text.replace(/`/g, 'ˋ');
export async function writeReplayReport(
  directory: string,
  steps: ReplayStep[],
  state: ReplayState,
  manifest: Record<string, unknown>,
) {
  const jsonl = (items: unknown[]) =>
    items.map((x) => JSON.stringify(x)).join('\n') + (items.length ? '\n' : '');
  const rejected = steps.filter((s) => s.evaluation && s.evaluation.status !== 'accepted');
  const isAccepted = (s: ReplayStep) => !s.evaluation || s.evaluation.status === 'accepted';
  const outputs = steps
    .filter((x) => x.decision.emit)
    .map((x) => ({
      step: x.number,
      at: x.at,
      trigger: x.trigger.kind,
      text: x.decision.utterance,
      reason: x.decision.reason,
      evidence_refs: x.decision.evidence_refs,
      delivered: false,
    }));
  await writeFile(resolve(directory, 'manifest.json'), JSON.stringify(manifest, null, 2));
  await writeFile(resolve(directory, 'state.json'), JSON.stringify(state, null, 2));
  await writeFile(resolve(directory, 'source-events.jsonl'), jsonl(state.seen));
  await writeFile(
    resolve(directory, 'model-inputs.jsonl'),
    jsonl(steps.map((x) => ({ step: x.number, input_sha256: x.input_sha256, input: x.input }))),
  );
  await writeFile(resolve(directory, 'decisions.jsonl'), jsonl(steps.map(({ input, ...step }) => step)));
  await writeFile(resolve(directory, 'outputs.jsonl'), jsonl(outputs));
  await writeFile(
    resolve(directory, 'source-items.jsonl'),
    jsonl(Object.values(state.ledger.source_items ?? {})),
  );
  await writeFile(
    resolve(directory, 'reminders.json'),
    JSON.stringify(state.ledger.reminders ?? {}, null, 2),
  );
  await writeFile(
    resolve(directory, 'unresolved-roles.json'),
    JSON.stringify(state.unresolved_roles ?? [], null, 2),
  );
  await writeFile(resolve(directory, 'rejected-decisions.jsonl'), jsonl(rejected));
  const lines = [
    `# 真实群历史回放记录`,
    ``,
    `- 模式：本机历史输入 + 真实模型；所有话术为拟输出，实际发送 0 条。`,
    `- 已处理源事件：${state.cursor}；模型步骤：${steps.length}；拟发言：${outputs.length}；正常沉默：${steps.filter((s) => isAccepted(s) && !s.decision.emit).length}；校验拒绝/模型错误：${rejected.length}。`,
    `- 人员：${Object.keys(state.people).length}；任务建议：${Object.keys(state.ledger.tasks).length}；历史进度声明：${state.task_reports.length}。`,
    `- 原始事项：${Object.keys(state.ledger.source_items ?? {}).length}；已分类：${Object.values(state.ledger.source_items ?? {}).filter((i) => i.category !== 'unclassified').length}；逐项用例：${Object.keys(state.ledger.cases).length}；待确认职责：${state.unresolved_roles?.length ?? 0}。`,
    ...(manifest.test_scope_kind === 'targeted_prefix_probe'
      ? [
          `- 本报告为定向小样本：前缀只导入原消息及身份，不调用模型；仅表中步骤运行模型，不能等同于完整 466 条重新回放。`,
        ]
      : []),
    `- 人员和职责从空状态逐消息识别，未载入预先整理的路由表。`,
    `- 原始输入保持独立；模型拟输出不插入消息流，后续历史回复不视为对 Agent 的回应。`,
    `- 只有编辑版本的消息在编辑时间才提供正文；附件和外链正文未取得。`,
    `- 内部任务使用现有领域状态机；历史进度声明单独标记，不能作为模拟分派已被接手或正式验收的证明。`,
    `- 使用量和价格为 API usage 与配置单价计算的估算，不是账单。运行状态见 manifest.json。`,
    ``,
    `| 步骤 | 北京时间 | 触发 | 发言 | 人员数 | 任务数 |`,
    `| --- | --- | --- | --- | --- | --- |`,
    ...steps.map(
      (s) =>
        `| ${s.number} | ${localTime(s.at)} | ${s.trigger.kind === 'message' ? `消息 ${s.trigger.event.source_index}` : '模拟定时器'} | ${!isAccepted(s) ? '未通过校验' : s.decision.emit ? '是' : '否'} | ${s.people_count} | ${s.task_count} |`,
    ),
    ``,
  ];
  for (const step of steps) {
    lines.push(`## 步骤 ${step.number} · ${localTime(step.at)}`, ``);
    if (step.trigger.kind === 'message')
      lines.push(
        `原消息 ${step.trigger.event.source_index} · \`${code(step.trigger.event.message_id)}\``,
        ``,
        ...step.trigger.event.text.split('\n').map((x) => `> ${x}`),
        ``,
      );
    else lines.push(`模拟定时触发：${step.trigger.reason}`, ``);
    lines.push(
      `**${!isAccepted(step) ? '输出已隔离' : step.decision.emit ? '拟输出' : '保持沉默'}**：${step.decision.reason}`,
      ``,
    );
    if (!isAccepted(step))
      lines.push(`原始模型结果保存在 rejected-decisions.jsonl；本步未执行其任务更改或发言。`, ``);
    if (step.decision.emit) lines.push(step.decision.utterance, ``);
    if (step.decision.role_observations.length)
      lines.push(
        `职责证据：${step.decision.role_observations.map((r) => `${state.people[r.person_key]?.name ?? r.person_key}：${r.responsibility}（${r.certainty}，原文“${r.evidence.quote}”）`).join('；')}`,
        ``,
      );
    if (step.decision.task_reports.length)
      lines.push(
        `历史声明：${step.decision.task_reports.map((r) => `${r.kind}：${r.summary}；范围：${r.scope}`).join(' / ')}`,
        ``,
      );
    lines.push(
      `依据：${step.decision.evidence_refs.join('、') || '无发言依据'}。新任务：${step.created_task_ids.join('、') || '无'}。`,
      ``,
    );
  }
  await writeFile(resolve(directory, 'report.md'), lines.join('\n'));
  const data = JSON.stringify({
    steps: steps.map(({ input, ...step }) => ({ ...step, display_time: localTime(step.at) })),
    manifest,
    people: state.people,
    tasks: state.ledger.tasks,
    reports: state.task_reports,
    source_items: state.ledger.source_items,
    reminders: state.ledger.reminders,
    unresolved_roles: state.unresolved_roles ?? [],
  })
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
  const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-replay-local'"><title>Mysuperagent 历史回放</title>
<style>body{font:15px/1.65 system-ui,sans-serif;margin:0;background:#f4f6f8;color:#182b3a}main{max-width:1200px;margin:auto;padding:32px}h1{margin:0}small,.muted{color:#526578}.top{background:#102d40;color:#fff;padding:28px;border-radius:16px}.top small{color:#d5e5ef}.bar{display:flex;gap:12px;flex-wrap:wrap;margin:20px 0}input,select{padding:10px;border:1px solid #b9c6cf;border-radius:8px}input{flex:1}article{background:white;margin:15px 0;border:1px solid #d8e1e7;border-radius:12px;padding:20px}article h3{margin:0 0 10px}.grid{display:grid;grid-template-columns:1fr 1fr;gap:22px}.text{white-space:pre-wrap;overflow-wrap:anywhere}.output{background:#eff8f5;padding:14px;border-radius:8px}.quiet{background:#f0f2f5}.badge{font-size:12px;background:#dcece6;padding:4px 8px;border-radius:6px;margin-left:10px}summary{cursor:pointer}details{margin-top:12px}pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px}#stats{margin:12px 0}button{padding:8px 14px}@media(max-width:750px){.grid{grid-template-columns:1fr}main{padding:14px}}</style>
<main><div class="top"><h1>Mysuperagent · 历史消息回放</h1><small>固定历史输入 · 逐消息识别人员 · 拟输出独立保存 · 真实发送 0 条</small><div id="stats"></div></div><p class="muted">时间均为北京时间。原文与 Agent 输出左右对照；沉默也是一次决策。历史人员没有见过这些拟输出，后续消息不构成对它的回应。</p>
<div class="bar"><input id="search" placeholder="搜索原文、拟输出或触发依据"><select id="filter"><option value="all">全部步骤</option><option value="speak">仅拟发言</option><option value="silent">仅正常沉默</option><option value="rejected">仅校验拒绝/模型错误</option><option value="timer">仅定时触发</option></select></div><div id="list"></div><details><summary>运行配置、人员与任务状态</summary><pre id="state"></pre></details></main>
<script nonce="replay-local">const data=${data};const byId=id=>document.getElementById(id);const el=(tag,text,cls)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n};byId('stats').textContent='已处理 '+data.manifest.processed_source_events+' 个源事件 · 拟发言 '+data.steps.filter(x=>x.decision.emit).length+' 次 · 模型 '+data.manifest.model+' · 估算 $'+Number(data.manifest.estimated_cost_usd||0).toFixed(4);byId('state').textContent=JSON.stringify({manifest:data.manifest,people:data.people,tasks:data.tasks,historical_reports:data.reports},null,2);
function render(){
 const list=byId('list');list.replaceChildren();const q=byId('search').value.toLowerCase(),f=byId('filter').value;
 for(const s of data.steps){
  const rejected=s.evaluation&&s.evaluation.status!=='accepted';
  if(f==='speak'&&!s.decision.emit||f==='silent'&&(s.decision.emit||rejected)||f==='rejected'&&!rejected||f==='timer'&&s.trigger.kind!=='timer')continue;
  const source=s.trigger.kind==='message'?s.trigger.event.text:s.trigger.reason;
  if(q&&!(source+' '+s.decision.utterance+' '+s.decision.reason).toLowerCase().includes(q))continue;
  const a=el('article'),h=el('h3','步骤 '+s.number+' · '+s.display_time);
  h.append(el('span',rejected?'输出已隔离':s.decision.emit?'拟发言':'沉默','badge'));a.append(h);
  const grid=el('div',undefined,'grid'),left=el('div');
  left.append(el('small',s.trigger.kind==='message'?'原消息 '+s.trigger.event.source_index+' / '+s.trigger.event.message_id:'模拟定时器'),el('div',source,'text'));
  const right=el('div',undefined,'output'+(s.decision.emit?'':' quiet'));
  right.append(el('small',rejected?'未执行模型建议，原始结果见下方详情':s.decision.emit?'Agent 拟输出（未发送）':'Agent 保持沉默'),el('div',s.decision.utterance||'—','text'),el('p','依据：'+s.decision.reason,'muted'));
  grid.append(left,right);a.append(grid);const d=el('details');
  d.append(el('summary','查看证据、职责判断和任务变化'),el('pre',JSON.stringify(s,null,2)));a.append(d);list.append(a);
 }
}byId('search').addEventListener('input',render);byId('filter').addEventListener('change',render);render();</script></html>`;
  await writeFile(resolve(directory, 'report.html'), html);
}
