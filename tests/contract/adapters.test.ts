import { it, expect, vi } from 'vitest';
import { createHash, createCipheriv } from 'node:crypto';
import {
  verifyFeishu,
  normalizeFeishu,
  FeishuMessageAdapter,
  resetFeishuTokenCache,
} from '../../src/adapters/feishu';
import { loadConfig } from '../../src/config';
import {
  ReadRequest,
  readSource,
  requestPath,
  resourceKey,
  candidateKey,
} from '../../src/connector/protocol';
import { OpenAIPlanner, boundedPlan, emptyProposal } from '../../src/analysis/planner';
const now = Date.parse('2030-01-07T02:00:00Z');
it('Feishu validates exact raw bytes, decrypts AES-CBC and rejects expired/tampered requests', () => {
  const secrets = {
    FEISHU_ENCRYPT_KEY: 'synthetic-encrypt-key',
    FEISHU_VERIFICATION_TOKEN: 'synthetic-verification-token',
  };
  const encrypt = (plain: string) => {
    const iv = Buffer.alloc(16, 1);
    const cipher = createCipheriv(
      'aes-256-cbc',
      createHash('sha256').update(secrets.FEISHU_ENCRYPT_KEY).digest(),
      iv,
    );
    return JSON.stringify({
      encrypt: Buffer.concat([iv, cipher.update(plain), cipher.final()]).toString('base64'),
    });
  };
  const signed = (raw: string) => {
    const ts = String(now / 1000),
      nonce = 'fixture-nonce';
    return new Headers({
      'x-lark-request-timestamp': ts,
      'x-lark-request-nonce': nonce,
      'x-lark-signature': createHash('sha256')
        .update(ts + nonce + secrets.FEISHU_ENCRYPT_KEY + raw)
        .digest('hex'),
    });
  };
  const raw = encrypt(
    JSON.stringify({
      schema: '2.0',
      header: { token: secrets.FEISHU_VERIFICATION_TOKEN, event_type: 'im.message.receive_v1' },
      event: {},
    }),
  );
  const headers = signed(raw);
  expect(verifyFeishu(raw, headers, secrets, now).header.event_type).toBe('im.message.receive_v1');
  expect(() => verifyFeishu(raw + ' ', headers, secrets, now)).toThrow('signature_invalid');
  expect(() => verifyFeishu(raw, headers, secrets, now + 301000)).toThrow('event_expired');
  expect(() => verifyFeishu(raw, new Headers(), secrets, now)).toThrow('event_expired');
});
it('an encrypted request-URL verification is answered without signature headers, but still needs the token', () => {
  const secrets = {
    FEISHU_ENCRYPT_KEY: 'synthetic-encrypt-key',
    FEISHU_VERIFICATION_TOKEN: 'synthetic-verification-token',
  };
  const encrypt = (plain: object) => {
    const iv = Buffer.alloc(16, 2);
    const cipher = createCipheriv(
      'aes-256-cbc',
      createHash('sha256').update(secrets.FEISHU_ENCRYPT_KEY).digest(),
      iv,
    );
    return JSON.stringify({
      encrypt: Buffer.concat([iv, cipher.update(JSON.stringify(plain)), cipher.final()]).toString('base64'),
    });
  };
  // Feishu does not sign the URL verification ("签名校验…不包括请求网址校验").
  const challenge = encrypt({
    token: secrets.FEISHU_VERIFICATION_TOKEN,
    type: 'url_verification',
    challenge: 'c1',
  });
  expect(verifyFeishu(challenge, new Headers(), secrets, now).challenge).toBe('c1');
  const forged = encrypt({ token: 'wrong', type: 'url_verification', challenge: 'c2' });
  expect(() => verifyFeishu(forged, new Headers(), secrets, now)).toThrow('verification_token_invalid');
  const plain = JSON.stringify({
    token: secrets.FEISHU_VERIFICATION_TOKEN,
    type: 'url_verification',
    challenge: 'c3',
  });
  expect(verifyFeishu(plain, new Headers(), secrets, now).challenge).toBe('c3');
});
it('read-only Connector rejects arbitrary URLs, traversal and all active replay capabilities', async () => {
  expect(() => ReadRequest.parse({ capability: 'internal.debug.resolve' })).toThrow();
  expect(() => requestPath('trace.get', { trace_id: '../../etc/passwd' })).toThrow();
  expect(() => requestPath('animation.catalog', { url: 'http://forbidden' })).toThrow();
  const mock = vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ items: [], has_more: false }), {
      headers: { 'content-type': 'application/json' },
    }),
  );
  const req = {
    operation_id: 'op',
    run_id: 'run',
    project_id: 'demo',
    source_id: 'catalog',
    capability: 'animation.catalog',
    params: { q: '转三圈' },
    expires_at: '2030-01-08T10:00:00Z',
  };
  const result = await readSource(
    req,
    [
      {
        source_id: 'catalog',
        base_url: 'http://synthetic.example',
        capabilities: ['animation.catalog'],
        max_bytes: 10000,
      },
    ],
    mock,
    now,
  );
  expect(result).toMatchObject({ status: 'found', version: null });
  expect(mock.mock.calls[0][1]).toMatchObject({ method: 'GET', redirect: 'error' });
  await expect(readSource({ ...req, source_id: 'unknown' }, [], mock, now)).rejects.toThrow(
    'source_not_allowlisted',
  );
  expect(mock).toHaveBeenCalledTimes(1);
});
it('failed read, absent record and oversized payload remain distinct', async () => {
  const req = {
    operation_id: 'op',
    run_id: 'run',
    project_id: 'demo',
    source_id: 'cat',
    capability: 'animation.catalog',
    params: {},
    expires_at: '2030-01-08T10:00:00Z',
  };
  const bindings: any = [
    {
      source_id: 'cat',
      base_url: 'https://synthetic.example',
      capabilities: ['animation.catalog'],
      max_bytes: 10,
    },
  ];
  expect(
    await readSource(req, bindings, vi.fn().mockResolvedValue(new Response('', { status: 404 })), now),
  ).toMatchObject({ status: 'absent' });
  await expect(
    readSource(req, bindings, vi.fn().mockResolvedValue(new Response('', { status: 503 })), now),
  ).rejects.toThrow('SOURCE_HTTP_503');
  await expect(
    readSource(req, bindings, vi.fn().mockResolvedValue(new Response('0123456789012345')), now),
  ).rejects.toThrow('evidence_too_large');
});
it('resource keys use catalog namespace; candidate ranks stay scoped to run/branch/part', () => {
  expect(resourceKey('archive-a', { id: 1, source_sheet: 'sheet' }).resource_key).not.toBe(
    resourceKey('archive-b', { id: 1 }).resource_key,
  );
  expect(candidateKey('a', 'whole', 0, 1)).not.toBe(candidateKey('b', 'whole', 0, 1));
  expect(candidateKey('a', 'whole', 0, 1)).not.toBe(candidateKey('a', 'split', 1, 1));
});
it('catalog uses verified 60-row pages and clip lookup never confuses clip ID with the presence filter', () => {
  const url = new URL(requestPath('animation.catalog', { clip_id: 'synthetic_clip' }), 'https://fixture');
  expect(url.searchParams.get('limit')).toBe('60');
  expect(url.searchParams.get('q')).toBe('synthetic_clip');
  expect(url.searchParams.get('mode')).toBe('clip');
  expect(url.searchParams.get('clip_id')).toBe('all');
  expect(url.searchParams.get('source_scope')).toBe('all');
  expect(() => requestPath('animation.catalog', { limit: 1 })).toThrow();
});
it('real clients refuse construction in mock; planner budget rejects overlong input without a call', async () => {
  const { config } = loadConfig();
  expect(() => new OpenAIPlanner({ MODEL_API_KEY: 'synthetic' }, config)).toThrow('model_disabled');
  expect(() => new FeishuMessageAdapter(config, {})).toThrow('mock_client_forbidden');
  const planner = { plan: vi.fn() };
  await expect(
    boundedPlan(
      planner,
      {
        event: {} as any,
        issue: null,
        evidence: 'x'.repeat(config.budgets.maxInputCharacters + 1),
        allowed_people: [],
      },
      config,
    ),
  ).rejects.toThrow('input_budget_exceeded');
  expect(planner.plan).not.toHaveBeenCalled();
});
it('planner schema repairs are bounded; business refusal is not rerun until lucky', async () => {
  const { config } = loadConfig(),
    input = { event: { event_id: 'e' } as any, issue: null, evidence: [], allowed_people: [] };
  const malformed = { plan: vi.fn().mockResolvedValue({ state: 'verified' }) };
  expect(await boundedPlan(malformed, input, config)).toMatchObject({
    status: 'needs_attention',
    model_calls: 2,
  });
  const unauthorized = {
    plan: vi.fn().mockResolvedValue({ ...emptyProposal(), suggested_owner_keys: ['guessed_person'] }),
  };
  expect(await boundedPlan(unauthorized, input, config)).toMatchObject({
    status: 'needs_attention',
    model_calls: 1,
    reason: 'planner_unknown_identity',
  });
});
it('message transport rechecks the send guard after authentication and escapes untrusted mention markup', async () => {
  const config: any = loadConfig().config;
  config.mode = 'pilot';
  config.feishu.appId = 'app_fixture';
  config.feishu.grantedScopes = ['im:message:send_as_bot'];
  const transport = vi
    .fn()
    .mockImplementation(async (url: string) =>
      url.includes('/auth/')
        ? Response.json({ code: 0, tenant_access_token: 'synthetic' })
        : Response.json({ code: 0, data: { message_id: 'om_sent' } }),
    );
  const effect: any = {
    operation_id: 'stable-op',
    capability: 'message.reply',
    target: 'oc_fixture',
    request: {
      reply_to: 'om_original',
      source_chat_id: 'oc_fixture',
      mention_open_id: 'ou_verified',
      text: '反馈 <at user_id="all">所有人</at>',
    },
  };
  const guard = vi.fn();
  await new FeishuMessageAdapter(config, { FEISHU_APP_SECRET: 'synthetic' }, transport, guard).execute(
    effect,
  );
  expect(guard).toHaveBeenCalledTimes(1);
  const payload = JSON.parse(transport.mock.calls[1][1].body);
  expect(payload).toMatchObject({ reply_in_thread: true, msg_type: 'text' });
  const content = JSON.parse(payload.content).text;
  expect(content).toContain('<at user_id="ou_verified">');
  expect(content).not.toContain('<at user_id="all">');
  transport.mockClear();
  resetFeishuTokenCache();
  await expect(
    new FeishuMessageAdapter(config, { FEISHU_APP_SECRET: 'synthetic' }, transport, () => {
      throw new Error('scope_revoked');
    }).execute(effect),
  ).rejects.toThrow('scope_revoked');
  expect(transport).toHaveBeenCalledTimes(1);
});
