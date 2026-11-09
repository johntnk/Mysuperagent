# 接入飞书

## 1. 创建应用

在飞书开放平台创建企业自建应用，开启**机器人**能力，把机器人拉进要协作的群。

| 用途                    | 权限                               | 何时需要                                      |
| ----------------------- | ---------------------------------- | --------------------------------------------- |
| 只接收 @机器人 的群消息 | `im:message.group_at_msg:readonly` | `receiveScope = mentions_only`（默认）        |
| 接收群内全部消息        | `im:message.group_msg`             | `receiveScope = full_group_users`，协作群推荐 |
| 以应用身份发消息、卡片  | `im:message:send_as_bot`           | 需要发消息时                                  |
| 读取消息里的截图        | `im:message:readonly`              | `capabilities.readMessageImages = true` 时    |

把实际已开通的权限写进本地配置的 `feishu.grantedScopes`，程序会据此检查是否具备接收和发送条件。

## 2. 事件与回调

| 订阅     | 类型                                    | 请求地址                                      |
| -------- | --------------------------------------- | --------------------------------------------- |
| 事件订阅 | `im.message.receive_v1`                 | `https://<worker>/integrations/feishu/events` |
| 回调订阅 | `card.action.trigger`（卡片按钮、表单） | 同上                                          |

两处都配置 **Encrypt Key** 和 **Verification Token**，并把它们写入 Worker 的 secret：

```
FEISHU_APP_SECRET=...
FEISHU_ENCRYPT_KEY=...
FEISHU_VERIFICATION_TOKEN=...
```

校验规则：

- 请求地址校验（`url_verification`）会先解密，只核对 Verification Token。飞书不对这类请求签名，官方文档注明签名校验“不包括请求网址校验”。
- 其余事件和卡片回调必须带有效的 `X-Lark-Signature`（`sha256(timestamp + nonce + encrypt_key + body)`），时间戳偏差不超过 5 分钟，并通过 Token 校验。
- 不属于本项目的事件（其他群、其他事件类型、机器人自己的消息）返回 `200 {"ignored": ...}`，避免飞书重复推送。验签失败返回 401。
- 卡片回调在 3 秒内返回 toast：成功、未执行的原因（例如“需由当前主负责人确认”）、重复点击，或“你的飞书账号还没有绑定为项目成员”。

## 3. 本地配置

```bash
cp config/project.example.json config/project.observe.local.json
cp config/routing.example.json config/routing.local.json
cp .dev.vars.example .dev.vars
```

在 `project.observe.local.json` 中填写：

- `mode: "observe"`、`environment: "test"`
- `feishu.appId`、`tenantKey`、`botOpenId`、`receiveScope`、`grantedScopes`
- `allowlists.feishuChatIds`（只处理这些群）和 `allowlists.feishuOpenIds`（已核验的成员）
- `capabilities`：`readFeishuEvents`、`modelInference`，pilot 阶段再开 `sendMessages`
- `notifications`：工作日、工作时间、冷却时间、每日提醒上限；`policyStatus` 改为 `confirmed` 后才会真正发提醒

在 `routing.local.json` 中为每位成员填写 `personKey`、`displayName`、`feishuOpenId`，`enabled: true`，协调人的 `defaultRole` 设为 `coordinator`。人名只是显示用，真正的身份是 `feishuOpenId`，并且必须同时出现在 `allowlists.feishuOpenIds` 中。

`*.local.json`、`.dev.vars` 已被 `.gitignore` 排除，不要把真实 ID 或密钥提交到仓库。

## 4. 部署与上线顺序

```bash
npm run check:config -- --local      # 列出缺少的配置项（不会打印密钥值）
npm run prepare:deployment           # 生成独立的测试 Worker / Workflow 配置，默认 observe
```

1. **observe**：只读。Agent 记录事项、登记任务、生成拟发言，但不发任何消息。用 `/api/state`（需要 `ADMIN_AUTH_TOKEN`）检查它的判断。
2. **pilot**：只在测试群、只对已核验成员发卡片和提醒。
3. **active**：确认效果后再扩大到正式群。

模式只能通过配置切换，群消息里的任何内容都不能改变模式、白名单或权限。
