import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { appRoot, localSettings, ensureServiceTokens } from './local-settings';
import { loadConfig, readiness } from '../src/config';
const args = process.argv.slice(2),
  mode = args.includes('--pilot') ? 'pilot' : 'observe';
await ensureServiceTokens();
const settings = await localSettings(),
  { config, routing } = loadConfig(settings);
const deployment = JSON.parse(await readFile(resolve(appRoot, 'config/deployment.local.json'), 'utf8'));
if (
  !/^[a-f0-9]{32}$/.test(deployment.account_id) ||
  !/^[a-z0-9-]+-test$/.test(deployment.worker_name) ||
  !/^[a-z0-9-]+-test$/.test(deployment.workflow_name)
)
  throw new Error('EXPLICIT_TEST_TARGET_REQUIRED');
config.mode = mode;
config.environment = 'test';
config.workItemBackend.type = 'agent_ledger';
Object.assign(config.capabilities, {
  modelInference: true,
  readFeishuEvents: true,
  readEvidence: true,
  readWorkItems: false,
  writeWorkItems: false,
  sendMessages: mode === 'pilot',
});
config.feishu.receiveScope = 'full_group_users';
config.feishu.requiredReceiveScopes = ['im:message.group_msg'];
config.evidenceConnector.enabled = true;
(config.evidenceConnector as any).connectorId = 'evidence-test';
Object.assign(config.evidenceConnector.sources.feedback, { sourceId: 'feedback' });
Object.assign(config.evidenceConnector.sources.runtimeLogs, { sourceId: 'runtime-logs' });
Object.assign(config.evidenceConnector.sources.animationLibrary, { sourceId: 'action-search' });
(config.allowlists as any).evidenceSourceIds = ['feedback', 'runtime-logs', 'action-search'];
config.notifications.enabled = mode === 'pilot';
if (mode === 'pilot') config.notifications.policyStatus = 'confirmed';
const folder = resolve(appRoot, 'artifacts', `deployment-${new Date().toISOString().replace(/[:.]/g, '-')}`);
await mkdir(folder, { recursive: true });
const bindings = JSON.parse(await readFile(resolve(appRoot, 'wrangler.jsonc'), 'utf8'));
Object.assign(bindings, {
  $schema: resolve(appRoot, 'node_modules/wrangler/config-schema.json'),
  name: deployment.worker_name,
  account_id: deployment.account_id,
  main: resolve(appRoot, 'src/worker.ts'),
  workers_dev: true,
  vars: {
    MODE: mode,
    ENVIRONMENT: 'test',
    PROJECT_CONFIG_JSON: JSON.stringify(config),
    ROUTING_CONFIG_JSON: JSON.stringify(routing),
  },
});
bindings.workflows[0].name = deployment.workflow_name;
const configPath = resolve(folder, 'wrangler.test.local.json');
await writeFile(configPath, JSON.stringify(bindings, null, 2));
await writeFile(
  resolve(folder, 'connector.local.json'),
  JSON.stringify(
    {
      cloud_base_url: deployment.worker_url || 'https://SET-AFTER-DEPLOYMENT.workers.dev',
      connector_id: 'evidence-test',
      project_id: config.projectKey,
      state_file: resolve(appRoot, 'artifacts/connector-state.json'),
      poll_interval_seconds: 5,
      sources: deployment.source_bindings || [],
    },
    null,
    2,
  ),
);
const report = {
  prepared_at: new Date().toISOString(),
  mode,
  config_path: configPath,
  worker_name: deployment.worker_name,
  workflow_name: deployment.workflow_name,
  task_backend: 'agent_ledger',
  readiness: readiness(config, routing, settings),
  deployment_executed: false,
  secret_values_in_artifacts: false,
};
await writeFile(resolve(folder, 'readiness.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
