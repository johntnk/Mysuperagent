import { CoordinationPlan, type SourceItem } from './coordination-schema';
import { type Ledger, type Command, newIssue, newTask } from './contracts';
import { requireRule } from './rules';
import { type Policy } from '../policy';
import { ensureCoordinationState, stableId } from './source-items';

const unique = <T>(xs: T[]) => [...new Set(xs)];
const date = (at: string) => /(Z|[+-]\d{2}:\d{2})$/.test(at) && Number.isFinite(Date.parse(at));
const targetDate = (at: string) =>
  date(at) ||
  (/^\d{4}-\d{2}-\d{2}$/.test(at) &&
    Number.isFinite(Date.parse(at)) &&
    new Date(at).toISOString().slice(0, 10) === at);
export interface CoordinationContext {
  items: SourceItem[];
  current_item_ids: string[];
  tasks: Record<string, { revision: number }>;
  people: string[];
  now: string;
  person_names?: Record<string, string | null>;
}
/** Validate references against exactly the source window supplied to the model. */
export function validateCoordination(raw: unknown, ctx: CoordinationContext): CoordinationPlan {
  const p = CoordinationPlan.parse(raw),
    items = new Map(ctx.items.map((i) => [i.item_id, i])),
    keys = new Set<string>(),
    people = new Set(ctx.people);
  const refs = (ids: string[]) => {
    requireRule(ids.length > 0, 'coordination_evidence_required');
    for (const id of ids) requireRule(items.has(id), 'coordination_unknown_source_item');
  };
  const person = (id: string | null) => {
    if (id) requireRule(people.has(id), 'coordination_unknown_person');
  };
  for (const t of p.tasks) {
    requireRule(t.key.length > 0 && !keys.has(t.key), 'coordination_duplicate_task_key');
    keys.add(t.key);
    refs(t.source_item_ids);
    if (t.internal_task_id) {
      requireRule(ctx.tasks[t.internal_task_id], 'coordination_unknown_internal_task');
      requireRule(
        t.expected_revision === ctx.tasks[t.internal_task_id].revision,
        'coordination_stale_revision',
      );
    } else requireRule(t.expected_revision === null, 'coordination_new_task_revision');
    person(t.primary_owner_key);
    person(t.acceptance.qa_owner_key);
    t.collaborator_keys.forEach(person);
    if (t.primary_owner_key) {
      const e = t.owner_evidence;
      requireRule(e && t.source_item_ids.includes(e.item_id), 'coordination_owner_evidence_required');
      const i = items.get(e.item_id)!;
      requireRule(Boolean(e.quote.trim()) && i.text.includes(e.quote), 'coordination_owner_quote_unbound');
      const mentioned = unique(
          i.mentions.filter((m) => e.quote.includes(m.name) || e.quote.includes(m.id)).map((m) => m.id),
        ),
        name = ctx.person_names?.[t.primary_owner_key];
      const ownerClause = e.quote.split(/强依赖|依赖|等待/u)[0],
        clausePeople = unique(
          i.mentions
            .filter((m) => ownerClause.includes(m.name) || ownerClause.includes(m.id))
            .map((m) => m.id),
        );
      const separatedDependency =
        ownerClause !== e.quote &&
        clausePeople.length === 1 &&
        clausePeople[0] === t.primary_owner_key &&
        mentioned
          .filter((id) => id !== t.primary_owner_key)
          .every((id) =>
            t.dependencies.some((d) => d.provider_owner_key === id && d.source_item_ids.includes(i.item_id)),
          );
      requireRule(
        (mentioned.length === 1 && mentioned[0] === t.primary_owner_key) ||
          separatedDependency ||
          (i.sender_id === t.primary_owner_key &&
            (/我(?!们)/u.test(e.quote) || Boolean(name && e.quote.includes(name)))) ||
          (mentioned.length === 0 && Boolean(name && e.quote.includes(name))),
        'coordination_owner_subject_unbound',
      );
    }
    const text = t.source_item_ids.map((id) => items.get(id)!.text).join('\n');
    for (const v of t.acceptance.versions)
      requireRule(
        v.component.trim() && v.version.trim() && text.includes(v.version),
        'coordination_version_unbound',
      );
    if (t.target_at) requireRule(targetDate(t.target_at), 'coordination_invalid_target_date');
    const dependencies = new Set<string>();
    for (const d of t.dependencies) {
      requireRule(d.key.trim() && !dependencies.has(d.key), 'coordination_duplicate_dependency');
      dependencies.add(d.key);
      refs(d.source_item_ids);
      person(d.provider_owner_key);
      if (d.expected_version)
        requireRule(
          d.source_item_ids.some((id) => items.get(id)!.text.includes(d.expected_version!)),
          'coordination_dependency_version_unbound',
        );
    }
  }
  const resolve = (id: string) => keys.has(id) || Boolean(ctx.tasks[id]);
  for (const t of p.tasks)
    for (const d of t.dependencies)
      if (d.kind === 'task') requireRule(resolve(d.target_ref), 'coordination_dependency_task_unknown');
  const classified = new Set<string>();
  for (const d of p.dispositions) {
    refs([d.item_id]);
    requireRule(d.category !== 'unclassified' && d.reason.trim(), 'coordination_classification_required');
    requireRule(!classified.has(d.item_id), 'coordination_duplicate_disposition');
    classified.add(d.item_id);
    d.task_keys.forEach((k) => requireRule(resolve(k), 'coordination_disposition_task_unknown'));
    if (['issue', 'requirement', 'asset', 'needs_clarification'].includes(d.category))
      requireRule(d.task_keys.length > 0, 'coordination_work_without_task');
    if (d.category === 'duplicate')
      requireRule(
        d.related_item_id && d.related_item_id !== d.item_id && items.has(d.related_item_id),
        'coordination_duplicate_target_missing',
      );
    for (const ref of d.resource_refs)
      requireRule(ref.trim() && items.get(d.item_id)!.text.includes(ref), 'coordination_resource_unbound');
  }
  requireRule(
    ctx.current_item_ids.every((id) => classified.has(id)),
    'coordination_source_coverage_incomplete',
  );
  for (const r of p.reports) {
    refs([r.source_item_id]);
    requireRule(ctx.tasks[r.internal_task_id], 'coordination_unknown_internal_task');
    requireRule(
      ctx.tasks[r.internal_task_id].revision === r.expected_revision,
      'coordination_stale_revision',
    );
  }
  for (const r of p.reminders) {
    refs(r.source_item_ids);
    requireRule(r.key.trim() && r.reason.trim(), 'coordination_reminder_reason_required');
    if (r.task_key) requireRule(resolve(r.task_key), 'coordination_reminder_task_unknown');
    requireRule(
      r.expected_task_revision ===
        (r.task_key && ctx.tasks[r.task_key] ? ctx.tasks[r.task_key].revision : null),
      'coordination_reminder_stale_revision',
    );
    if (r.action === 'set')
      requireRule(
        r.at &&
          date(r.at) &&
          Date.parse(r.at) > Date.parse(ctx.now) &&
          Date.parse(r.at) - Date.parse(ctx.now) <= 7 * 86400000,
        'coordination_reminder_time_invalid',
      );
    else
      requireRule(
        r.at === null &&
          r.source_item_ids.some(
            (id) =>
              p.dispositions.some((d) => d.item_id === id && d.category === 'decision') ||
              p.reports.some(
                (x) => x.source_item_id === id && ['deferred', 'cancelled', 'decision'].includes(x.kind),
              ),
          ),
        'coordination_reminder_cancel_evidence_required',
      );
  }
  return p;
}

