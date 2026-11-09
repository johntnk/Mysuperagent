import { emptyLedger, type Ledger } from './domain/contracts';
import { ensureCoordinationState } from './domain/source-items';

/**
 * Durable Object SQLite persistence for the coordination ledger.
 *
 * The domain layer works on one in-memory `Ledger` object, but it is never stored as a single row:
 * SQLite-backed Durable Objects cap a row at a few MB, and the ledger grows with every message.
 * Instead every record (task, event, outbox entry, ...) is its own row, append-only logs are stored
 * one entry per row with a retention cap, and each mutation writes only the rows that changed.
 */

/** Map-like collections of the ledger, persisted one row per entry. */
const RECORD_COLLECTIONS = [
  'issues',
  'tasks',
  'assignments',
  'cases',
  'events',
  'outbox',
  'subscriptions',
  'runs',
  'connector',
  'source_items',
  'reminders',
  'fake_records',
] as const;
type RecordCollection = (typeof RECORD_COLLECTIONS)[number];

/** Append-only arrays, persisted one entry per row; only the newest `cap` entries are kept. */
export const LOG_CAPS = {
  audit: 2000,
  proposals: 100,
  qa_reports: 500,
  relations: 2000,
  attention: 1000,
  fake_messages: 500,
} as const;
type LogName = keyof typeof LOG_CAPS;
const LOG_NAMES = Object.keys(LOG_CAPS) as LogName[];

/** Retention for records that are only needed for a while (deduplication, run history, chat items). */
export const RETENTION_DAYS = { events: 30, runs: 30, connector: 30, source_items: 90 } as const;
const TERMINAL_RUN_STATES = ['completed', 'stale', 'needs_attention'];
const INACTIVE_TASK_STATES = ['verified', 'cancelled'];

const KNOWN_KEYS = new Set<string>([
  'schema_version',
  'project_id',
  'fake',
  ...RECORD_COLLECTIONS.filter((c) => c !== 'fake_records'),
  ...LOG_NAMES.filter((l) => l !== 'fake_messages'),
]);

// Older in-memory shapes may lack newer collections; a missing collection persists as empty.
function recordsOf(ledger: Ledger, collection: RecordCollection): Record<string, unknown> {
  if (collection === 'fake_records') return ledger.fake?.records ?? {};
  return (ledger as unknown as Record<string, Record<string, unknown>>)[collection] ?? {};
}
function logOf(ledger: Ledger, name: LogName): unknown[] {
  if (name === 'fake_messages') return ledger.fake?.messages ?? [];
  return (ledger as unknown as Record<string, unknown[]>)[name] ?? [];
}
const rowKey = (collection: string, id: string) => `${collection}\u0000${id}`;

interface Snapshot {
  records: Map<string, { json: string; touched_at: string }>;
  logs: Record<LogName, { base: number; json: string[] }>;
  meta: Map<string, string>;
}

export class SqliteLedger {
  constructor(
    private storage: DurableObjectStorage,
    private project: string,
    private now: () => Date = () => new Date(),
  ) {
    storage.transactionSync(() => {
      storage.sql.exec(
        'CREATE TABLE IF NOT EXISTS agent_records(collection TEXT NOT NULL, id TEXT NOT NULL, json TEXT NOT NULL, touched_at TEXT NOT NULL, PRIMARY KEY(collection, id))',
      );
      storage.sql.exec(
        'CREATE TABLE IF NOT EXISTS agent_log(collection TEXT NOT NULL, seq INTEGER NOT NULL, json TEXT NOT NULL, PRIMARY KEY(collection, seq))',
      );
      storage.sql.exec('CREATE TABLE IF NOT EXISTS agent_meta(key TEXT PRIMARY KEY, json TEXT NOT NULL)');
    });
  }

  read(): Ledger {
    return this.load().ledger;
  }

  mutate<T>(fn: (ledger: Ledger) => { ledger: Ledger; result: T }): T {
    return this.storage.transactionSync(() => {
      const { ledger, snapshot } = this.load();
      const { ledger: next, result } = fn(ledger);
      this.persist(next, snapshot);
      return result;
    });
  }

  private load(): { ledger: Ledger; snapshot: Snapshot } {
    const sql = this.storage.sql;
    const ledger = emptyLedger(this.project);
    const snapshot: Snapshot = {
      records: new Map(),
      logs: Object.fromEntries(
        LOG_NAMES.map((n) => [n, { base: 0, json: [] as string[] }]),
      ) as unknown as Snapshot['logs'],
      meta: new Map(),
    };
    for (const row of sql.exec<{ key: string; json: string }>('SELECT key, json FROM agent_meta')) {
      snapshot.meta.set(row.key, row.json);
    }
    const scalars = snapshot.meta.get('scalars');
    if (scalars) {
      const s = JSON.parse(scalars);
      ledger.schema_version = s.schema_version;
      ledger.project_id = s.project_id;
      ledger.fake.creates = s.fake_creates;
      ledger.fake.updates = s.fake_updates;
    }
    const extras = snapshot.meta.get('extras');
    if (extras) Object.assign(ledger, JSON.parse(extras));
    for (const row of sql.exec<{ collection: string; id: string; json: string; touched_at: string }>(
      'SELECT collection, id, json, touched_at FROM agent_records',
    )) {
      if (!(RECORD_COLLECTIONS as readonly string[]).includes(row.collection)) continue;
      snapshot.records.set(rowKey(row.collection, row.id), { json: row.json, touched_at: row.touched_at });
      recordsOf(ledger, row.collection as RecordCollection)[row.id] = JSON.parse(row.json);
    }
    const bases: Partial<Record<LogName, number>> = JSON.parse(snapshot.meta.get('log_bases') || '{}');
    for (const name of LOG_NAMES) {
      const base = bases[name] ?? 0;
      const json: string[] = [];
      for (const row of sql.exec<{ json: string }>(
        'SELECT json FROM agent_log WHERE collection = ? AND seq >= ? ORDER BY seq',
        name,
        base,
      ))
        json.push(row.json);
      snapshot.logs[name] = { base, json };
      logOf(ledger, name).push(...json.map((x) => JSON.parse(x)));
    }
    ensureCoordinationState(ledger);
    return { ledger, snapshot };
  }

