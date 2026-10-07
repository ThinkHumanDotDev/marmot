import type { CollectionConfig, CollectionSlug } from 'payload'

import { auditCollection, type AuditCollectionOptions } from '@/server/audit/collection-hooks'
import { getNotificationProvider } from '@/server/notification-providers'

/**
 * Audit coverage of every collection, in one place. Each organization-scoped collection is either
 * audited (`AUDITED`, which adds `afterChange`/`afterDelete` hooks writing `<entity>.created|
 * updated|deleted` rows, see `src/server/audit/collection-hooks.ts`) or deliberately excluded
 * (`NOT_AUDITED`, with the reason). `tests/int/audit-log.int.spec.ts` fails when a new collection
 * is in neither list.
 */
export const AUDITED: Partial<Record<CollectionSlug, AuditCollectionOptions>> = {
  monitors: {
    entityType: 'monitor',
    // Status cache, certificate and domain lookups are refreshed by the worker after checks.
    ignore: ['status', 'certInfo', 'domainExpiry'],
    toggle: { field: 'active', on: 'monitor.resumed', off: 'monitor.paused' },
  },
  notifications: {
    entityType: 'notification',
    ignore: ['lastSentAt', 'lastError'],
    toggle: { field: 'active', on: 'notification.enabled', off: 'notification.disabled' },
    secretKeys: (doc) => {
      const provider = typeof doc.type === 'string' ? getNotificationProvider(doc.type) : undefined
      return Object.entries(provider?.fieldMeta ?? {})
        .filter(([, meta]) => meta.secret)
        .map(([key]) => key)
    },
  },
  tags: { entityType: 'tag' },
  proxies: {
    entityType: 'proxy',
    label: (doc) => (typeof doc.host === 'string' ? `${doc.host}:${String(doc.port ?? '')}` : null),
  },
  'docker-hosts': { entityType: 'docker_host' },
  'status-pages': { entityType: 'status_page' },
  'status-page-viewers': {
    entityType: 'status_page_viewer',
    ignore: ['lastSeenAt'],
    // Viewers sign themselves in through magic links; only changes made by members are audited.
    systemWrites: false,
  },
  incidents: { entityType: 'incident' },
  'status-page-subscribers': {
    entityType: 'subscriber',
    label: (doc) => (typeof doc.target === 'string' ? doc.target : null),
    ignore: ['verification', 'delivery', 'lastDeliveredAt', 'lastError'],
    // Self sign-ups, confirmations and unsubscribes by visitors are not audited.
    systemWrites: false,
  },
  'subscriber-notifications': {
    entityType: 'subscriber_notification',
    // Created by incident and maintenance events and advanced by the sender; members approve,
    // discard and retry them.
    operations: ['update', 'delete'],
    systemWrites: false,
    ignore: ['delivery', 'recipientCount', 'sendingStartedAt', 'completedAt'],
  },
  maintenance: {
    entityType: 'maintenance',
    // `status` follows the schedule (worker); `active` is the pause switch.
    ignore: ['status'],
    toggle: { field: 'active', on: 'maintenance.resumed', off: 'maintenance.paused' },
  },
  templates: { entityType: 'template' },
  'api-keys': {
    entityType: 'api_key',
    ignore: ['lastUsedAt'],
    toggle: { field: 'active', on: 'api_key.enabled', off: 'api_key.disabled' },
    deleteAction: 'api_key.revoked',
  },
  'webhook-endpoints': {
    entityType: 'webhook_endpoint',
    label: (doc) => (typeof doc.url === 'string' ? doc.url : null),
    // Delivery bookkeeping of the worker; disabling is recorded through the `active` toggle.
    ignore: [
      'consecutiveFailures',
      'lastDeliveryAt',
      'lastDeliveryState',
      'disabledReason',
      'disabledAt',
      'previousSecretExpiresAt',
    ],
    toggle: { field: 'active', on: 'webhook_endpoint.enabled', off: 'webhook_endpoint.disabled' },
  },
  'sso-connections': { entityType: 'sso_connection' },
  'sso-domains': { entityType: 'sso_domain' },
  invitations: { entityType: 'invitation' },
  organizations: {
    entityType: 'organization',
    // Billing identifiers are synchronised with Stripe, not edited by people.
    ignore: ['stripeCustomerId', 'stripeSubscriptionId'],
    // A deleted organization cannot be referenced; its row is instance-level (superadmins).
    organization: (doc, operation) =>
      operation === 'delete' ? null : ((doc.id as string | number | undefined) ?? null),
  },
}

/** Collections without audit hooks, and why. */
export const NOT_AUDITED: Partial<Record<CollectionSlug, string>> = {
  users: 'account changes are audited as auth.* events; memberships as member.* events',
  'auth-accounts': 'linked sign-in identities of a user, not organization resources',
  media: 'uploads are audited through the status page or organization that references them',
  heartbeats: 'high-volume monitoring data',
  'stat-minutely': 'high-volume rollups',
  'stat-hourly': 'high-volume rollups',
  'stat-daily': 'high-volume rollups',
  'notification-sent-history': 'delivery log',
  'subscriber-deliveries': 'delivery log',
  'webhook-deliveries': 'delivery log',
  'maintenance-occurrences':
    'generated from the maintenance schedule; posted updates are audited as maintenance_occurrence.updated',
  'monitor-incidents':
    'opened and resolved by the engine; member actions are audited as monitor_incident.acknowledged|resolved|published',
  'push-events': 'push monitor signal log (high volume)',
  'audit-logs': 'the audit log itself',
}

/** Adds the audit hooks of `AUDITED` to a collection config (after its own hooks). */
export function withAuditHooks(collection: CollectionConfig): CollectionConfig {
  const options = AUDITED[collection.slug as CollectionSlug]
  if (!options) return collection
  const hooks = auditCollection(options)
  return {
    ...collection,
    hooks: {
      ...collection.hooks,
      afterChange: [...(collection.hooks?.afterChange ?? []), hooks.afterChange],
      afterDelete: [...(collection.hooks?.afterDelete ?? []), hooks.afterDelete],
    },
  }
}