export function applyCoordination(s: Ledger, c: Command, policy: Policy) {
  ensureCoordinationState(s);
  for (const [id, revision] of Object.entries(c.payload.expected_source_revisions ?? {}))
    requireRule(s.source_items[id]?.revision === revision, 'coordination_stale_source_revision');
  const p = validateCoordination(c.payload.coordination, {
    items: Object.values(s.source_items),
    current_item_ids: c.payload.current_item_ids ?? [],
    tasks: s.tasks,
    people: Object.keys(policy.identities),
    person_names: c.payload.person_names ?? {},
    now: c.occurred_at,
  });
  const note = (reason: string, target?: string) =>
    s.audit.push({ event_id: c.event_id, type: 'coordination', reason, target, at: c.occurred_at });
  const taskMap = new Map<string, string>(),
    created: string[] = [];
  // Reserve local task keys before applying dependencies, allowing edges within this batch.
  for (const change of p.tasks) {
    if (change.internal_task_id) {
      taskMap.set(change.key, change.internal_task_id);
      continue;
    }
    requireRule(
      change.source_item_ids.every((id) => !s.source_items[id].task_ids.length),
      'coordination_item_already_linked_use_internal_id',
    );
    let n = Object.keys(s.tasks).length + 1;
    while (s.tasks[`TASK-${String(n).padStart(5, '0')}`]) n++;
    const intake = s.issues[c.payload.issue_id],
      firstItem = s.source_items[change.source_item_ids[0]];
    const intakeMatches = intake?.case_ids.some((id) =>
      s.cases[id]?.source_event_ids.includes(firstItem.event_id),
    );
    const id = `TASK-${String(n).padStart(5, '0')}`,
      issueId = intakeMatches ? intake.issue_id : stableId('issue', change.source_item_ids[0]);
    s.issues[issueId] ??= newIssue(issueId, s.project_id);
    s.tasks[id] = newTask(id, issueId, s.project_id);
    s.issues[issueId].task_ids.push(id);
    taskMap.set(change.key, id);
    created.push(id);
  }
  const resolve = (key: string) => taskMap.get(key) ?? key;
  // Every classified work item has its own case; grouping tasks never loses numbered feedback.
  for (const d of p.dispositions) {
    const item = s.source_items[d.item_id],
      ids = unique(d.task_keys.map(resolve));
    item.category = d.category;
    item.classification_reason = d.reason;
    item.task_ids = unique([...item.task_ids, ...ids]);
    item.related_item_id = d.related_item_id;
    if (['issue', 'requirement', 'asset', 'needs_clarification'].includes(d.category)) {
      const id = stableId('case', item.item_id),
        previous = s.cases[id];
      const observation = {
        source_item_id: item.item_id,
        source_event_id: item.event_id,
        source_revision: item.revision,
        text: item.text,
        expected: d.expected_behavior,
        actual: d.observed_behavior,
      };
      s.cases[id] = {
        case_id: id,
        project_id: s.project_id,
        source_event_ids: unique([...(previous?.source_event_ids ?? []), item.event_id]),
        feedback_ref: null,
        conversation_ref: item.source_id,
        run_refs: previous?.run_refs ?? [],
        resource_refs: unique([...(previous?.resource_refs ?? []), ...d.resource_refs]),
        reported_expectation: d.expected_behavior ?? previous?.reported_expectation ?? null,
        observed_behavior: d.observed_behavior ?? previous?.observed_behavior ?? item.text,
        environment: previous?.environment ?? null,
        version_refs: previous?.version_refs ?? {},
        evidence_completeness: 'partial',
        created_at: previous?.created_at ?? item.at,
        observations: [
          ...(previous?.observations ?? []).filter(
            (x) => !(x.source_revision === item.revision && x.source_item_id === item.item_id),
          ),
          observation,
        ],
      };
      for (const taskId of ids) {
        const t = s.tasks[taskId],
          issue = s.issues[t.issue_id];
        issue.case_ids = unique([...issue.case_ids, id]);
        if (issue.problem_statement === '待整理原始证据') {
          issue.problem_statement = item.text;
          issue.title = item.text.slice(0, 80);
          issue.expected_behavior = d.expected_behavior ?? '待明确';
        }
      }
    }
  }
  for (const change of p.tasks) {
    const t = s.tasks[resolve(change.key)],
      fresh = created.includes(t.task_id);
    t.source_item_ids ??= [];
    t.external_refs ??= [];
    t.observed_progress ??= [];
    const sourceItems = change.source_item_ids.map((id) => s.source_items[id]);
    t.source_item_ids = unique([...t.source_item_ids, ...change.source_item_ids]);
    t.external_refs = unique([...t.external_refs, ...sourceItems.flatMap((i) => i.external_refs)]);
    t.evidence_refs = unique([...t.evidence_refs, ...sourceItems.map((i) => i.event_id)]);
    for (const item of sourceItems) item.task_ids = unique([...item.task_ids, t.task_id]);
    const protectedTask =
      !fresh &&
      (Boolean(t.last_human_at) ||
        ['verified', 'cancelled', 'deferred'].includes(t.state) ||
        Boolean(t.assignment_id && s.assignments[t.assignment_id]?.status === 'accepted'));
    if (protectedTask) {
      note('scope_update_requires_human_confirmation', t.task_id);
      continue;
    }
    const before = JSON.stringify(t);
    t.kind = change.kind;
    t.title = change.title;
    t.objective = change.objective;
    t.deliverable = change.deliverable;
    const owner = change.primary_owner_key;
    if (owner && !t.primary_owner_key && policy.identities[owner]?.verified) {
      t.primary_owner_key = owner;
      t.state = 'pending_acceptance';
    } else if (owner && t.primary_owner_key !== owner)
      note('owner_change_requires_scoped_command', t.task_id);
    t.collaborator_keys = unique([...t.collaborator_keys, ...change.collaborator_keys]);
    const a = change.acceptance,
      old = t.acceptance_spec;
    const cases = change.source_item_ids.map((id) => stableId('case', id)).filter((id) => s.cases[id]);
    t.acceptance_spec = {
      expected_behavior: a.expected_behavior ?? old.expected_behavior,
      case_ids: unique([...old.case_ids, ...cases]),
      environment: a.environment ?? old.environment,
      version_requirements: {
        ...old.version_requirements,
        ...Object.fromEntries(a.versions.map((v) => [v.component, v.version])),
      },
      scope: {
        description: a.scope_description ?? old.scope.description,
        validation: a.scope_description ? a.validation : old.scope.validation,
      },
      qa_owner_key: old.qa_owner_key ?? a.qa_owner_key,
      required_evidence_types: unique([
        ...old.required_evidence_types,
        ...a.required_evidence_types,
        'human_qa',
      ]),
    };
    t.qa_owner_key = t.acceptance_spec.qa_owner_key;
    if (change.target_at) {
      t.schedule.target_at = change.target_at;
      t.schedule.source_ref = sourceItems[0].event_id;
      t.schedule.updated_at = c.occurred_at;
    }
    for (const dep of change.dependencies) {
      const id = stableId('dep', `${t.task_id}:${dep.key}`),
        old = t.dependencies.find((d) => d.dependency_id === id),
        target = dep.kind === 'task' ? resolve(dep.target_ref) : dep.target_ref;
      const same =
        old?.target_ref === target &&
        old.required_condition === dep.required_condition &&
        old.expected_version === dep.expected_version;
      const next = {
        dependency_id: id,
        kind: dep.kind,
        target_ref: target,
        required_condition: dep.required_condition,
        expected_version: dep.expected_version,
        provider_owner_key: dep.provider_owner_key,
        status: same ? old!.status : ('waiting' as const),
        observed_at: same ? old!.observed_at : null,
        source_ref: s.source_items[dep.source_item_ids[0]].event_id,
      };
      t.dependencies = t.dependencies.filter((d) => d.dependency_id !== id);
      t.dependencies.push(next);
    }
    t.external_record = { platform: 'agent_ledger', record_id: t.task_id, synthetic: policy.mode === 'mock' };
    if (!fresh && JSON.stringify(t) !== before) t.revision++;
    note(fresh ? 'task_registered' : 'task_fields_updated', t.task_id);
  }
  for (const r of p.reports) {
    const t = s.tasks[r.internal_task_id];
    t.observed_progress ??= [];
    const i = s.source_items[r.source_item_id];
    if (
      !t.observed_progress.some(
        (x) =>
          x.source_item_id === r.source_item_id &&
          x.at === i.at &&
          x.kind === r.kind &&
          x.summary === r.summary,
      )
    )
      t.observed_progress.push({
        kind: r.kind,
        summary: r.summary,
        scope: r.scope,
        source_item_id: r.source_item_id,
        at: i.at,
      });
  }
  for (const change of p.reminders) {
    const id = change.key,
      old = s.reminders[id];
    const taskId = change.task_key ? resolve(change.task_key) : null,
      t = taskId ? s.tasks[taskId] : null;
    if (old) requireRule(old.task_id === taskId, 'coordination_reminder_binding_mismatch');
    if (change.action === 'cancel') {
      requireRule(old, 'coordination_reminder_missing');
      if (taskId)
        requireRule(
          change.source_item_ids.some(
            (item) =>
              p.dispositions.some(
                (d) =>
                  d.item_id === item &&
                  d.category === 'decision' &&
                  d.task_keys.some((k) => resolve(k) === taskId),
              ) ||
              p.reports.some(
                (r) =>
                  r.source_item_id === item &&
                  r.internal_task_id === taskId &&
                  ['cancelled', 'deferred', 'decision'].includes(r.kind),
              ),
          ),
          'coordination_reminder_cancel_scope_unbound',
        );
      old.state = 'cancelled';
      old.updated_at = c.occurred_at;
      old.cancel_reason = change.reason;
      continue;
    }
    requireRule(
      !t || !['verified', 'cancelled', 'deferred'].includes(t.state),
      'coordination_reminder_inactive_task',
    );
    s.reminders[id] = {
      reminder_id: id,
      task_id: taskId,
      task_revision: t?.revision ?? null,
      at: change.at!,
      reason: change.reason,
      source_item_ids: change.source_item_ids,
      state: 'pending',
      created_at: old?.created_at ?? c.occurred_at,
      updated_at: c.occurred_at,
    };
  }
  return created;
}
