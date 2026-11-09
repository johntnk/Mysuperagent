import { createHash } from 'node:crypto';
import type { Ledger, Command } from './contracts';
import type { SourceItem } from './coordination-schema';
export const stableId = (prefix: string, value: string) =>
  `${prefix}_${createHash('sha256').update(value).digest('hex').slice(0, 32)}`;
export function splitSourceItems(text: string): { label: string; text: string }[] {
  const matches = [...text.matchAll(/(?:^|\n|<p>)\s*(\d{1,3})[.、．）)]\s*/g)];
  if (matches.length < 2) return [{ label: 'body', text }];
  const occurrences = new Map<string, number>();
  const parts = matches.map((m, i) => {
    const n = (occurrences.get(m[1]) ?? 0) + 1;
    occurrences.set(m[1], n);
    return {
      label: n === 1 ? m[1] : `${m[1]}#${n}`,
      text: text.slice(m.index!, matches[i + 1]?.index ?? text.length).trim(),
    };
  });
  const prefix = text.slice(0, matches[0].index).trim();
  return prefix ? [{ label: 'preamble', text: prefix }, ...parts] : parts;
}
export function ensureCoordinationState(s: Ledger) {
  s.source_items ??= {};
  s.reminders ??= {};
}
export function observeSource(s: Ledger, c: Command) {
  ensureCoordinationState(s);
  const text = String(c.payload.text ?? '');
  if (!text.trim()) return;
  const source = c.source_event_id ?? c.envelope?.source_event_id ?? c.event_id,
    revision = c.source_revision ?? c.envelope?.source_revision ?? c.event_id;
  for (const part of splitSourceItems(text)) {
    const id = stableId('item', `${source}:${part.label}`),
      old = s.source_items[id];
    if (old?.observations.some((x) => x.revision === revision)) continue;
    const observation = { event_id: c.event_id, revision, at: c.occurred_at, text: part.text };
    if (old && old.at > c.occurred_at) {
      old.observations.push(observation);
      continue;
    }
    const external = [
      ...new Set(
        (part.text.match(/https?:\/\/[^\s<>"\])]+/g) ?? []).map((x) => x.replace(/[，。；]+$/u, '')),
      ),
    ];
    const item: SourceItem = {
      item_id: id,
      source_id: source,
      label: part.label,
      text: part.text,
      event_id: c.event_id,
      revision,
      at: c.occurred_at,
      sender_id: c.actor_key === 'system' ? (c.payload.sender_id ?? null) : c.actor_key,
      mentions: (c.payload.mentions ?? []).filter(
        (m: any) =>
          typeof m.id === 'string' &&
          typeof m.name === 'string' &&
          (part.text.includes(m.name) || part.text.includes(m.id)),
      ),
      external_refs: external,
      category: 'unclassified',
      task_ids: old?.task_ids ?? [],
      related_item_id: old?.related_item_id ?? null,
      classification_reason: null,
      observations: [...(old?.observations ?? []), observation],
    };
    s.source_items[id] = item;
  }
}
export function itemsForEvent(s: Ledger, eventId: string) {
  return Object.values(s.source_items ?? {}).filter((i) => i.event_id === eventId);
}
export function cancelInvalidReminders(s: Ledger, at: string) {
  ensureCoordinationState(s);
  for (const r of Object.values(s.reminders))
    if (r.state === 'pending' && r.task_id) {
      const t = s.tasks[r.task_id];
      if (!t || t.revision !== r.task_revision || ['verified', 'deferred', 'cancelled'].includes(t.state)) {
        r.state = 'cancelled';
        r.updated_at = at;
        r.cancel_reason = 'task_revision_or_state_changed';
      }
    }
}
