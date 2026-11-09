import { Agent } from 'agents';
import { createHash } from 'node:crypto';
import { loadConfig, type Secrets } from './config';
import { Command, type Ledger, type Effect } from './domain/contracts';
import { reduce, drainFake, followupDue, reminderDue, planEffect } from './domain/engine';
import { SqliteLedger } from './storage';
import { effectBlock, inWorkWindow, type Policy } from './policy';
import { requireRule } from './domain/rules';
import {
  FeishuMessageAdapter,
  UnconfiguredProjectAdapter,
  BlockedAdapter,
  RetryableFailure,
  withinIdempotencyWindow,
} from './adapters/feishu';
import { contextFor } from './analysis/planner';
import { ReadRequest, requestPath } from './connector/protocol';
import { bindMessage, correlateConversation, decorateMessageEffects } from './conversation';
import { normalizeReviews } from './adapters/feedback';
import { itemsForEvent } from './domain/source-items';

export interface Env extends Secrets {
  PROJECT: any;
  ISSUE_ROUND: any;
}
/** A run whose context went stale while the model was thinking is retried with fresh context. */
const MAX_STALE_RETRIES = 2;
export class ProjectAgent extends Agent<Env> {
  private ledgerStore?: SqliteLedger;
  private get store() {
    return (this.ledgerStore ??= new SqliteLedger(this.ctx.storage, loadConfig(this.env).config.projectKey));
  }
  async onStart() {
    this.store.mutate((s) => {
      for (const e of Object.values(s.outbox))
        if (e.state === 'sending') {
          e.state = 'unknown';
          e.last_error = 'interrupted_send';
        }
      for (const r of Object.values(s.runs)) if (r.state === 'starting') r.state = 'queued';
      return { ledger: s, result: null };
    });
  }
  async onRequest(request: Request) {
    const path = new URL(request.url).pathname;
    try {
      if (path === '/state' && request.method === 'GET') return Response.json(this.store.read());
      if (path === '/ingest' && request.method === 'POST')
        return Response.json(await this.ingest(Command.parse(await request.json())));
      if (path === '/tick' && request.method === 'POST') {
        await this.tick();
        return Response.json({ ok: true });
      }
      if (path === '/run/context' && request.method === 'POST') {
        const { id } = (await request.json()) as any;
        return Response.json(this.runContext(id));
      }
      if (path === '/run/finish' && request.method === 'POST') {
        const result = this.finishRun((await request.json()) as any);
        if (result.requeued) this.ctx.waitUntil(this.kickRuns());
        this.ctx.waitUntil(this.dispatch());
        return Response.json(result);
      }
      if (path === '/connector/poll' && request.method === 'GET') return Response.json(this.pollReads());
      if (path === '/connector/result' && request.method === 'POST') {
        const body = (await request.json()) as any;
        const result = this.connectorResult(body);
        if (!result.duplicate) this.ctx.waitUntil(this.processEvidence(body.operation_id));
        return Response.json(result);
      }
      if (path === '/reads' && request.method === 'POST') {
        this.queueRead(await request.json());
        return Response.json({ queued: true });
      }
      return new Response('Not found', { status: 404 });
    } catch (e) {
      return Response.json({ error: e instanceof Error ? e.message : 'REQUEST_FAILED' }, { status: 400 });
    }
  }
  async ingest(c: Command) {
    const { config, policy } = loadConfig(this.env);
    requireRule(!c.envelope || c.envelope.project_id === config.projectKey, 'project_mismatch');
    const result = this.store.mutate((s) => {
      c = correlateConversation(s, c, policy);
      let next = reduce(s, c, policy);
      decorateMessageEffects(next, policy, config.allowlists.feishuChatIds[0] || null);
      const duplicate =
        next.audit.at(-1)?.event_id === c.event_id && next.audit.at(-1)?.type === 'duplicate_ignored';
      const rejected = next.audit.at(-1)?.event_id === c.event_id && next.audit.at(-1)?.type === 'rejected';
      const runId =
        'run_' +
        createHash('sha256')
          .update(
            JSON.stringify([config.projectKey, c.source_event_id || c.event_id, c.source_revision || '']),
          )
          .digest('hex')
          .slice(0, 40);
      const recordOnly =
        next.audit.at(-1)?.event_id === c.event_id && next.audit.at(-1)?.type === 'record_only';
      if (
        ['feedback_observed', 'evidence_observed'].includes(c.event_type) &&
        !duplicate &&
        !rejected &&
        (!recordOnly || (c.envelope?.source === 'feishu_message' && Boolean(c.payload.text?.trim()))) &&
        !next.runs[runId] &&
        !c.payload.historical
      ) {
        const issue = c.payload.issue_id
          ? next.issues[c.payload.issue_id]
          : Object.values(next.issues).find((i) =>
              i.case_ids.some((id) => next.cases[id]?.source_event_ids.includes(c.event_id)),
            );
        next.runs[runId] = {
          run_id: runId,
          event_id: c.event_id,
          issue_id: issue?.issue_id || null,
          expected_revision: issue?.revision || 0,
          task_revisions: Object.fromEntries(
            (issue?.task_ids || []).map((id) => [id, next.tasks[id]?.revision || 0]),
          ),
          state: 'queued',
          started_at: new Date().toISOString(),
          model_calls: 0,
          tool_reads: 0,
        };
        if (
          c.event_type === 'feedback_observed' &&
          config.mode !== 'mock' &&
          config.capabilities.readEvidence &&
          config.evidenceConnector.enabled
        ) {
          const source = config.evidenceConnector.sources.runtimeLogs.sourceId;
          if (source && config.allowlists.evidenceSourceIds.includes(source as never))
            for (const trace of (c.payload.run_refs || [])
              .filter((x: string) => /^tr_[0-9a-f]{32}$/.test(x))
              .slice(0, config.budgets.toolReadsPerRun)) {
              const id = `read:${runId}:${trace}`;
              next.connector[id] = {
                operation_id: id,
                run_id: runId,
                source_id: source,
                capability: 'trace.get',
                params: { trace_id: trace },
                state: 'pending',
                notification_pending: false,
                expires_at: new Date(Date.now() + 180000).toISOString(),
              };
              next.runs[runId].tool_reads++;
            }
        }
      }
      // Formal task updates and QA are synchronized through the same durable outbox.
      for (const task of Object.values(next.tasks))
        if (
          policy.task_backend !== 'agent_ledger' &&
          task.external_record &&
          s.tasks[task.task_id]?.revision !== task.revision
        ) {
          const id = `sync:${task.task_id}:${task.revision}`;
          next.outbox[id] = {
            operation_id: id,
            project_id: next.project_id,
            issue_id: task.issue_id,
            task_id: task.task_id,
            expected_revision: task.revision,
            planned_mode: policy.mode,
            capability: 'work_item.update',
            target: config.workItemBackend.feishuProject.spaceId || 'fake_project_space',
            target_owner_key: task.primary_owner_key,
            request_ref: c.event_id,
            request: { task: structuredClone(task) },
            state: 'pending',
            attempt_count: 0,
            last_error: null,
            external_result_ref: null,
            requires_operation_id: null,
            next_attempt_at: null,
            created_at: c.occurred_at,
          };
        }
      // Replace simulation destinations from explicit config only, before any dispatcher sees them.
      if (policy.transport === 'real')
        for (const effect of Object.values(next.outbox))
          if (
            effect.state === 'blocked' &&
            effect.last_error === 'target_not_allowlisted' &&
            effect.target.startsWith('fake_')
          ) {
            effect.target = effect.capability.startsWith('message')
              ? config.allowlists.feishuChatIds[0] || ''
              : config.workItemBackend.feishuProject.spaceId || '';
            effect.last_error = effectBlock(
              policy,
              effect,
              effect.task_id ? next.tasks[effect.task_id] : undefined,
            );
            effect.state = effect.last_error ? 'blocked' : 'pending';
          }
      for (const e of Object.values(next.outbox))
        if (e.state === 'blocked') {
          const reason = effectBlock(policy, e, e.task_id ? next.tasks[e.task_id] : undefined);
          if (!reason) {
            e.state = 'pending';
            e.last_error = null;
          }
        }
      if (policy.transport === 'fake') next = drainFake(next, policy);
      const own = [...next.audit].reverse().find((a) => a.event_id === c.event_id);
      const task = c.payload.task_id ? next.tasks[c.payload.task_id] : undefined;
      return {
        ledger: next,
        result: {
          accepted: true,
          duplicate,
          run_id: next.runs[runId] ? runId : null,
          // Lets a card callback answer with a precise toast instead of a generic "OK".
          rejected: own && ['rejected', 'qa_rejected'].includes(own.type) ? own.reason : undefined,
          task: task ? { task_id: task.task_id, state: task.state, revision: task.revision } : undefined,
        },
      };
    });
    // ACK follows durable commit; a failed wake cannot lose the queued run.
    this.ctx.waitUntil(this.kickRuns());
    this.ctx.waitUntil(this.dispatch());
    return result;
  }
  async kickRuns() {
    const { config } = loadConfig(this.env),
      s = this.store.read();
    for (const r of Object.values(s.runs).filter((r) => r.state === 'queued')) {
      const claimed = this.store.mutate((current) => {
        const run = current.runs[r.run_id];
        if (
          run?.state !== 'queued' ||
          Object.values(current.runs).filter((r) => ['running', 'starting'].includes(r.state)).length >=
            config.budgets.maxConcurrentRuns
        )
          return { ledger: current, result: false };
        run.state = 'starting';
        run.started_at = new Date().toISOString();
        run.start_attempts = (run.start_attempts || 0) + 1;
        return { ledger: current, result: true };
      });
      if (!claimed) continue;
      try {
        await this.env.ISSUE_ROUND.create({
          id: r.run_id,
          params: { run_id: r.run_id, project_id: config.projectKey },
        });
        this.store.mutate((current) => {
          if (current.runs[r.run_id]?.state === 'starting') current.runs[r.run_id].state = 'running';
          return { ledger: current, result: null };
        });
      } catch {
        try {
          const instance = await this.env.ISSUE_ROUND.get(r.run_id);
          await instance.status();
          this.store.mutate((current) => {
            if (current.runs[r.run_id]?.state === 'starting') current.runs[r.run_id].state = 'running';
            return { ledger: current, result: null };
          });
        } catch {
          this.store.mutate((current) => {
            if (current.runs[r.run_id]?.state === 'starting')
              current.runs[r.run_id].state =
                (current.runs[r.run_id].start_attempts || 0) >= 3 ? 'needs_attention' : 'queued';
            return { ledger: current, result: null };
          });
        }
      }
    }
  }
  runContext(id: string) {
    const { config, routing, policy } = loadConfig(this.env);
    return this.store.mutate((s) => {
      const run = s.runs[id];
      requireRule(run, 'run_missing');
      const event = Object.values(s.events).find((e) => e.event_id === run.event_id);
      requireRule(event, 'run_event_missing');
      const input = contextFor(
        s,
        { ...event, payload: { ...event.payload, ...(run.issue_id ? { issue_id: run.issue_id } : {}) } },
        routing,
        config.budgets.maxInputCharacters,
      );
      if (config.mode !== 'mock')
        input.allowed_people = input.allowed_people.filter((id) => policy.identities[id]?.verified);
      run.source_revisions = Object.fromEntries(input.source_items.map((i) => [i.item_id, i.revision]));
      run.task_revisions = Object.fromEntries(input.current_assignments.map((t) => [t.task_id, t.revision]));
      return {
        ledger: s,
        result: {
          run,
          input,
          config,
          reads: Object.values(s.connector).filter(
            (o) => o.run_id === id || o.operation_id === event.payload.operation_id,
          ),
        },
      };
    });
  }

