import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import type { ModelUsage } from '../analysis/openai-response';
import type { HistoryDecision, ReplayState, Trigger } from './observer';

export interface ReplayStep {
  number: number;
  trigger: Trigger;
  at: string;
  decision: HistoryDecision;
  input: unknown;
  input_sha256: string;
  usage: ModelUsage;
  estimated_cost_usd: number;
  response_id: string;
  model: string;
  latency_ms: number;
  created_task_ids: string[];
  people_count: number;
  task_count: number;
  evaluation?: {
    status: 'accepted' | 'rejected' | 'model_error';
    reason: string | null;
    raw_decision: unknown;
  };
  service_tier?: string;
}
export class ReplayStore {
  private db: DatabaseSync;
  constructor(directory: string) {
    this.db = new DatabaseSync(resolve(directory, 'replay.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL;
   CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS attempts (id INTEGER PRIMARY KEY, status TEXT NOT NULL, reserved_cost REAL NOT NULL, actual_cost REAL, record TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS steps (number INTEGER PRIMARY KEY, record TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS checkpoint (id INTEGER PRIMARY KEY CHECK(id=1), state TEXT NOT NULL);`);
  }
  setMeta(key: string, value: unknown) {
    this.db.prepare('INSERT OR REPLACE INTO metadata VALUES (?,?)').run(key, JSON.stringify(value));
  }
  meta<T>(key: string): T | undefined {
    const row = this.db.prepare('SELECT value FROM metadata WHERE key=?').get(key) as
      { value: string } | undefined;
    return row ? JSON.parse(row.value) : undefined;
  }
  checkpoint(): ReplayState | undefined {
    const row = this.db.prepare('SELECT state FROM checkpoint WHERE id=1').get() as
      { state: string } | undefined;
    return row ? JSON.parse(row.state) : undefined;
  }
  attempts() {
    return this.db
      .prepare('SELECT * FROM attempts ORDER BY id')
      .all()
      .map((row: any) => ({ ...row, record: JSON.parse(row.record) }));
  }
  steps(): ReplayStep[] {
    return this.db
      .prepare('SELECT record FROM steps ORDER BY number')
      .all()
      .map((row: any) => JSON.parse(row.record));
  }
  usedCost() {
    return Number(
      (
        this.db
          .prepare('SELECT COALESCE(SUM(COALESCE(actual_cost,reserved_cost)),0) AS total FROM attempts')
          .get() as any
      ).total,
    );
  }
  startAttempt(input: unknown, reserve: number) {
    const result = this.db
      .prepare('INSERT INTO attempts(status,reserved_cost,record) VALUES (?,?,?)')
      .run('started', reserve, JSON.stringify({ input, started_at: new Date().toISOString() }));
    return Number(result.lastInsertRowid);
  }
  failAttempt(id: number, reason: string, cost: number | null, details: unknown) {
    const previous = this.db.prepare('SELECT record FROM attempts WHERE id=?').get(id) as
      { record: string } | undefined;
    this.db.prepare('UPDATE attempts SET status=?,actual_cost=?,record=? WHERE id=?').run(
      'failed',
      cost,
      JSON.stringify({
        ...JSON.parse(previous?.record ?? '{}'),
        reason,
        details,
        finished_at: new Date().toISOString(),
      }),
      id,
    );
  }
  saveStep(attempt: number, step: ReplayStep, state: ReplayState) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT INTO steps VALUES (?,?)').run(step.number, JSON.stringify(step));
      this.db.prepare('INSERT OR REPLACE INTO checkpoint VALUES (1,?)').run(JSON.stringify(state));
      this.db.prepare('UPDATE attempts SET status=?,actual_cost=?,record=? WHERE id=?').run(
        step.evaluation?.status === 'rejected'
          ? 'validation_rejected'
          : step.evaluation?.status === 'model_error'
            ? 'model_error'
            : 'completed',
        step.estimated_cost_usd,
        JSON.stringify({
          response_id: step.response_id,
          usage: step.usage,
          input_sha256: step.input_sha256,
          evaluation: step.evaluation,
        }),
        attempt,
      );
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
  close() {
    this.db.close();
  }
}
