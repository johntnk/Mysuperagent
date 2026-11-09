import { createHash } from 'node:crypto';

export interface HistoryEvent {
  event_id: string;
  message_id: string;
  source_index: number;
  revision: string;
  created_at: string;
  available_at: string;
  kind: 'message' | 'revision';
  message_type: string;
  sender_id: string | null;
  sender_name: string | null;
  parent_id: string | null;
  root_id: string | null;
  text: string;
  mentions: { id: string; name: string }[];
  names_only: string[];
  limitations: string[];
}
export const sha256 = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const timestamp = (value: unknown) => {
  const n =
    typeof value === 'string' && /^\d+$/.test(value)
      ? Number(value)
      : typeof value === 'number'
        ? value
        : Date.parse(String(value));
  if (!Number.isFinite(n)) throw new Error('history_invalid_timestamp');
  return new Date(n).toISOString();
};
function parseContent(raw: any) {
  try {
    return typeof raw.body?.content === 'string' ? JSON.parse(raw.body.content) : (raw.body?.content ?? {});
  } catch {
    return { text: String(raw.body?.content ?? '') };
  }
}
function visibleText(content: any, mentions: { id: string; name: string; key?: string }[]): string {
  if (typeof content === 'string') return content;
  if (!content) return '';
  if (content.template) return JSON.stringify(content);
  if (typeof content.text === 'string')
    return content.text.replace(
      /@_user_\d+/g,
      (key: string) => `@${mentions.find((m) => m.key === key)?.name ?? key}`,
    );
  if (content.zh_cn || content.en_us) return visibleText(content.zh_cn ?? content.en_us, mentions);
  const rows = content.content ?? content.content_v2;
  if (Array.isArray(rows))
    return [
      content.title ?? '',
      ...rows
        .map((row: any) =>
          (Array.isArray(row) ? row : [row])
            .map((item: any) => {
              if (item.tag === 'at')
                return `@${mentions.find((m) => m.key === item.user_id || m.id === item.user_id)?.name ?? item.user_name ?? item.user_id}`;
              if (item.tag === 'a') return `${item.text ?? ''} ${item.href ?? ''}`;
              if (item.tag === 'text') return item.text ?? '';
              return `[${item.tag ?? 'attachment'} 正文未取得]`;
            })
            .join(''),
        )
        .filter(Boolean),
    ].join('\n');
  return '[非文本消息，正文未取得]';
}

/** Only raw versions are used; no export-wide identity enrichment or final summaries enter the model. */
export function normalizeHistory(rows: unknown): HistoryEvent[] {
  if (!Array.isArray(rows)) throw new Error('history_expected_array');
  const result: HistoryEvent[] = [];
  const seen = new Set<string>();
  rows.forEach((row: any, index) => {
    if (row.context_only) return;
    const versions = Array.isArray(row.versions) && row.versions.length ? row.versions : [row.raw ?? row];
    const sorted = [...versions].sort(
      (a, b) =>
        Date.parse(timestamp(a.update_time ?? a.create_time)) -
        Date.parse(timestamp(b.update_time ?? b.create_time)),
    );
    sorted.forEach((raw: any, versionIndex) => {
      if (!raw.message_id) throw new Error('history_missing_message_id');
      const created = timestamp(raw.create_time),
        updated = timestamp(raw.update_time ?? raw.create_time);
      const available = raw.updated && updated > created ? updated : created;
      const signature = sha256(JSON.stringify([raw.message_id, available, raw.body, raw.deleted]));
      if (seen.has(signature)) return;
      seen.add(signature);
      const mentions = (raw.mentions ?? [])
        .filter((m: any) => m.id && m.name)
        .map((m: any) => ({ id: String(m.id), name: String(m.name), key: m.key }));
      const content = parseContent(raw);
      const names =
        raw.msg_type === 'system'
          ? [content.from_user, content.to_chatters]
              .flatMap((v) => (Array.isArray(v) ? v : []))
              .filter((v: any) => typeof v === 'string')
          : [];
      const limitations: string[] = [];
      if (raw.updated && available !== created && versionIndex === 0)
        limitations.push('original_revision_unavailable_body_delayed_until_update');
      if (row.version_conflict) limitations.push('export_version_conflict');
      if (!['text', 'post', 'system'].includes(raw.msg_type)) limitations.push('attachment_body_unavailable');
      if (raw.deleted) limitations.push('deleted_content_unavailable');
      let text = raw.deleted ? '[消息已删除，正文不可见]' : visibleText(content, mentions);
      if (text.length > 12000) {
        text = text.slice(0, 12000) + '\n[正文已截断]';
        limitations.push('body_truncated');
      }
      result.push({
        event_id: `history:${raw.message_id}:${signature.slice(0, 12)}`,
        message_id: String(raw.message_id),
        source_index: index + 1,
        revision: signature,
        created_at: created,
        available_at: available,
        kind: versionIndex ? 'revision' : 'message',
        message_type: raw.msg_type ?? 'unknown',
        sender_id: raw.sender?.id || null,
        sender_name: raw.sender?.name || null,
        parent_id: raw.parent_id || null,
        root_id: raw.root_id || null,
        text,
        mentions: mentions.map(({ id, name }: { id: string; name: string }) => ({ id, name })),
        names_only: names,
        limitations,
      });
    });
  });
  return result.sort(
    (a, b) =>
      a.available_at.localeCompare(b.available_at) ||
      a.source_index - b.source_index ||
      a.revision.localeCompare(b.revision),
  );
}
