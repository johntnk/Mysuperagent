import { loadConfig, readiness } from './config';
import { equalSecret, normalizeFeishu, verifyFeishu } from './adapters/feishu';
import { cardCallback } from './adapters/feishu-callback';
import { Command } from './domain/contracts';
import type { Env } from './coordinator';
import { z } from 'zod';
export { ProjectAgent } from './coordinator';
export { IssueRound } from './workflow';
function authorized(request: Request, secret: string | undefined) {
  return Boolean(secret && equalSecret(request.headers.get('Authorization') || '', `Bearer ${secret}`));
}
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      const { config, routing } = loadConfig(env);
      const url = new URL(request.url);
      const stub = env.PROJECT.get(env.PROJECT.idFromName(config.projectKey));
      const forward = (path: string, body?: unknown) =>
        stub.fetch(`https://project${path}`, {
          method: body === undefined ? 'GET' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      if (url.pathname === '/health')
        return Response.json({
          ok: true,
          mode: config.mode,
          project: config.projectKey,
          synthetic: config.mode === 'mock',
        });
      if (request.method === 'POST' && url.pathname === config.feishu.callbackPath) {
        if (config.mode === 'mock' || !config.capabilities.readFeishuEvents)
          return Response.json({ error: 'real_ingress_disabled' }, { status: 403 });
        let body: any;
        try {
          body = verifyFeishu(await limitedBody(request), request.headers, env);
        } catch (e) {
          return Response.json(
            { error: e instanceof Error ? e.message : 'verification_failed' },
            { status: 401 },
          );
        }
        if (body.type === 'url_verification') return Response.json({ challenge: body.challenge });
        // Card button / form callbacks share the endpoint and must answer within 3 s with a toast.
        if (body.header?.event_type === 'card.action.trigger')
          return cardCallback(body, config, routing, forward);
        const c = normalizeFeishu(body, config, routing);
        // Deliberately ignored events still get 200, otherwise Feishu keeps re-delivering them.
        if ('ignored' in c) return Response.json({ ignored: c.ignored });
        return forward('/ingest', c);
      }
      if (url.pathname.startsWith('/integrations/connector/')) {
        if (
          config.mode === 'mock' ||
          !config.capabilities.readEvidence ||
          !config.evidenceConnector.enabled ||
          !authorized(request, env.CONNECTOR_AUTH_TOKEN) ||
          request.headers.get('X-Connector-ID') !== config.evidenceConnector.connectorId
        )
          return Response.json({ error: 'connector_disabled_or_unauthorized' }, { status: 403 });
        if (url.pathname.endsWith('/poll') && request.method === 'GET') return forward('/connector/poll');
        if (url.pathname.endsWith('/results') && request.method === 'POST') {
          const r = await forward('/connector/result', JSON.parse(await limitedBody(request)));
          ctx.waitUntil(forward('/tick', {}));
          return r;
        }
      }
      // The local demo is loopback-only. Real deployments always require the separate admin token.
      const local =
        config.mode === 'mock' &&
        config.environment === 'local' &&
        ['localhost', '127.0.0.1'].includes(url.hostname);
      if (!local && !authorized(request, env.ADMIN_AUTH_TOKEN))
        return Response.json({ error: 'unauthorized' }, { status: 401 });
      if (request.method === 'GET' && url.pathname === '/api/state') return forward('/state');
      if (request.method === 'GET' && url.pathname === '/api/readiness')
        return Response.json(readiness(config, routing, env));
      if (request.method === 'POST' && url.pathname === '/api/mock/events' && config.mode === 'mock') {
        const c = Command.parse(JSON.parse(await limitedBody(request)));
        return forward('/ingest', c);
      }
      if (request.method === 'POST' && url.pathname === '/api/reads')
        return forward('/reads', JSON.parse(await limitedBody(request)));
      if (request.method === 'POST' && url.pathname === '/api/operations/reconcile') {
        const input = z
          .strictObject({
            operation_id: z.string().max(200),
            resolution: z.enum(['confirmed_sent', 'confirmed_not_sent', 'leave_unknown']),
            record_ref: z.string().max(200).optional(),
            evidence_ref: z.string().min(1).max(500),
            reviewer_key: z.string(),
          })
          .parse(JSON.parse(await limitedBody(request)));
        const { policy } = loadConfig(env);
        if (
          !policy.decision_owners.includes(input.reviewer_key) ||
          (input.resolution === 'confirmed_sent' && !/^om_[a-zA-Z0-9_-]+$/.test(input.record_ref || ''))
        )
          return Response.json({ error: 'RECONCILIATION_REVIEW_REQUIRED' }, { status: 400 });
        return forward('/ingest', {
          event_id: `manual-reconcile:${crypto.randomUUID()}`,
          event_type: 'reconciliation_result',
          actor_key: 'system',
          occurred_at: new Date().toISOString(),
          payload: {
            operation_id: input.operation_id,
            result:
              input.resolution === 'confirmed_sent'
                ? 'found_one'
                : input.resolution === 'confirmed_not_sent'
                  ? 'confirmed_absent'
                  : 'unknown',
            record_ref: input.record_ref,
            authoritative: input.resolution !== 'leave_unknown',
            evidence_ref: input.evidence_ref,
            reviewer_key: input.reviewer_key,
          },
        });
      }
      if (request.method === 'POST' && url.pathname === '/api/tick') return forward('/tick', {});
      return Response.json({ error: 'not_found' }, { status: 404 });
    } catch (e) {
      return Response.json({ error: e instanceof Error ? e.message : 'REQUEST_FAILED' }, { status: 400 });
    }
  },
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    const { config } = loadConfig(env);
    const stub = env.PROJECT.get(env.PROJECT.idFromName(config.projectKey));
    ctx.waitUntil(stub.fetch('https://project/tick', { method: 'POST' }));
  },
} satisfies ExportedHandler<Env>;
async function limitedBody(request: Request) {
  if (Number(request.headers.get('content-length') || 0) > 262144) throw new Error('REQUEST_TOO_LARGE');
  const text = await request.text();
  if (text.length > 262144) throw new Error('REQUEST_TOO_LARGE');
  return text;
}