  finishRun(body: { run_id: string; result: any }) {
    const { policy, config, routing } = loadConfig(this.env);
    return this.store.mutate<{ duplicate?: boolean; stale?: boolean; accepted?: boolean; requeued?: string }>(
      (s) => {
        const run = s.runs[body.run_id];
        requireRule(run, 'run_missing');
        if (['completed', 'stale', 'needs_attention'].includes(run.state))
          return { ledger: s, result: { duplicate: true } };
        const issue = run.issue_id ? s.issues[run.issue_id] : undefined;
        run.result = body.result;
        run.model_calls = body.result.model_calls || 0;
        const issueClosed =
          issue &&
          (issue.lifecycle !== 'open' ||
            (issue.task_ids.length > 0 &&
              issue.task_ids.every((id) => ['deferred', 'cancelled'].includes(s.tasks[id]?.state))));
        if (
          issueClosed ||
          (issue && issue.revision !== run.expected_revision) ||
          Object.entries(run.task_revisions || {}).some(
            ([id, revision]) => s.tasks[id]?.revision !== revision,
          )
        ) {
          run.state = 'stale';
          // Another message changed the tasks while this one was being analysed. Its source items would
          // otherwise stay unclassified forever, so analyse it again against the current ledger.
          const attempt = (run.attempt ?? 0) + 1;
          if (!issueClosed && attempt <= MAX_STALE_RETRIES) {
            const retryId = `${run.retry_of ?? run.run_id}-r${attempt}`;
            s.runs[retryId] ??= {
              run_id: retryId,
              event_id: run.event_id,
              issue_id: run.issue_id,
              expected_revision: issue?.revision || 0,
              task_revisions: {},
              state: 'queued',
              started_at: new Date().toISOString(),
              model_calls: 0,
              tool_reads: 0,
              attempt,
              retry_of: run.retry_of ?? run.run_id,
            };
            return { ledger: s, result: { stale: true, requeued: retryId } };
          }
          return { ledger: s, result: { stale: true } };
        }
        run.state = body.result.status;
        if (run.state === 'needs_attention') this.flagFailedRun(s, run.run_id, body.result.reason, policy);
        let next = s;
        if (body.result.status === 'completed' && body.result.proposal) {
          const source = Object.values(s.events).find((e) => e.event_id === run.event_id);
          const c: Command = {
            event_id: `analysis:${body.run_id}`,
            event_type: 'analysis_completed',
            actor_key: 'system',
            occurred_at: new Date().toISOString(),
            payload: {
              ...body.result.proposal,
              issue_id: run.issue_id,
              current_item_ids: itemsForEvent(s, run.event_id).map((i) => i.item_id),
              expected_source_revisions: run.source_revisions,
              person_names: Object.fromEntries(routing.members.map((m) => [m.personKey, m.displayName])),
              source_message_id: source?.payload.source_message_id,
              source_chat_id: source?.payload.source_chat_id,
            },
          };
          next = reduce(s, c, policy);
          if (next.audit.at(-1)?.type === 'rejected') {
            next.runs[body.run_id].state = 'needs_attention';
            this.flagFailedRun(next, body.run_id, `proposal_rejected:${next.audit.at(-1)?.reason}`, policy);
            decorateMessageEffects(next, policy, config.allowlists.feishuChatIds[0] || null);
            return { ledger: next, result: { accepted: false } };
          }
        }
        decorateMessageEffects(next, policy, config.allowlists.feishuChatIds[0] || null);
        for (const e of Object.values(next.outbox))
          if (e.state === 'blocked') {
            const reason = effectBlock(policy, e, e.task_id ? next.tasks[e.task_id] : undefined);
            if (!reason) {
              e.state = 'pending';
              e.last_error = null;
            }
          }
        if (policy.transport === 'fake') next = drainFake(next, policy);
        return { ledger: next, result: { accepted: true } };
      },
    );
  }
  /**
   * A message whose analysis failed must not disappear silently: keep it on the attention list and tell
   * the coordinator (at most one notice per hour, through the normal policy-checked outbox).
   */
  private flagFailedRun(s: Ledger, runId: string, reason: unknown, policy: Policy) {
    const key = `run:${runId}`;
    if (!s.attention.includes(key)) s.attention.push(key);
    const now = new Date().toISOString();
    const failed = Object.values(s.runs).filter(
      (r) => r.state === 'needs_attention' && (r.started_at || '').slice(0, 10) === now.slice(0, 10),
    ).length;
    planEffect(
      s,
      policy,
      {
        event_id: `run-attention:${runId}`,
        event_type: 'run_attention',
        actor_key: 'system',
        occurred_at: now,
        payload: {},
      },
      {
        operation_id: `run-attention:${now.slice(0, 13)}`,
        capability: 'message.send',
        target_owner_key: policy.decision_owners[0] || null,
        request: {
          purpose: 'run_attention',
          suppress_mention: true,
          text: `有消息没能完成自动分析（今天第 ${failed} 条，最近原因：${String(reason || 'unknown')}）。原文已保存，未做任何任务变更；请到管理接口 /api/state 的 attention 列表查看。`,
        },
      },
    );
  }
  queueRead(raw: unknown) {
    const r = ReadRequest.parse(raw),
      { config } = loadConfig(this.env);
    requireRule(
      config.mode !== 'mock' && config.capabilities.readEvidence && config.evidenceConnector.enabled,
      'connector_disabled',
    );
    requireRule(
      config.allowlists.evidenceSourceIds.includes(r.source_id as never) &&
        r.project_id === config.projectKey,
      'source_not_allowlisted',
    );
    requestPath(r.capability, r.params);
    this.store.mutate((s) => {
      requireRule(s.runs[r.run_id], 'run_missing');
      const existing = s.connector[r.operation_id];
      if (existing) {
        requireRule(
          existing.run_id === r.run_id &&
            existing.source_id === r.source_id &&
            existing.capability === r.capability &&
            requestPath(r.capability, existing.params) === requestPath(r.capability, r.params),
          'read_operation_conflict',
        );
        return { ledger: s, result: null };
      }
      requireRule(['queued', 'starting', 'running'].includes(s.runs[r.run_id].state), 'run_not_active');
      requireRule(s.runs[r.run_id].tool_reads < config.budgets.toolReadsPerRun, 'read_budget_exceeded');
      s.connector[r.operation_id] = { ...r, state: 'pending', notification_pending: false };
      s.runs[r.run_id].tool_reads++;
      return { ledger: s, result: null };
    });
  }
  pollReads() {
    const { config } = loadConfig(this.env);
    if (config.mode === 'mock' || !config.capabilities.readEvidence || !config.evidenceConnector.enabled)
      return { requests: [] };
    return this.store.mutate((s) => {
      const now = Date.now(),
        requests = [];
      for (const op of Object.values(s.connector)) {
        if (
          config.allowlists.evidenceSourceIds.includes(op.source_id as never) &&
          ['queued', 'starting', 'running'].includes(s.runs[op.run_id]?.state) &&
          ['pending', 'leased'].includes(op.state) &&
          Date.parse(op.expires_at) > now &&
          (!op.leased_until || Date.parse(op.leased_until) < now)
        ) {
          op.state = 'leased';
          op.leased_until = new Date(now + 120000).toISOString();
          requests.push({
            operation_id: op.operation_id,
            run_id: op.run_id,
            project_id: s.project_id,
            source_id: op.source_id,
            capability: op.capability,
            params: op.params,
            expires_at: op.expires_at,
          });
          if (requests.length >= 4) break;
        }
      }
      return { ledger: s, result: { requests } };
    });
  }
  connectorResult(body: any) {
    return this.store.mutate<{ duplicate?: boolean; accepted?: boolean }>((s) => {
      const op = s.connector[body.operation_id];
      requireRule(
        op && op.run_id === body.run_id && op.source_id === body.source_id,
        'connector_correlation_mismatch',
      );
      if (op.result) return { ledger: s, result: { duplicate: true } };
      requireRule(['found', 'absent', 'unavailable'].includes(body.result?.status), 'result_invalid');
      const terminal = ['completed', 'needs_attention', 'stale'].includes(s.runs[op.run_id]?.state);
      op.result = body;
      op.state = terminal ? 'received_late' : 'received';
      op.notification_pending = !terminal;
      op.processing_pending = true;
      return { ledger: s, result: { accepted: true } };
    });
  }
  async processEvidence(operation_id: string) {
    const s = this.store.read(),
      op = s.connector[operation_id];
    if (!op?.result) return;
    const result = (op.result as any).result;
    if (op.capability === 'feedback.list' && result.status === 'found' && !s.runs[op.run_id]?.issue_id) {
      const page = normalizeReviews(result.data, s.project_id, op.source_id);
      for (const c of page.events) await this.ingest(c);
      this.store.mutate((current) => {
        current.audit.push({
          event_id: operation_id,
          type: 'feedback_page_imported',
          at: new Date().toISOString(),
          details: { count: page.events.length, next_cursor: page.next_cursor },
        });
        return { ledger: current, result: null };
      });
    } else if (op.state === 'received_late') {
      const run = s.runs[op.run_id],
        issue = run?.issue_id ? s.issues[run.issue_id] : undefined;
      if (
        issue?.lifecycle === 'open' &&
        (!issue.task_ids.length ||
          issue.task_ids.some((id) => !['deferred', 'cancelled'].includes(s.tasks[id]?.state)))
      )
        await this.ingest({
          event_id: `evidence:${operation_id}`,
          event_type: 'evidence_observed',
          actor_key: 'system',
          occurred_at: new Date().toISOString(),
          payload: {
            issue_id: issue.issue_id,
            operation_id,
            source_id: op.source_id,
            availability: result.status,
          },
        });
    }
    this.store.mutate((current) => {
      if (current.connector[operation_id]) current.connector[operation_id].processing_pending = false;
      return { ledger: current, result: null };
    });
  }
  async tick() {
    const { policy, config } = loadConfig(this.env);
    const now = new Date().toISOString();
    // Most ticks find nothing due; check first so an idle tick neither copies nor rewrites the ledger.
    const current = this.store.read();
    const dueReminders = Object.keys(current.reminders ?? {}).filter((id) =>
      reminderDue(current, id, now, policy),
    );
    const dueTasks = Object.values(current.tasks)
      .filter((t) => followupDue(current, t, now, policy))
      .map((t) => t.task_id);
    if (dueReminders.length || dueTasks.length)
      this.store.mutate((s) => {
        let next = s;
        for (const id of dueReminders)
          if (reminderDue(next, id, now, policy))
            next = reduce(
              next,
              {
                event_id: `planned-check:${id}:${now.slice(0, 16)}`,
                event_type: 'coordination_reminder_fired',
                actor_key: 'system',
                occurred_at: now,
                payload: { reminder_id: id },
              },
              policy,
            );
        for (const taskId of dueTasks) {
          const t = next.tasks[taskId];
          if (t && followupDue(next, t, now, policy))
            next = reduce(
              next,
              {
                event_id: `timer:${t.task_id}:${t.revision}:${now.slice(0, 16)}`,
                event_type: 'timer_fired',
                actor_key: 'system',
                occurred_at: now,
                payload: { task_id: t.task_id, expected_revision: t.revision },
              },
              policy,
            );
        }
        decorateMessageEffects(next, policy, config.allowlists.feishuChatIds[0] || null);
        for (const e of Object.values(next.outbox))
          if (e.state === 'blocked') {
            const reason = effectBlock(policy, e, e.task_id ? next.tasks[e.task_id] : undefined);
            if (!reason) {
              e.state = 'pending';
              e.last_error = null;
            }
          }
        if (policy.transport === 'fake') next = drainFake(next, policy);
        return { ledger: next, result: null };
      });
    for (const op of Object.values(this.store.read().connector).filter((op) => op.processing_pending))
      await this.processEvidence(op.operation_id);
    for (const r of Object.values(this.store.read().runs).filter(
      (r) => r.state === 'running' && Date.now() - Date.parse(r.started_at) > 300000,
    )) {
      try {
        const instance = await this.env.ISSUE_ROUND.get(r.run_id),
          status = await instance.status();
        if (['errored', 'terminated', 'complete'].includes(status.status))
          this.store.mutate((s) => {
            if (s.runs[r.run_id].state === 'running') {
              s.runs[r.run_id].state = 'needs_attention';
              s.runs[r.run_id].result = {
                reason: 'workflow_terminal_without_committed_result',
                workflow_status: status.status,
              };
            }
            return { ledger: s, result: null };
          });
      } catch {
        /* preserve durable status for next reconciliation */
      }
    }
    await this.kickRuns();
    await this.dispatch();
    await this.notifyResults();
  }
  async notifyResults() {
    for (const op of Object.values(this.store.read().connector).filter((o) => o.notification_pending)) {
      if (['completed', 'needs_attention', 'stale'].includes(this.store.read().runs[op.run_id]?.state)) {
        this.store.mutate((s) => {
          s.connector[op.operation_id].notification_pending = false;
          return { ledger: s, result: null };
        });
        continue;
      }
      try {
        const instance = await this.env.ISSUE_ROUND.get(op.run_id);
        await instance.sendEvent({ type: 'evidence-ready', payload: { operation_id: op.operation_id } });
        this.store.mutate((s) => {
          s.connector[op.operation_id].notification_pending = false;
          return { ledger: s, result: null };
        });
      } catch {
        /* durable intent remains; next cron retries */
      }
    }
  }
  async dispatch() {
    const { config, policy } = loadConfig(this.env);
    if (policy.transport === 'fake') return;
    // A missing Project contract is fail-closed; messaging never claims a failed create succeeded.
    const workItems = new UnconfiguredProjectAdapter();
    for (const id of Object.values(this.store.read().outbox)
      .filter((e) => ['pending', 'failed_retryable', 'unknown'].includes(e.state))
      .slice(0, 100)
      .map((e) => e.operation_id)) {
      const snapshot = this.store.read(),
        e = snapshot.outbox[id];
      if (!e) continue;
      const port = e.capability.startsWith('message')
        ? new FeishuMessageAdapter(config, this.env, fetch, () => {
            const current = this.store.read(),
              latest = loadConfig(this.env).policy,
              cur = current.outbox[id];
            const reason = effectBlock(latest, cur, cur.task_id ? current.tasks[cur.task_id] : undefined);
            if (reason || cur.state !== 'sending')
              throw new BlockedAdapter(reason || 'OPERATION_NOT_SENDING');
          })
        : workItems;
      if (e.state === 'unknown') {
        if (e.next_attempt_at && Date.parse(e.next_attempt_at) > Date.now()) continue;
        const r = await port.reconcile(e);
        // retry_safe: still inside the platform's idempotency window, so a resend with the same key
        // cannot create a second message. The state stays `unknown` until the claim below re-checks it.
        if (r.status !== 'retry_safe') {
          this.store.mutate((s) => {
            const cur = s.outbox[id];
            if (cur.state !== 'unknown') return { ledger: s, result: null };
            if (r.status === 'found') {
              cur.state = 'succeeded';
              cur.external_result_ref = r.record_ref;
            } else if (r.status === 'absent') cur.state = 'pending';
            else if (!s.attention.includes(id)) s.attention.push(id);
            return { ledger: s, result: null };
          });
          continue;
        }
      }
      if (
        !['pending', 'failed_retryable', 'unknown'].includes(e.state) ||
        (e.state !== 'unknown' && e.next_attempt_at && Date.parse(e.next_attempt_at) > Date.now())
      )
        continue;
      if (
        e.capability.startsWith('message') &&
        e.request.purpose !== 'command_receipt' &&
        !inWorkWindow(new Date().toISOString(), policy)
      )
        continue;
      const claimed = this.store.mutate((s) => {
        const cur = s.outbox[id];
        const latest = loadConfig(this.env).policy;
        const reason = effectBlock(latest, cur, cur.task_id ? s.tasks[cur.task_id] : undefined);
        if (reason) {
          cur.state = 'blocked';
          cur.last_error = reason;
          return { ledger: s, result: false };
        }
        if (cur.requires_operation_id && s.outbox[cur.requires_operation_id]?.state !== 'succeeded')
          return { ledger: s, result: false };
        const resend = cur.state === 'unknown' && withinIdempotencyWindow(cur, Date.now());
        if (cur.state !== 'pending' && cur.state !== 'failed_retryable' && !resend)
          return { ledger: s, result: false };
        const date = (at: string) =>
            new Intl.DateTimeFormat('en-CA', { timeZone: latest.notifications.timezone }).format(
              new Date(at),
            ),
          today = date(new Date().toISOString());
        if (
          cur.request.mention_open_id &&
          Object.values(s.outbox).filter(
            (x) =>
              x.operation_id !== cur.operation_id &&
              x.task_id === cur.task_id &&
              x.request.mention_open_id &&
              ['succeeded', 'sending', 'unknown'].includes(x.state) &&
              date(x.last_attempt_at || x.created_at) === today,
          ).length >= latest.notifications.max_per_day
        )
          return { ledger: s, result: false };
        cur.state = 'sending';
        cur.attempt_count++;
        cur.last_attempt_at = new Date().toISOString();
        cur.first_attempt_at ??= cur.last_attempt_at;
        return { ledger: s, result: true };
      });
      if (!claimed) continue;
      try {
        const result = await port.execute(e, e.task_id ? snapshot.tasks[e.task_id] : undefined);
        this.store.mutate((s) => {
          const cur = s.outbox[id];
          cur.state = 'succeeded';
          cur.external_result_ref = result.record_ref;
          if (cur.task_id && cur.capability.startsWith('message')) {
            bindMessage(s, result.record_ref, cur.task_id);
            const t = s.tasks[cur.task_id],
              a = t?.assignment_id ? s.assignments[t.assignment_id] : undefined;
            if (cur.request.purpose === 'handoff' && a?.scope_revision === cur.expected_revision)
              a.assigned_at = cur.last_attempt_at || new Date().toISOString();
          }
          if (cur.task_id && cur.capability === 'work_item.create')
            s.tasks[cur.task_id].external_record = {
              platform: 'feishu_project',
              record_id: result.record_ref,
            };
          return { ledger: s, result: null };
        });
      } catch (error) {
        this.store.mutate((s) => {
          const cur = s.outbox[id];
          cur.state =
            error instanceof BlockedAdapter
              ? 'blocked'
              : error instanceof RetryableFailure && cur.attempt_count < 4
                ? 'failed_retryable'
                : 'unknown';
          cur.last_error = error instanceof Error ? error.message : 'WRITE_UNKNOWN';
          cur.next_attempt_at = new Date(
            Date.now() + Math.min(900000, 30000 * 2 ** cur.attempt_count),
          ).toISOString();
          return { ledger: s, result: null };
        });
      }
    }
  }
}
