import { Mode, type Effect, type Task } from './domain/contracts';
export interface Policy {
  mode: Mode;
  transport: 'fake' | 'real';
  environment: 'local' | 'test' | 'production';
  project_id: string;
  targets: string[];
  capabilities: string[];
  identities: Record<string, { id: string; verified: boolean; synthetic: boolean }>;
  decision_owners: string[];
  notifications: {
    enabled: boolean;
    confirmed: boolean;
    timezone: string;
    start: string;
    end: string;
    days: number[];
    cooldown_minutes: number;
    max_per_day: number;
  };
  task_backend: 'agent_ledger' | 'feishu_project';
  /** Text command prefix shown in hints, e.g. `/agent`. */
  command_prefix: string;
}
export const localPolicy = (project_id = 'demo-project'): Policy => ({
  mode: 'mock',
  transport: 'fake',
  environment: 'local',
  project_id,
  targets: [],
  capabilities: [],
  identities: {},
  decision_owners: ['coordinator'],
  task_backend: 'agent_ledger',
  command_prefix: '/agent',
  notifications: {
    enabled: true,
    confirmed: true,
    timezone: 'Asia/Shanghai',
    start: '09:00',
    end: '22:00',
    days: [1, 2, 3, 4, 5],
    cooldown_minutes: 120,
    max_per_day: 2,
  },
});
export const allowedCapabilities = [
  'work_item.create',
  'work_item.update',
  'work_item.comment',
  'message.send',
  'message.reply',
  'message.update',
  'evidence.read',
  'resource_status.read',
];
export function effectBlock(p: Policy, e: Effect, t?: Task): string | null {
  if (!allowedCapabilities.includes(e.capability)) return 'capability_not_in_v1';
  if (e.planned_mode !== p.mode) return 'planned_mode_changed';
  const requestedNotice = e.request.purpose === 'command_receipt';
  const completionNotice = (t?.state === 'verified' && e.request.purpose === 'qa_result') || requestedNotice;
  if (
    t &&
    (t.revision !== e.expected_revision ||
      (['cancelled', 'deferred', 'verified'].includes(t.state) &&
        e.capability.startsWith('message') &&
        !completionNotice))
  )
    return 'stale_revision_or_state';
  // Messages about a task go to the people on it. Coordinators are always reachable: they receive
  // declined tasks, missing acceptance criteria and other decisions that nobody on the task can make.
  if (
    t &&
    e.target_owner_key &&
    t.primary_owner_key !== e.target_owner_key &&
    t.qa_owner_key !== e.target_owner_key &&
    !t.dependencies.some((d) => d.provider_owner_key === e.target_owner_key) &&
    !p.decision_owners.includes(e.target_owner_key) &&
    !requestedNotice
  )
    return 'assignment_changed';
  if (p.transport === 'fake' && p.mode === 'mock') return null;
  if (p.mode === 'mock') return 'mock_real_transport_forbidden';
  if (p.mode === 'observe' && !['evidence.read', 'resource_status.read'].includes(e.capability))
    return 'observe_read_only';
  if (p.mode === 'pilot' && p.environment !== 'test') return 'pilot_requires_test';
  if (!p.targets.includes(e.target)) return 'target_not_allowlisted';
  if (!p.capabilities.includes(e.capability)) return 'capability_disabled';
  if (e.capability.startsWith('message') || e.capability.startsWith('work_item')) {
    const i = e.target_owner_key ? p.identities[e.target_owner_key] : null;
    if (
      !i?.verified ||
      !i.id ||
      (p.transport === 'real' && (i.synthetic || /^(fake|example|placeholder)/i.test(i.id)))
    )
      return 'identity_unbound';
    if (e.capability.startsWith('message') && (!p.notifications.enabled || !p.notifications.confirmed))
      return 'notifications_disabled';
  }
  return null;
}
export function inWorkWindow(at: string, p: Policy) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: p.notifications.timezone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(at));
  const get = (type: string) => parts.find((x) => x.type === type)?.value || '';
  const day = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(get('weekday')) + 1;
  const time = `${get('hour')}:${get('minute')}`;
  return p.notifications.days.includes(day) && time >= p.notifications.start && time < p.notifications.end;
}
