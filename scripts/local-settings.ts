import { readFile, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { parseEnv } from 'node:util';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
export const appRoot = fileURLToPath(new URL('../', import.meta.url).href);
export async function localSettings() {
  const env = { ...process.env };
  try {
    const local = parseEnv(await readFile(resolve(appRoot, '.dev.vars'), 'utf8'));
    for (const [key, value] of Object.entries(local)) if (!env[key]) env[key] = value;
  } catch (e: any) {
    if (e.code !== 'ENOENT') throw e;
  }
  for (const [key, file] of [
    ['PROJECT_CONFIG_JSON', 'config/project.observe.local.json'],
    ['ROUTING_CONFIG_JSON', 'config/routing.local.json'],
  ]) {
    if (!env[key])
      try {
        env[key] = await readFile(resolve(appRoot, file), 'utf8');
      } catch (e: any) {
        if (e.code !== 'ENOENT') throw e;
      }
  }
  if (env.PROJECT_CONFIG_JSON) {
    const p = JSON.parse(env.PROJECT_CONFIG_JSON);
    env.MODE = p.mode;
    env.ENVIRONMENT = p.environment;
  }
  return env;
}
export async function ensureServiceTokens() {
  const path = resolve(appRoot, '.dev.vars');
  let raw = '';
  try {
    raw = await readFile(path, 'utf8');
  } catch (e: any) {
    if (e.code !== 'ENOENT') throw e;
  }
  const values = parseEnv(raw),
    added: string[] = [];
  for (const name of ['ADMIN_AUTH_TOKEN', 'CONNECTOR_AUTH_TOKEN'])
    if (!values[name] && !process.env[name]) added.push(`${name}=${randomBytes(32).toString('base64')}`);
  if (added.length)
    await writeFile(path, `${raw}${raw.endsWith('\n') || !raw ? '' : '\n'}${added.join('\n')}\n`);
}
