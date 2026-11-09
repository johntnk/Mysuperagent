import { createHash, createDecipheriv, timingSafeEqual } from 'node:crypto';
import type { ProjectConfig, RoutingConfig, Secrets } from '../config';
import { EventEnvelope, type Command, type Effect, type Task } from '../domain/contracts';
import type { EffectPort, Reconciliation, WorkItemPort } from '../ports';
import { requireRule } from '../domain/rules';
import { COMMAND_USAGE, parseCommand } from './feishu-commands';
import { renderCard, type Ignored } from './feishu-cards';
import type { CardSpec } from '../domain/cards';

const FEISHU_API = 'https://open.feishu.cn/open-apis';

export function equalSecret(a: string, b: string) {
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function decrypt(encrypted: string, key: string) {
  const bytes = Buffer.from(encrypted, 'base64');
  requireRule(bytes.length > 16, 'encrypted_body_invalid');
  const decipher = createDecipheriv(
    'aes-256-cbc',
    createHash('sha256').update(key).digest(),
    bytes.subarray(0, 16),
  );
  return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(16)), decipher.final()]).toString('utf8'));
}

/**
 * Verifies an event or card callback pushed by Feishu and returns the decrypted body.
 *
 * Order matters: Feishu encrypts the request-URL verification (`url_verification`) when an Encrypt Key is
 * configured, but does not sign it ("签名校验…不包括请求网址校验"). So the body is decrypted first, a
 * verification request is checked by its token only, and every other request must carry a valid signature.
 */
export function verifyFeishu(raw: string, headers: Headers, env: Secrets, now = Date.now()): any {
  requireRule(raw.length <= 262144, 'event_too_large');
  const data = JSON.parse(raw);
  requireRule(env.FEISHU_VERIFICATION_TOKEN, 'verification_token_missing');
  const key = env.FEISHU_ENCRYPT_KEY;
  let body = data;
  if (data.encrypt) {
    requireRule(key, 'encrypt_key_required');
    body = decrypt(data.encrypt, key);
  }
  const tokenOk = () =>
    requireRule(
      equalSecret(String(body.token || body.header?.token || ''), env.FEISHU_VERIFICATION_TOKEN!),
      'verification_token_invalid',
    );
  if (body.type === 'url_verification') {
    tokenOk();
    return body;
  }
  requireRule(key, 'encrypt_key_required');
  const timestamp = headers.get('x-lark-request-timestamp') || '',
    nonce = headers.get('x-lark-request-nonce') || '';
  requireRule(
    /^\d+$/.test(timestamp) && nonce.length > 0 && Math.abs(now - Number(timestamp) * 1000) <= 300000,
    'event_expired',
  );
  const expected = createHash('sha256')
    .update(timestamp + nonce + key + raw)
    .digest('hex');
  requireRule(equalSecret(expected, headers.get('x-lark-signature') || ''), 'signature_invalid');
  tokenOk();
  return body;
}

export function messageText(type: string, content: string) {
  let value: any;
  try {
    value = JSON.parse(content);
  } catch {
    return '[消息内容无法解析]';
  }
  if (type === 'text') return String(value.text || '');
  if (type === 'post') {
    const post = postBody(value);
    if (!post) return '';
    return [
      post.title || '',
      ...(post.content || []).map((row: any[]) =>
        row
          .map((node) =>
            node.tag === 'a'
              ? `${node.text || ''} ${node.href || ''}`
              : node.tag === 'text' || node.tag === 'code_block'
                ? node.text || ''
                : node.tag === 'at'
                  ? `@${node.user_name || node.user_id || ''}`
                  : node.tag === 'img'
                    ? '[图片]'
                    : node.tag === 'media'
                      ? '[视频附件，未读取正文]'
                      : '',
          )
          .join(''),
      ),
    ].join('\n');
  }
  if (type === 'image') return '[图片]';
  return `[${type} 附件，未读取正文]`;
}
function postBody(value: any) {
  return value?.content
    ? value
    : value?.zh_cn || value?.en_us || Object.values(value ?? {}).find((v: any) => v?.content);
}
/** Image keys in an image message or a rich-text post, so the analysis can look at screenshots. */
export function messageImageKeys(type: string, content: string): string[] {
  try {
    const value = JSON.parse(content);
    if (type === 'image' && typeof value.image_key === 'string') return [value.image_key];
    if (type === 'post')
      return (postBody(value)?.content ?? [])
        .flat()
        .filter((n: any) => n?.tag === 'img' && typeof n.image_key === 'string')
        .map((n: any) => n.image_key);
  } catch {
    /* unparsable content has no images */
  }
  return [];
}

/**
 * Normalizes `im.message.receive_v1`. Messages we deliberately do not handle (other chats, other event
 * types, our own bot) return `{ignored}` so the webhook answers 200 and Feishu does not keep retrying.
 */
