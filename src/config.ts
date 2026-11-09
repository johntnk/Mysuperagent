import { z } from 'zod';
import defaultConfig from '../config/project.example.json';
import defaultRouting from '../config/routing.example.json';
import { Mode } from './domain/contracts';
import { type Policy } from './policy';
export type ProjectConfig = typeof defaultConfig;
export type RoutingConfig = typeof defaultRouting;
export type Secrets = Record<string, string | undefined>;
/** Fills settings added in later versions, so an older local config keeps working unchanged. */
function withDefaults<T>(value: any, defaults: T): T {
  if (Array.isArray(defaults) || defaults === null || typeof defaults !== 'object') return value ?? defaults;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
  const out: any = { ...value };
  for (const [key, d] of Object.entries(defaults as Record<string, unknown>))
    out[key] = key in value ? withDefaults(value[key], d) : structuredClone(d);
  return out;
}
export function loadConfig(env: Secrets = {}) {
  const config: ProjectConfig = env.PROJECT_CONFIG_JSON
    ? withDefaults(JSON.parse(env.PROJECT_CONFIG_JSON), defaultConfig)
    : structuredClone(defaultConfig);
  const routing: RoutingConfig = env.ROUTING_CONFIG_JSON
    ? JSON.parse(env.ROUTING_CONFIG_JSON)
    : structuredClone(defaultRouting);
  Mode.parse(config.mode);
  z.enum(['local', 'test', 'production']).parse(config.environment);
  if (env.MODE && env.MODE !== config.mode) throw new Error('MODE_CONFIG_MISMATCH');
  if (env.ENVIRONMENT && env.ENVIRONMENT !== config.environment)
    throw new Error('ENVIRONMENT_CONFIG_MISMATCH');
  if (config.projectKey !== routing.projectKey || config.schemaVersion !== 1 || !config.projectKey)
    throw new Error('PROJECT_CONFIG_INVALID');
  if (config.mode === 'pilot' && config.environment !== 'test') throw new Error('PILOT_REQUIRES_TEST');
  new Intl.DateTimeFormat('en', { timeZone: config.timezone });
  for (const v of Object.values(config.budgets))
    if (!Number.isFinite(v) || v <= 0) throw new Error('BUDGET_INVALID');
  if (
    config.budgets.maxConcurrentRuns > 10 ||
    config.budgets.modelCallsPerRun > 10 ||
    config.budgets.maxInputCharacters > 1000000 ||
    config.budgets.maxImagesPerRun > 10 ||
    config.budgets.maxImageBytes > 20000000
  )
    throw new Error('BUDGET_TOO_LARGE');
  if (config.budgets.maxInputCharacters < 8000) throw new Error('BUDGET_INVALID');
  const identities: Policy['identities'] = {};
  for (const m of routing.members)
    if (m.enabled) {
      if (config.mode === 'mock')
        identities[m.personKey] = { id: `fake_${m.personKey}`, verified: true, synthetic: true };
      else if (m.feishuOpenId && config.allowlists.feishuOpenIds.includes(m.feishuOpenId as never))
        identities[m.personKey] = { id: m.feishuOpenId, verified: true, synthetic: false };
    }
  const capabilities: string[] = [];
  if (config.capabilities.writeWorkItems)
    capabilities.push('work_item.create', 'work_item.update', 'work_item.comment');
  if (config.capabilities.sendMessages) capabilities.push('message.send', 'message.reply', 'message.update');
  if (config.capabilities.readEvidence) capabilities.push('evidence.read', 'resource_status.read');
  const policy: Policy = {
    mode: Mode.parse(config.mode),
    transport: config.mode === 'mock' ? 'fake' : 'real',
    environment: config.environment as Policy['environment'],
    project_id: config.projectKey,
    task_backend: config.workItemBackend.type === 'agent_ledger' ? 'agent_ledger' : 'feishu_project',
    command_prefix: config.feishu.commandPrefix || '/agent',
    targets: [
      ...config.allowlists.feishuChatIds,
      ...config.allowlists.feishuProjectSpaceIds,
      ...config.allowlists.evidenceSourceIds,
    ],
    capabilities,
    identities,
    decision_owners: routing.members
      .filter((m) => m.defaultRole === 'coordinator' && (config.mode === 'mock' || identities[m.personKey]))
      .map((m) => m.personKey),
    notifications: {
      enabled: config.notifications.enabled,
      confirmed: config.notifications.policyStatus === 'confirmed',
      timezone: config.timezone,
      start: config.notifications.workHours.start,
      end: config.notifications.workHours.end,
      days: config.notifications.workdays,
      cooldown_minutes: config.notifications.cooldownMinutes,
      max_per_day: config.notifications.maxMentionsPerTaskPerDay,
    },
  };
  return { config, routing, policy };
}
export function readiness(config: ProjectConfig, routing: RoutingConfig, env: Secrets) {
  const missing: string[] = [];
  const need = (ok: unknown, key: string) => {
    if (!ok) missing.push(key);
  };
  need(config.feishu.appId, 'feishu.appId');
  need(config.feishu.tenantKey, 'feishu.tenantKey');
  need(config.feishu.botOpenId, 'feishu.botOpenId');
  need(config.allowlists.feishuChatIds.length, 'allowlists.feishuChatIds');
  need(
    routing.members.some((x) => x.enabled && x.feishuOpenId),
    'verified_members',
  );
  for (const k of [
    'FEISHU_APP_SECRET',
    'FEISHU_VERIFICATION_TOKEN',
    'FEISHU_ENCRYPT_KEY',
    'ADMIN_AUTH_TOKEN',
    'CONNECTOR_AUTH_TOKEN',
  ])
    need(env[k], k);
  if (config.workItemBackend.type !== 'agent_ledger') {
    const backend = config.workItemBackend.feishuProject;
    need(backend.spaceId, 'feishuProject.spaceId');
    need(backend.workItemTypeId, 'feishuProject.workItemTypeId');
    need(backend.authMode, 'feishuProject.authMode');
    need(env.FEISHU_PROJECT_AUTH_TOKEN, 'FEISHU_PROJECT_AUTH_TOKEN');
    need(env.FEISHU_PROJECT_ACTOR_KEY, 'FEISHU_PROJECT_ACTOR_KEY');
    for (const [k, v] of Object.entries(config.workItemBackend.fieldMappings)) need(v, `fieldMappings.${k}`);
    for (const [k, v] of Object.entries(config.workItemBackend.stateMappings)) need(v, `stateMappings.${k}`);
  }
  need(env.MODEL_API_KEY, 'MODEL_API_KEY');
  need(env.MODEL_ID, 'MODEL_ID');
  need(env.MODEL_BASE_URL, 'MODEL_BASE_URL');
  if (config.capabilities.readFeishuEvents)
    for (const scope of config.feishu.requiredReceiveScopes)
      need(config.feishu.grantedScopes.includes(scope as never), `feishu.grantedScopes:${scope}`);
  if (config.capabilities.sendMessages)
    for (const scope of config.feishu.requiredSendScopes)
      need(config.feishu.grantedScopes.includes(scope as never), `feishu.grantedScopes:${scope}`);
  if (config.capabilities.readMessageImages)
    need(
      ['im:message', 'im:message:readonly', 'im:message.history:readonly'].some((s) =>
        config.feishu.grantedScopes.includes(s as never),
      ),
      'feishu.grantedScopes:im:message:readonly',
    );
  if (config.evidenceConnector.enabled) {
    need(config.evidenceConnector.connectorId, 'evidenceConnector.connectorId');
    need(config.allowlists.evidenceSourceIds.length, 'allowlists.evidenceSourceIds');
  }
  return { mode: config.mode, missing, ready: missing.length === 0, secret_values_returned: false };
}
