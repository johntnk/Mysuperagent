import { emptyLedger, type Ledger, type Command } from '../src/domain/contracts';
import { reduce } from '../src/domain/engine';
import { localPolicy } from '../src/policy';
import type { CoordinationPlan } from '../src/domain/coordination-schema';
export const at = '2030-01-07T02:00:00.000Z';
export const policy = () => ({
  ...localPolicy(),
  identities: Object.fromEntries(
    ['owner', 'qa', 'provider', 'coordinator'].map((id) => [id, { id, verified: true, synthetic: true }]),
  ),
});
export const cmd = (
  id: string,
  event_type: string,
  payload: any,
  actor_key = 'system',
  occurred_at = at,
): Command => ({ event_id: id, event_type, actor_key, occurred_at, payload });
export const source = (text: string, id = 'source', revision = 'r1', time = at): Command => ({
  ...cmd(
    id,
    'source_message_observed',
    {
      text,
      mentions: [
        { id: 'owner', name: '开发' },
        { id: 'provider', name: '资源' },
      ],
    },
    'coordinator',
    time,
  ),
  source_event_id: id,
  source_revision: revision,
});
export function seed(text = '开发负责修复转圈次数；测试 lab，版本 release_2，等待移动 SSML。') {
  const p = policy(),
    s = reduce(emptyLedger(p.project_id), source(text), p),
    item = Object.values(s.source_items)[0];
  const plan: CoordinationPlan = {
    dispositions: [
      {
        item_id: item.item_id,
        category: 'issue',
        task_keys: ['work'],
        related_item_id: null,
        reason: '数量缺陷',
        expected_behavior: '转三圈',
        observed_behavior: '只转一圈',
        resource_refs: [],
      },
    ],
    tasks: [
      {
        key: 'work',
        internal_task_id: null,
        expected_revision: null,
        kind: 'implementation',
        title: '修复转圈次数',
        objective: '保留次数',
        deliverable: '修改、版本及原用例回归材料',
        source_item_ids: [item.item_id],
        primary_owner_key: 'owner',
        owner_evidence: { item_id: item.item_id, quote: '开发负责修复转圈次数' },
        collaborator_keys: [],
        acceptance: {
          expected_behavior: '转三圈',
          environment: 'lab',
          versions: [{ component: 'service', version: 'release_2' }],
          scope_description: '原用例完整动作',
          validation: 'all',
          qa_owner_key: 'qa',
          required_evidence_types: ['human_qa'],
        },
        dependencies: [
          {
            key: 'mobile',
            kind: 'artifact',
            target_ref: '移动 SSML',
            required_condition: '可用移动 SSML',
            expected_version: null,
            provider_owner_key: 'provider',
            source_item_ids: [item.item_id],
          },
        ],
        target_at: null,
      },
    ],
    reports: [],
    reminders: [],
  };
  return { s, p, plan, item };
}
export const submit = (s: Ledger, plan: CoordinationPlan, id = 'analysis', extra: any = {}) =>
  reduce(
    s,
    cmd(id, 'analysis_completed', {
      coordination: plan,
      notify: false,
      current_item_ids: Object.values(s.source_items)
        .filter((i) => i.event_id === 'source')
        .map((i) => i.item_id),
      ...extra,
    }),
    policy(),
  );
export const emptyPlan = (): CoordinationPlan => ({
  dispositions: [],
  tasks: [],
  reports: [],
  reminders: [],
});
