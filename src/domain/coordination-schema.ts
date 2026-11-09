import { z } from 'zod';

export const ItemCategory = z.enum([
  'unclassified',
  'issue',
  'requirement',
  'asset',
  'decision',
  'context',
  'duplicate',
  'needs_clarification',
]);
export const ProgressKind = z.enum([
  'requested',
  'acknowledged',
  'accepted',
  'in_progress',
  'blocked',
  'delivery_claimed',
  'qa_claimed',
  'deferred',
  'cancelled',
  'decision',
]);
export const CoordinationPlan = z.strictObject({
  dispositions: z.array(
    z.strictObject({
      item_id: z.string(),
      category: ItemCategory,
      task_keys: z.array(z.string()),
      related_item_id: z.string().nullable(),
      reason: z.string(),
      expected_behavior: z.string().nullable(),
      observed_behavior: z.string().nullable(),
      resource_refs: z.array(z.string()),
    }),
  ),
  tasks: z.array(
    z.strictObject({
      key: z.string(),
      internal_task_id: z.string().nullable(),
      expected_revision: z.number().int().nullable(),
      kind: z.enum(['diagnosis', 'implementation', 'verification', 'decision']),
      title: z.string(),
      objective: z.string(),
      deliverable: z.string(),
      source_item_ids: z.array(z.string()),
      primary_owner_key: z.string().nullable(),
      owner_evidence: z.strictObject({ item_id: z.string(), quote: z.string() }).nullable(),
      collaborator_keys: z.array(z.string()),
      acceptance: z.strictObject({
        expected_behavior: z.string().nullable(),
        environment: z.string().nullable(),
        versions: z.array(z.strictObject({ component: z.string(), version: z.string() })),
        scope_description: z.string().nullable(),
        validation: z.enum(['all', 'sample']),
        qa_owner_key: z.string().nullable(),
        required_evidence_types: z.array(z.string()),
      }),
      dependencies: z.array(
        z.strictObject({
          key: z.string(),
          kind: z.enum(['task', 'job', 'artifact', 'deployment', 'decision']),
          target_ref: z.string(),
          required_condition: z.string(),
          expected_version: z.string().nullable(),
          provider_owner_key: z.string().nullable(),
          source_item_ids: z.array(z.string()),
        }),
      ),
      target_at: z.string().nullable(),
    }),
  ),
  reports: z.array(
    z.strictObject({
      internal_task_id: z.string(),
      expected_revision: z.number().int(),
      source_item_id: z.string(),
      kind: ProgressKind,
      summary: z.string(),
      scope: z.string(),
    }),
  ),
  reminders: z.array(
    z.strictObject({
      action: z.enum(['set', 'cancel']),
      key: z.string(),
      task_key: z.string().nullable(),
      expected_task_revision: z.number().int().nullable(),
      at: z.string().nullable(),
      reason: z.string(),
      source_item_ids: z.array(z.string()),
    }),
  ),
});
export type CoordinationPlan = z.infer<typeof CoordinationPlan>;
export interface SourceItem {
  item_id: string;
  source_id: string;
  label: string;
  text: string;
  event_id: string;
  revision: string;
  at: string;
  sender_id: string | null;
  mentions: { id: string; name: string }[];
  external_refs: string[];
  category: z.infer<typeof ItemCategory>;
  task_ids: string[];
  related_item_id: string | null;
  classification_reason: string | null;
  observations: { event_id: string; revision: string; at: string; text: string }[];
}
export interface Reminder {
  reminder_id: string;
  task_id: string | null;
  task_revision: number | null;
  at: string;
  reason: string;
  source_item_ids: string[];
  state: 'pending' | 'fired' | 'cancelled';
  created_at: string;
  updated_at: string;
  cancel_reason?: string;
}
export interface ObservedProgress {
  kind: z.infer<typeof ProgressKind>;
  summary: string;
  scope: string;
  source_item_id: string;
  at: string;
}
export const COORDINATION_INSTRUCTIONS = `将是否保存工作与是否发言分别判断：即使沉默也需要记录明确工作、历史交付和决定。使用 coordination 完成结构化更新，使用它时旧 proposed_task_changes/dependency_changes 留空。
current_source_items 是服务端从当前消息拆出的原始事项。dispositions 必须逐一覆盖这些 item_id，不能合并遗漏；缺陷、需求、资产工作或待澄清事项必须通过 task_keys 对应任务，可多条归入同一任务。讨论/链接可以记 context；版本决定记 decision。重复项须给出已有 related_item_id。已有飞书任务链接不表示本 Agent 已跟踪，仍需登记内部工作，链接由系统作为关联材料保留。
tasks 中新任务 internal_task_id=null、expected_revision=null，key 是本次局部键；已有任务使用给出的真实内部编号及 revision。不要把 URL 中的外部编号放入内部编号。source_item_ids/报告/依赖/提醒只能引用输入给出的 source_items。只在有新增工作或字段变化时列 tasks；避免改写无关任务或仅为措辞不同重复修订。
主责不明确为 null；多人被共同列名却没区分主责时也为 null。有主责时 owner_evidence 必须逐字引用明确对应该人的原文，不能借用另一条事项的提及。未知昵称只能作为待确认身份，不猜成已绑定人。提问者不自动是修复人。只填写有证据的版本、日期和资源标识；其他字段保留 null 并说明缺项。验收包含预期表现、原用例、版本、环境与范围；不要编造测试结果。
target_at 只记录有来源的目标时间：只说日期就填 YYYY-MM-DD，不编造几点；明确时刻才填带时区的 ISO 时间。这不代表负责人承诺的期限，也不会自动触发提醒。
dependencies 列出仍需交付的条件、提供者及版本；“可以加”“收到”不能证明依赖已满足。reports 记录原聊天中的接手/交付/验收声明及范围，不冒充对 Agent 模拟话术的回应，也不直接正式关闭任务。
pending_reminders 是当前计划；reminders=[] 表示保持。新增/改期用 set，取消用 cancel 并提供对应决定/进度证据。无关消息不能取消已有提醒。提醒关联 task_key 或已有内部任务编号；关联已有任务时 expected_task_revision 填当前 revision，新任务局部键或全局检查填 null。无需新增提醒时不要重复设置。`;
