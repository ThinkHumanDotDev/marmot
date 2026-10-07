/**
 * Catalogue of outbound webhook events (#157). Kept free of server imports so the settings UI builds
 * its event picker from the same list the server validates against.
 *
 * Two kinds of events:
 * - **resource events**: the audit log's `<entity>.<verb>` actions (`monitor.created`,
 *   `member.role_changed`, …), published by the audit bus after the change committed;
 * - **lifecycle events** the audit log does not record: monitor state transitions from the engine
 *   (`monitor.down|up|degraded`), incident timeline entries (`incident.opened|update_posted|resolved|
 *   reopened`) and maintenance windows (`maintenance.scheduled|started|…`).
 *
 * Endpoints subscribe with exact types, a group wildcard (`incident.*`) or everything (`*`).
 */
import { AUDIT_ACTIONS, splitAction } from '@/server/audit/actions'

/** Subscribes to every event. */
export const WEBHOOK_WILDCARD = '*'

/** Sent by "Send test event"; always delivered, whatever the endpoint subscribes to. */
export const WEBHOOK_TEST_EVENT = 'webhook.test'

/** Engine and timeline events (not audit actions). */
export const WEBHOOK_LIFECYCLE_EVENTS = [
  'monitor.down',
  'monitor.up',
  'monitor.degraded',
  'incident.opened',
  'incident.update_posted',
  'incident.resolved',
  'incident.reopened',
  'maintenance.scheduled',
  'maintenance.reminder',
  'maintenance.started',
  'maintenance.update_posted',
  'maintenance.completed',
  'maintenance.cancelled',
] as const

/**
 * Audit actions that are not offered as webhook events: sign-ins and instance settings are not
 * organization events, a created or deleted organization has no endpoint to deliver to, and posted
 * maintenance updates are already `maintenance.update_posted`.
 */
const EXCLUDED_AUDIT_ACTIONS = new Set([
  'organization.created',
  'organization.deleted',
  'instance_settings.updated',
  'maintenance_occurrence.updated',
])

const isExcludedAuditAction = (action: string): boolean =>
  action.startsWith('auth.') || EXCLUDED_AUDIT_ACTIONS.has(action)

/** Audit actions published as webhook events. */
export const WEBHOOK_RESOURCE_EVENTS: readonly string[] = AUDIT_ACTIONS.filter(
  (action) => !isExcludedAuditAction(action),
)

/** Every event type an endpoint can subscribe to, lifecycle events first. */
export const WEBHOOK_EVENT_TYPES: readonly string[] = [
  ...WEBHOOK_LIFECYCLE_EVENTS,
  ...WEBHOOK_RESOURCE_EVENTS,
]

/** Whether an audit action is published to webhooks. */
export const isWebhookResourceEvent = (action: string): boolean =>
  (WEBHOOK_RESOURCE_EVENTS as readonly string[]).includes(action)

export interface WebhookEventGroup {
  /** Entity prefix (`monitor`, `incident`, …): the wildcard is `<group>.*`. */
  group: string
  events: string[]
}

/** Event types grouped by entity, in catalogue order (the settings UI's picker). */
export const WEBHOOK_EVENT_GROUPS: readonly WebhookEventGroup[] = (() => {
  const groups = new Map<string, string[]>()
  for (const type of WEBHOOK_EVENT_TYPES) {
    const { entity } = splitAction(type)
    const list = groups.get(entity) ?? []
    list.push(type)
    groups.set(entity, list)
  }
  return [...groups].map(([group, events]) => ({ group, events }))
})()

const GROUP_NAMES = new Set(WEBHOOK_EVENT_GROUPS.map((entry) => entry.group))

/** A valid subscription entry: `*`, `<group>.*` or a known event type. */
export function isWebhookEventSelector(value: unknown): value is string {
  if (typeof value !== 'string') return false
  if (value === WEBHOOK_WILDCARD) return true
  if (value.endsWith('.*')) return GROUP_NAMES.has(value.slice(0, -2))
  return WEBHOOK_EVENT_TYPES.includes(value)
}

/** Whether an endpoint subscribed to `selectors` receives events of `type`. */
export function webhookSubscribes(selectors: readonly unknown[] | null | undefined, type: string) {
  if (type === WEBHOOK_TEST_EVENT) return true
  for (const selector of selectors ?? []) {
    if (typeof selector !== 'string') continue
    if (selector === WEBHOOK_WILDCARD || selector === type) return true
    if (selector.endsWith('.*') && type.startsWith(selector.slice(0, -1))) return true
  }
  return false
}

/** Sorted, de-duplicated selectors; anything below a wildcard it is covered by is dropped. */
export function normalizeWebhookSelectors(selectors: readonly string[]): string[] {
  const unique = [...new Set(selectors.filter(isWebhookEventSelector))]
  if (unique.includes(WEBHOOK_WILDCARD)) return [WEBHOOK_WILDCARD]
  const groups = unique.filter((value) => value.endsWith('.*'))
  return unique
    .filter(
      (value) =>
        value.endsWith('.*') || !groups.some((group) => value.startsWith(group.slice(0, -1))),
    )
    .sort()
}
