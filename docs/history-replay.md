# 用群聊导出离线评估

历史回放把一份群聊导出逐条交给 Agent，记录它每一步会说什么、为什么沉默、登记了哪些任务。它只调用模型接口：不连接飞书、不部署 Cloudflare、不发任何消息。

## 输入

`data/history/messages.json`（或用 `--input` 指定），内容是飞书 `GET /open-apis/im/v1/messages` 返回的消息条目数组；每项也可以是 `{ "raw": item }` 或带多个编辑版本的 `{ "versions": [item, ...] }`。导出文件含真实聊天，`data/` 已被 `.gitignore` 排除。

## 运行

```bash
# .dev.vars 中需要 MODEL_API_KEY、MODEL_BASE_URL、MODEL_ID
npm run replay:history -- --inspect                     # 只统计，不调用模型
npm run replay:history -- --limit 20 --max-cost-usd 5   # 先跑一小段
npm run replay:history -- --resume artifacts/history-replay-<时间>-<id> --limit 500
```

每次运行在 `artifacts/history-replay-*/` 下生成：

- `report.html`：逐条原文与 Agent 输出对照，可筛选“只看发言 / 只看沉默 / 校验拒绝”
- `decisions.jsonl`、`outputs.jsonl`：每一步的结构化判断和拟发言
- `model-inputs.jsonl`：每次模型输入，便于审计
- `replay.sqlite`：可恢复的检查点

## 回放的规则

- 人员从空名单开始：看到发言或 @ 才建立身份，职责只有在原文明确指派或本人承诺时才算确定。
- 每一步只看得到当时已经出现的消息；Agent 的拟发言不会回灌给后续消息，历史上的真人也从未看到过这些发言。
- 历史上的“收到”“修好了”只作为有来源的声明记录，不当作对模拟分派的接手或正式验收。
- 预算到达、模型拒绝或输出校验失败时停止，不会退回假模型继续。

## 公开前脱敏

`demo/` 里的对照页就是由一次回放生成的。若要公开自己的回放结果，请在本地完成脱敏后再提交：人名替换为化名（包括只叫名、昵称和“X老师”等变体），链接、内网地址、共享路径、文档令牌和平台 ID 换成占位符，产品和内部系统代号换成化名；最后用一个检查脚本确认真名、真实 ID 和原文片段都不在仓库中。化名映射表不要提交。