export function normalizeFeishu(
  body: any,
  config: ProjectConfig,
  routing: RoutingConfig,
  received_at = new Date().toISOString(),
): Command | Ignored {
  requireRule(config.mode !== 'mock' && config.capabilities.readFeishuEvents, 'real_ingress_disabled');
  if (body.header?.app_id !== config.feishu.appId || body.header?.tenant_key !== config.feishu.tenantKey)
    return { ignored: 'tenant_or_app_mismatch' };
  if (body.header?.event_type !== 'im.message.receive_v1') return { ignored: 'event_not_subscribed' };
  if (!config.feishu.requiredReceiveScopes.every((x) => config.feishu.grantedScopes.includes(x as never)))
    return { ignored: 'receive_scope_not_verified' };
  const message = body.event?.message,
    sender = body.event?.sender;
  if (!message?.message_id || !sender?.sender_id || !body.header?.event_id)
    return { ignored: 'message_invalid' };
  if (!config.allowlists.feishuChatIds.includes(message.chat_id as never))
    return { ignored: 'chat_not_allowlisted' };
  if (sender.sender_type !== 'user' || sender.sender_id.open_id === config.feishu.botOpenId)
    return { ignored: 'not_human_sender' };
  if (
    config.feishu.receiveScope === 'mentions_only' &&
    !message.mentions?.some((m: any) => m.id?.open_id === config.feishu.botOpenId)
  )
    return { ignored: 'not_mentioned' };
  const person = routing.members.find(
    (m) =>
      m.enabled &&
      m.feishuOpenId === sender.sender_id.open_id &&
      config.allowlists.feishuOpenIds.includes(m.feishuOpenId as never),
  );
  const created = Number(message.create_time);
  const envelope = EventEnvelope.parse({
    schema_version: '1.0',
    event_id: body.header.event_id,
    project_id: config.projectKey,
    source: 'feishu_message',
    source_event_id: message.message_id,
    source_revision: message.update_time || null,
    actor: {
      kind: 'human',
      source_actor_id: sender.sender_id.open_id,
      ...(person ? { person_key: person.personKey } : {}),
    },
    thread_refs: [
      { source: 'feishu', thread_id: message.root_id || message.parent_id || message.message_id },
    ],
    occurred_at: new Date(Number.isFinite(created) ? created : Date.parse(received_at)).toISOString(),
    received_at,
    payload_ref: `feishu:${message.message_id}`,
    correlation_ids: { message_id: message.message_id },
    provenance: {
      trust: 'verified_source',
      method: 'feishu_webhook_signature',
      observed_at: received_at,
      synthetic: false,
    },
  });
  const text = messageText(message.message_type, message.content)
    .replace(/@_user_\d+/g, (key) => {
      const mention = message.mentions?.find((m: any) => m.key === key);
      if (!mention || mention.id?.open_id === config.feishu.botOpenId) return '';
      return `@${mention.name || '未识别成员'}`;
    })
    .trim();
  const mentions = (message.mentions ?? []).flatMap((m: any) => {
    const member = routing.members.find((p) => p.enabled && p.feishuOpenId === m.id?.open_id);
    return member ? [{ id: member.personKey, name: member.displayName }] : [];
  });
  const origin = {
    source_chat_id: message.chat_id,
    source_message_id: message.message_id,
    source_parent_message_id: message.parent_id || null,
    source_thread: message.root_id || message.message_id,
    message_type: message.message_type,
    mentions,
  };
  const base = {
    event_id: body.header.event_id,
    occurred_at: envelope.occurred_at,
    actor_key: person?.personKey || 'unmapped_reporter',
    source_event_id: message.message_id,
    source_revision: message.update_time || undefined,
    envelope,
  };
  // Typed commands are explicit and authenticated by sender identity; prose is never treated as one.
  const prefix = config.feishu.commandPrefix || '/agent';
  const parsed =
    person && message.message_type === 'text'
      ? parseCommand(text, { prefix, timeZone: config.timezone, dayEnd: config.notifications.workHours.end })
      : null;
  if (parsed?.kind === 'invalid')
    return {
      ...base,
      event_type: 'command_invalid',
      payload: {
        ...origin,
        reason: parsed.reason,
        command_prefix: prefix,
        usage: COMMAND_USAGE(prefix),
        text,
      },
    };
  if (parsed?.kind === 'command') {
    const payload: Record<string, unknown> = {
      ...origin,
      ...parsed.payload,
      command_prefix: prefix,
      ...(parsed.event_type === 'command_help' ? { usage: COMMAND_USAGE(prefix) } : {}),
      text,
    };
    if (parsed.event_type === 'manual_reassignment') {
      const name = String(parsed.payload.new_owner_name ?? '');
      const candidates = routing.members.filter(
        (m) =>
          m.enabled &&
          (m.personKey === name || m.displayName === name) &&
          m.feishuOpenId &&
          config.allowlists.feishuOpenIds.includes(m.feishuOpenId as never),
      );
      payload.new_owner_key = candidates.length === 1 ? candidates[0].personKey : null;
    }
    return { ...base, event_type: parsed.event_type, payload };
  }
  const traces = [...new Set(text.match(/tr_[0-9a-f]{32}/g) || [])];
  const links = [...new Set(text.match(/https?:\/\/[^\s<>"）)]+/g) || [])];
  return {
    ...base,
    event_type: 'feedback_observed',
    payload: {
      ...origin,
      case_id: `case_${message.message_id}`,
      text,
      run_refs: traces,
      related_links: links,
      image_keys: messageImageKeys(message.message_type, message.content).slice(0, 8),
    },
  };
}

export class RetryableFailure extends Error {}
export class UnknownWrite extends Error {}
export class BlockedAdapter extends Error {}

/** Feishu rejects a repeated `uuid` for an hour, so a resend inside that window cannot duplicate a message. */
const IDEMPOTENCY_WINDOW_MS = 55 * 60 * 1000;
export function withinIdempotencyWindow(e: Pick<Effect, 'first_attempt_at'>, now: number) {
  return Boolean(e.first_attempt_at && now - Date.parse(e.first_attempt_at) < IDEMPOTENCY_WINDOW_MS);
}

const tokenCache = new Map<string, { token: string; expires_at: number }>();
export function resetFeishuTokenCache() {
  tokenCache.clear();
}

/** Tenant-token client shared by sending and resource download. Transport failures are retryable. */
export class FeishuClient {
  constructor(
    private config: ProjectConfig,
    private env: Secrets,
    private transport: typeof fetch = fetch,
  ) {}
  async token() {
    if (!this.config.feishu.appId || !this.env.FEISHU_APP_SECRET)
      throw new BlockedAdapter('FEISHU_APP_NOT_CONFIGURED');
    const key = `${this.config.feishu.appId}:${createHash('sha256').update(this.env.FEISHU_APP_SECRET).digest('hex')}`;
    const cached = tokenCache.get(key);
    if (cached && cached.expires_at > Date.now()) return cached.token;
    let r: Response, j: any;
    try {
      r = await this.transport(`${FEISHU_API}/auth/v3/tenant_access_token/internal`, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(15000),
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ app_id: this.config.feishu.appId, app_secret: this.env.FEISHU_APP_SECRET }),
      });
      j = await r.json();
    } catch {
      // Nothing was sent yet, so this is safe to retry; it must never be recorded as an unknown write.
      throw new RetryableFailure('FEISHU_AUTH_UNREACHABLE');
    }
    if (!r.ok || j.code !== 0 || !j.tenant_access_token) throw new RetryableFailure('FEISHU_AUTH_FAILED');
    const ttl = Math.max(60, Number(j.expire) || 7200) - 300;
    tokenCache.set(key, { token: j.tenant_access_token, expires_at: Date.now() + ttl * 1000 });
    return j.tenant_access_token as string;
  }
  /** Downloads an image attached to a message (`im:message:readonly`), returning a data URL. */
  async messageImage(messageId: string, imageKey: string, maxBytes: number) {
    requireRule(
      /^om_[A-Za-z0-9_-]+$/.test(messageId) && /^[A-Za-z0-9_-]+$/.test(imageKey),
      'image_ref_invalid',
    );
    const token = await this.token();
    const r = await this.transport(
      `${FEISHU_API}/im/v1/messages/${encodeURIComponent(messageId)}/resources/${encodeURIComponent(imageKey)}?type=image`,
      {
        method: 'GET',
        redirect: 'error',
        signal: AbortSignal.timeout(20000),
        headers: { Authorization: `Bearer ${token}` },
      },
    );
    if (!r.ok) throw new RetryableFailure(`FEISHU_IMAGE_HTTP_${r.status}`);
    const declared = Number(r.headers.get('content-length') || 0);
    if (declared > maxBytes) return null;
    const bytes = Buffer.from(await r.arrayBuffer());
    if (bytes.length > maxBytes) return null;
    const mime = (r.headers.get('content-type') || 'image/png').split(';')[0];
    if (!/^image\/(png|jpe?g|gif|webp)$/.test(mime)) return null;
    return `data:${mime};base64,${bytes.toString('base64')}`;
  }
}

/** Untrusted text in a plain-text message cannot open `<at>` or other tags. */
export function neutralizeMarkup(text: string) {
  return text.replace(/</g, '＜').replace(/>/g, '＞');
}

export class FeishuMessageAdapter implements EffectPort {
  private client: FeishuClient;
  constructor(
    private config: ProjectConfig,
    env: Secrets,
    private transport: typeof fetch = fetch,
    private beforeSend?: () => void,
  ) {
    requireRule(config.mode !== 'mock', 'mock_client_forbidden');
    this.client = new FeishuClient(config, env, transport);
  }
  async execute(e: Effect) {
    if (
      !this.config.feishu.requiredSendScopes.every((x) =>
        this.config.feishu.grantedScopes.includes(x as never),
      )
    )
      throw new BlockedAdapter('SEND_SCOPE_NOT_VERIFIED');
    if (!['message.send', 'message.reply', 'message.update'].includes(e.capability))
      throw new BlockedAdapter('MESSAGE_CAPABILITY_UNSUPPORTED');
    if (e.capability === 'message.update')
      throw new BlockedAdapter('UPDATE_REQUIRES_VERIFIED_MESSAGE_TARGET');
    if (
      e.capability === 'message.reply' &&
      (!/^om_[a-zA-Z0-9_-]+$/.test(e.request.reply_to || '') || e.request.source_chat_id !== e.target)
    )
      throw new BlockedAdapter('REPLY_TARGET_NOT_BOUND');
    const mention = e.request.mention_open_id;
    if (mention && !/^ou_[a-zA-Z0-9]+$/.test(mention)) throw new BlockedAdapter('MENTION_ID_INVALID');
    const card = e.request.card as CardSpec | undefined;
    const msg_type = card ? 'interactive' : 'text';
    const content = card
      ? JSON.stringify(renderCard(card, mention))
      : JSON.stringify({
          text:
            (mention ? `<at user_id="${mention}"></at> ` : '') +
            neutralizeMarkup(String(e.request.text || '')),
        });
    const uuid = createHash('sha256').update(e.operation_id).digest('hex').slice(0, 32);
    const endpoint =
      e.capability === 'message.reply'
        ? `${FEISHU_API}/im/v1/messages/${encodeURIComponent(e.request.reply_to)}/reply`
        : `${FEISHU_API}/im/v1/messages?receive_id_type=chat_id`;
    const payload =
      e.capability === 'message.reply'
        ? { msg_type, content, reply_in_thread: true, uuid }
        : { receive_id: e.target, msg_type, content, uuid };
    const token = await this.client.token();
    if (!this.beforeSend) throw new BlockedAdapter('SEND_GUARD_REQUIRED');
    this.beforeSend();
    let r: Response;
    try {
      r = await this.transport(endpoint, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(15000),
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
    } catch {
      throw new UnknownWrite('MESSAGE_RESPONSE_UNKNOWN');
    }
    if (r.status === 429) throw new RetryableFailure('MESSAGE_RATE_LIMIT');
    if (r.status >= 500) throw new UnknownWrite('MESSAGE_RESPONSE_UNKNOWN');
    let j: any;
    try {
      j = await r.json();
    } catch {
      throw new UnknownWrite('MESSAGE_RESPONSE_UNKNOWN');
    }
    if (!r.ok || j.code !== 0)
      throw new BlockedAdapter(`MESSAGE_REJECTED_${r.status}_${Number(j?.code) || 0}`);
    if (!j.data?.message_id) throw new UnknownWrite('MESSAGE_ID_MISSING');
    return { record_ref: j.data.message_id as string };
  }
  /**
   * Feishu has no lookup by `uuid`, but it de-duplicates a repeated `uuid` for an hour. Inside that window
   * an unknown send is resent with the same key; after it, a person has to reconcile.
   */
  async reconcile(e: Effect, now = Date.now()): Promise<Reconciliation> {
    if (withinIdempotencyWindow(e, now)) return { status: 'retry_safe' };
    return { status: 'unknown', reason: 'outside_feishu_uuid_window; reconcile manually' };
  }
}
// Real Project API has tenant-specific auth, fields and workflow semantics. No invented Tasks-v2 fallback.
export class UnconfiguredProjectAdapter implements WorkItemPort {
  async get(_id: string): Promise<unknown> {
    throw new BlockedAdapter('PROJECT_CONTRACT_NOT_VERIFIED');
  }
  async search(_operation_id: string): Promise<Reconciliation> {
    return { status: 'unknown', reason: 'PROJECT_OPERATION_LOOKUP_NOT_VERIFIED' };
  }
  async execute(_e: Effect, _t?: Task): Promise<{ record_ref: string }> {
    throw new BlockedAdapter('PROJECT_AUTH_FIELDS_AND_WORKFLOW_NOT_VERIFIED');
  }
  async reconcile(e: Effect) {
    return this.search(e.operation_id);
  }
}
