import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { ReadRequest, readSource, type SourceBinding } from '../src/connector/protocol';

// Outbound only. No listening socket, shell, arbitrary URL or business write API.
const mode = process.env.CONNECTOR_MODE || 'mock';
if (mode === 'mock') {
  console.log(
    JSON.stringify({
      mode,
      network_calls: 0,
      status: 'offline; real Connector requires explicit configuration',
    }),
  );
} else {
  const configPath = process.env.CONNECTOR_CONFIG_PATH;
  if (!configPath) throw new Error('CONNECTOR_CONFIG_PATH_REQUIRED');
  const config = JSON.parse(await readFile(configPath, 'utf8')) as {
    cloud_base_url: string;
    connector_id: string;
    project_id: string;
    sources: SourceBinding[];
    state_file: string;
    poll_interval_seconds?: number;
  };
  const cloud = new URL(config.cloud_base_url);
  if (cloud.protocol !== 'https:' || cloud.username || cloud.password || cloud.search || cloud.hash)
    throw new Error('INVALID_CLOUD_BASE');
  const token = process.env.CONNECTOR_AUTH_TOKEN;
  if (!token) throw new Error('CONNECTOR_AUTH_TOKEN_REQUIRED');
  const statePath = resolve(config.state_file);
  await mkdir(dirname(statePath), { recursive: true });
  let cache: Record<string, unknown> = {};
  try {
    cache = JSON.parse(await readFile(statePath, 'utf8'));
  } catch (e: any) {
    if (e.code !== 'ENOENT') throw e;
  }
  const api = async (path: string, body?: unknown) => {
    const r = await fetch(new URL(path, cloud), {
      method: body ? 'POST' : 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        'X-Connector-ID': config.connector_id,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
      redirect: 'error',
      signal: AbortSignal.timeout(20000),
    });
    if (!r.ok) throw new Error(`CLOUD_HTTP_${r.status}`);
    return r.json() as Promise<any>;
  };
  let stop = false;
  process.on('SIGINT', () => {
    stop = true;
  });
  process.on('SIGTERM', () => {
    stop = true;
  });
  do {
    try {
      const batch = await api('/integrations/connector/poll');
      for (const raw of batch.requests || []) {
        const r = ReadRequest.parse(raw);
        if (r.project_id !== config.project_id) throw new Error('PROJECT_MISMATCH');
        if (!cache[r.operation_id]) {
          try {
            cache[r.operation_id] = {
              operation_id: r.operation_id,
              run_id: r.run_id,
              source_id: r.source_id,
              observed_at: new Date().toISOString(),
              result: await readSource(r, config.sources),
            };
          } catch (e) {
            cache[r.operation_id] = {
              operation_id: r.operation_id,
              run_id: r.run_id,
              source_id: r.source_id,
              observed_at: new Date().toISOString(),
              result: {
                status: 'unavailable',
                error: e instanceof Error ? e.message : 'READ_ERROR',
                version: null,
              },
            };
          }
          await writeFile(`${statePath}.next`, JSON.stringify(cache));
          await rename(`${statePath}.next`, statePath);
        }
        await api('/integrations/connector/results', cache[r.operation_id]);
      }
    } catch (e) {
      console.error(
        JSON.stringify({ type: 'connector_failure', code: e instanceof Error ? e.message : 'UNKNOWN' }),
      );
    }
    if (process.argv.includes('--once')) break;
    await new Promise((r) =>
      setTimeout(r, Math.max(5, Math.min(60, config.poll_interval_seconds || 10)) * 1000),
    );
  } while (!stop);
}