  private persist(next: Ledger, snapshot: Snapshot) {
    const sql = this.storage.sql;
    const now = this.now();
    const nowIso = now.toISOString();
    const expired = this.expiredRecords(next, snapshot, now);

    for (const collection of RECORD_COLLECTIONS) {
      const entries = recordsOf(next, collection);
      const seen = new Set<string>();
      for (const [id, value] of Object.entries(entries)) {
        const key = rowKey(collection, id);
        seen.add(key);
        if (expired.has(key)) continue;
        const json = JSON.stringify(value);
        const previous = snapshot.records.get(key);
        if (previous?.json === json) continue;
        if (previous)
          sql.exec('UPDATE agent_records SET json = ? WHERE collection = ? AND id = ?', json, collection, id);
        else
          sql.exec(
            'INSERT INTO agent_records(collection, id, json, touched_at) VALUES(?, ?, ?, ?)',
            collection,
            id,
            json,
            nowIso,
          );
      }
      for (const key of snapshot.records.keys()) {
        const [rowCollection, id] = key.split('\u0000');
        if (rowCollection === collection && (!seen.has(key) || expired.has(key)))
          sql.exec('DELETE FROM agent_records WHERE collection = ? AND id = ?', collection, id);
      }
    }

    const bases: Record<string, number> = {};
    for (const name of LOG_NAMES) {
      const before = snapshot.logs[name];
      const after = logOf(next, name).map((x) => JSON.stringify(x));
      for (let i = 0; i < after.length; i++) {
        if (i < before.json.length && before.json[i] === after[i]) continue;
        sql.exec(
          'INSERT INTO agent_log(collection, seq, json) VALUES(?, ?, ?) ON CONFLICT(collection, seq) DO UPDATE SET json = excluded.json',
          name,
          before.base + i,
          after[i],
        );
      }
      if (after.length < before.json.length)
        sql.exec('DELETE FROM agent_log WHERE collection = ? AND seq >= ?', name, before.base + after.length);
      let base = before.base;
      const overflow = after.length - LOG_CAPS[name];
      if (overflow > 0) {
        base += overflow;
        sql.exec('DELETE FROM agent_log WHERE collection = ? AND seq < ?', name, base);
      }
      bases[name] = base;
    }

    const extras = Object.fromEntries(Object.entries(next).filter(([key]) => !KNOWN_KEYS.has(key)));
    this.putMeta(snapshot, 'log_bases', bases);
    this.putMeta(snapshot, 'extras', extras);
    this.putMeta(snapshot, 'scalars', {
      schema_version: next.schema_version,
      project_id: next.project_id,
      fake_creates: next.fake.creates,
      fake_updates: next.fake.updates,
    });
  }

  private putMeta(snapshot: Snapshot, key: string, value: unknown) {
    const json = JSON.stringify(value);
    if (snapshot.meta.get(key) === json) return;
    this.storage.sql.exec(
      'INSERT INTO agent_meta(key, json) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET json = excluded.json',
      key,
      json,
    );
  }

  /** Rows past their retention window that nothing active still needs. */
  private expiredRecords(next: Ledger, snapshot: Snapshot, now: Date) {
    const expired = new Set<string>();
    const cutoff = (days: number) => new Date(now.getTime() - days * 86400000).toISOString();
    const old = (collection: string, id: string, days: number) => {
      const row = snapshot.records.get(rowKey(collection, id));
      return Boolean(row && row.touched_at < cutoff(days));
    };
    const activeRuns = new Set(
      Object.values(next.runs ?? {})
        .filter((r) => !TERMINAL_RUN_STATES.includes(r.state))
        .map((r) => r.run_id),
    );
    const activeRunEvents = new Set(
      Object.values(next.runs ?? {})
        .filter((r) => activeRuns.has(r.run_id))
        .map((r) => r.event_id),
    );
    for (const [key, event] of Object.entries(next.events ?? {}))
      if (!activeRunEvents.has(event.event_id) && old('events', key, RETENTION_DAYS.events))
        expired.add(rowKey('events', key));
    for (const [id, run] of Object.entries(next.runs ?? {}))
      if (!activeRuns.has(run.run_id) && old('runs', id, RETENTION_DAYS.runs))
        expired.add(rowKey('runs', id));
    for (const [id, op] of Object.entries(next.connector ?? {}))
      if (!activeRuns.has(op.run_id) && old('connector', id, RETENTION_DAYS.connector))
        expired.add(rowKey('connector', id));
    const liveTasks = new Set(
      Object.values(next.tasks ?? {})
        .filter((t) => !INACTIVE_TASK_STATES.includes(t.state))
        .map((t) => t.task_id),
    );
    for (const [id, item] of Object.entries(next.source_items ?? {}))
      if (
        !item.task_ids.some((t) => liveTasks.has(t)) &&
        old('source_items', id, RETENTION_DAYS.source_items)
      )
        expired.add(rowKey('source_items', id));
    return expired;
  }
}
