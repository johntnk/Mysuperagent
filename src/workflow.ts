import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import type { Env } from './coordinator';
import { boundedPlan, FakePlanner, fitPlannerInput, OpenAIPlanner } from './analysis/planner';
import { loadConfig, type ProjectConfig } from './config';
import { evidenceForModel, planEvidenceReads } from './analysis/evidence-plan';
import { FeishuClient } from './adapters/feishu';
export class IssueRound extends WorkflowEntrypoint<Env, { run_id: string; project_id: string }> {
  /** Images attached to the analysed message, when the deployment allows reading them. */
  private async messageImages(config: ProjectConfig, payload: Record<string, any>) {
    if (config.mode === 'mock' || !config.capabilities.readMessageImages) return [];
    const messageId = payload.source_message_id;
    const keys: string[] = (payload.image_keys ?? []).slice(0, config.budgets.maxImagesPerRun);
    if (!messageId || !keys.length) return [];
    const client = new FeishuClient(config, this.env);
    const images: { message_id: string; data_url: string }[] = [];
    for (const key of keys) {
      try {
        const data_url = await client.messageImage(messageId, key, config.budgets.maxImageBytes);
        if (data_url) images.push({ message_id: messageId, data_url });
      } catch {
        /* an unreadable image leaves the analysis text-only; it is not a reason to fail the run */
      }
    }
    return images;
  }
  async run(event: WorkflowEvent<{ run_id: string; project_id: string }>, step: WorkflowStep) {
    const { run_id, project_id } = event.payload;
    const stub = this.env.PROJECT.get(this.env.PROJECT.idFromName(project_id));
    const rpc = async (path: string, body: unknown) => {
      const r = await stub.fetch(`https://project${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error(`COORDINATOR_${r.status}`);
      return r.json() as Promise<any>;
    };
    let context = await step.do('load-durable-context', () => rpc('/run/context', { id: run_id }));
    if (context.reads.some((r: any) => !r.result)) {
      try {
        await step.waitForEvent('bounded-evidence-wait', { type: 'evidence-ready', timeout: '30 seconds' });
      } catch {
        /* evidence unavailable is a business result, not an infinite retry */
      }
      context = await step.do('reload-evidence-ledger', () => rpc('/run/context', { id: run_id }));
    }
    const { config, routing } = loadConfig(this.env);
    const analyze = async (label: string, remainingCalls: number) =>
      step.do(label, { retries: { limit: 0, delay: '1 second' }, timeout: '4 minutes' }, async () => {
        const remainingSeconds =
          config.budgets.runTimeoutSeconds - (Date.now() - Date.parse(context.run.started_at)) / 1000;
        if (remainingSeconds <= 0)
          return { status: 'needs_attention', reason: 'run_time_budget_exceeded', model_calls: 0 };
        const planner =
          config.mode === 'mock' || !config.capabilities.modelInference
            ? new FakePlanner(routing)
            : new OpenAIPlanner(this.env, config);
        const reads = evidenceForModel(context.reads, Math.floor(config.budgets.maxInputCharacters / 2));
        // Evidence reads are added after the durable context was built, so fit the whole input again.
        const input = fitPlannerInput(
          {
            ...context.input,
            evidence: [...context.input.evidence, ...reads],
            read_availability: {
              enabled: config.capabilities.readEvidence && config.evidenceConnector.enabled,
              remaining_read_rounds: Math.min(2, remainingCalls - 1),
            },
          },
          config.budgets.maxInputCharacters,
        );
        // Screenshots are fetched inside the step (never returned from it: step results are size-limited).
        input.images = await this.messageImages(config, context.input.event?.payload ?? {});
        return boundedPlan(planner, input, {
          ...config,
          budgets: {
            ...config.budgets,
            modelCallsPerRun: remainingCalls,
            runTimeoutSeconds: remainingSeconds,
          },
        });
      });
    let result = await analyze('bounded-planner', config.budgets.modelCallsPerRun);
    for (
      let round = 0;
      round < 2 && result.status === 'completed' && result.proposal?.evidence_requests.length;
      round++
    ) {
      const plan = planEvidenceReads(result.proposal.evidence_requests, config, context.run, context.reads);
      const remaining = config.budgets.modelCallsPerRun - result.model_calls;
      if (plan.requests.length && remaining > 0) {
        await step.do(`queue-bounded-evidence-${round}`, async () => {
          for (const request of plan.requests) await rpc('/reads', request);
          return { count: plan.requests.length };
        });
        try {
          await step.waitForEvent(`bounded-supplemental-evidence-${round}`, {
            type: 'evidence-ready',
            timeout: '30 seconds',
          });
        } catch {
          /* retain missing evidence explicitly */
        }
        context = await step.do(`reload-supplemental-evidence-${round}`, () =>
          rpc('/run/context', { id: run_id }),
        );
        const priorCalls = result.model_calls;
        result = await analyze(`planner-after-evidence-${round}`, remaining);
        result.model_calls += priorCalls;
      } else {
        if (result.proposal) {
          result.proposal.missing_information.push(
            ...plan.unavailable,
            ...(plan.requests.length ? ['本轮读取预算已用完，需要补充这些证据后再判断'] : []),
          );
          if (plan.requests.length || plan.unavailable.length) {
            result.proposal.decision_type = 'request_decision';
            result.proposal.proposed_task_changes = [];
          }
        }
        break;
      }
    }
    await step.do('commit-result-with-revision-check', () => rpc('/run/finish', { run_id, result }));
    return { run_id, status: result.status };
  }
}
