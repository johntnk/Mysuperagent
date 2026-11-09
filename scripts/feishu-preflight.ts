import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { parseEnv } from 'node:util';
const secrets = parseEnv(await readFile('.dev.vars', 'utf8'));
const config = JSON.parse(await readFile('config/project.observe.local.json', 'utf8'));
if (!process.argv.includes('--read-only')) throw new Error('READ_ONLY_FLAG_REQUIRED');
if (!secrets.FEISHU_APP_SECRET || !config.feishu.appId) throw new Error('APP_CREDENTIAL_NOT_CONFIGURED');
const call = async (path: string, token?: string, body?: unknown) => {
  const r = await fetch(`https://open.feishu.cn/open-apis/${path}`, {
    method: body ? 'POST' : 'GET',
    redirect: 'error',
    signal: AbortSignal.timeout(15000),
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j: any = await r.json();
  return { status: r.status, data: j };
};
const auth = await call('auth/v3/tenant_access_token/internal', undefined, {
  app_id: config.feishu.appId,
  app_secret: secrets.FEISHU_APP_SECRET,
});
if (auth.data.code !== 0 || !auth.data.tenant_access_token) {
  console.log(JSON.stringify({ auth_http: auth.status, auth_code: auth.data.code, authenticated: false }));
  process.exit(1);
}
const token = auth.data.tenant_access_token;
const bot = await call('bot/v3/info/', token);
const chatId = config.allowlists.feishuChatIds[0];
const chat = await call(`im/v1/chats/${encodeURIComponent(chatId)}`, token);
const members = await call(
  `im/v1/chats/${encodeURIComponent(chatId)}/members?member_id_type=open_id&page_size=100`,
  token,
);
const report = {
  checked_at: new Date().toISOString(),
  app_id: config.feishu.appId,
  chat_id: chatId,
  authenticated: true,
  bot: {
    http: bot.status,
    code: bot.data.code,
    open_id: bot.data.bot?.open_id || bot.data.data?.bot?.open_id || null,
  },
  chat: { http: chat.status, code: chat.data.code, name: chat.data.data?.name || null },
  members: {
    http: members.status,
    code: members.data.code,
    count: members.data.data?.items?.length ?? null,
    has_more: members.data.data?.has_more ?? null,
  },
  writes: 0,
};
if (report.bot.code === 0 && report.bot.open_id) {
  config.feishu.botOpenId = report.bot.open_id;
  await writeFile('config/project.observe.local.json', JSON.stringify(config, null, 2) + '\n');
}
if (members.data.code === 0)
  await writeFile(
    'config/current-members.local.json',
    JSON.stringify(
      {
        app_id: config.feishu.appId,
        chat_id: chatId,
        checked_at: report.checked_at,
        items: members.data.data?.items || [],
        has_more: members.data.data?.has_more,
      },
      null,
      2,
    ),
  );
const directory = `artifacts/preflight-${Date.now()}`;
await mkdir(directory, { recursive: true });
await writeFile(`${directory}/feishu.json`, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
