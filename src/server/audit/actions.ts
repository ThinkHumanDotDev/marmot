/**
 * Vocabulary of the audit log: who acts (`AUDIT_ACTOR_TYPES`), on what (`AUDIT_ENTITY_TYPES`) and
 * how (`AUDIT_ACTIONS`, dotted `<entity>.<verb>`). Kept free of server imports so the settings UI can
 * build its filters from the same lists.
 */

export const AUDIT_ACTOR_TYPES = ['user', 'apiKey', 'mcp', 'system'] as const
export type AuditActorType = (typeof AUDIT_ACTOR_TYPES)[number]

/** Resources whose collection hooks write `<entity>.created|updated|deleted`. */
export const AUDIT_RESOURCE_TYPES = [
  'monitor',
  'notification',
  'tag',
  'proxy',
  'docker_host',
  'status_page',
  'status_page_viewer',
  'incident',
  'subscriber',
  'subscriber_notification',
  'maintenance',
  'template',
  'api_key',
  'sso_connection',
  'sso_domain',
  'invitation',
  'organization',
  'webhook_endpoint',
  'location',
  'otel_collector',
] as const
export type AuditResourceType = (typeof AUDIT_RESOURCE_TYPES)[number]

/** Every entity type a row can name (`entityType`). */
export const AUDIT_ENTITY_TYPES = [
  ...AUDIT_RESOURCE_TYPES,
  'maintenance_occurrence',
  'monitor_incident',
  'member',
  'user',
  'instance_settings',
  'import',
] as const
export type AuditEntityType = (typeof AUDIT_ENTITY_TYPES)[number]

const CRUD_VERBS = ['created', 'updated', 'deleted'] as const
type CrudVerb = (typeof CRUD_VERBS)[number]

/** Sign-in and account security events (instance-level unless an organization is known). */
export const AUTH_ACTIONS = [
  'auth.login',
  'auth.login_failed',
  'auth.rate_limited',
  'auth.forgot_password',
  'auth.password_changed',
  'auth.break_glass',
  'auth.two_factor_failed',
  'auth.two_factor_enabled',
  'auth.two_factor_disabled',
  'auth.backup_codes_regenerated',
  'auth.sso_login',
  'auth.sso_login_failed',
  'auth.sso_group_denied',
] as const

/** Verbs beyond create/update/delete, named after what the user did. */
export const SPECIAL_ACTIONS = [
  'monitor.paused',
  'monitor.resumed',
  'monitor.cloned',
  'maintenance.paused',
  'maintenance.resumed',
  'maintenance_occurrence.updated',
  'monitor_incident.acknowledged',
  'monitor_incident.resolved',
  'monitor_incident.published',
  'notification.enabled',
  'notification.disabled',
  'api_key.enabled',
  'api_key.disabled',
  'api_key.revoked',
  'webhook_endpoint.enabled',
  'webhook_endpoint.disabled',
  'otel_collector.enabled',
  'otel_collector.disabled',
  'location.token_rotated',
  'invitation.accepted',
  'member.role_changed',
  'member.removed',
  'member.ownership_transferred',
  'member.added',
  'member.sync_skipped',
  'user.superadmin_granted',
  'user.superadmin_revoked',
  'user.sync_skipped',
  'instance_settings.updated',
  'import.completed',
] as const

export type AuditAction =
  | (typeof AUTH_ACTIONS)[number]
  | (typeof SPECIAL_ACTIONS)[number]
  | `${AuditResourceType}.${CrudVerb}`

/**
 * Names of the events the audit log records. Dotted `<entity>.<verb>` so the list can be filtered
 * by prefix (`action: { like: 'member.' }`). Add new actions here so they stay discoverable.
 */
export const AUDIT_ACTIONS: readonly AuditAction[] = [
  ...AUTH_ACTIONS,
  ...AUDIT_RESOURCE_TYPES.flatMap((entity) =>
    CRUD_VERBS.map((verb) => `${entity}.${verb}` as AuditAction),
  ),
  ...SPECIAL_ACTIONS,
]

export const isAuditAction = (value: unknown): value is AuditAction =>
  typeof value === 'string' && (AUDIT_ACTIONS as readonly string[]).includes(value)

export const isAuditEntityType = (value: unknown): value is AuditEntityType =>
  typeof value === 'string' && (AUDIT_ENTITY_TYPES as readonly string[]).includes(value)

export const isAuditActorType = (value: unknown): value is AuditActorType =>
  typeof value === 'string' && (AUDIT_ACTOR_TYPES as readonly string[]).includes(value)

/** `monitor.paused` → `{ entity: 'monitor', verb: 'paused' }`. */
export function splitAction(action: string): { entity: string; verb: string } {
  const dot = action.indexOf('.')
  return dot < 0
    ? { entity: action, verb: '' }
    : { entity: action.slice(0, dot), verb: action.slice(dot + 1) }
}

/** Distinct verbs of `AUDIT_ACTIONS`, for the action filter. */
export const AUDIT_VERBS: readonly string[] = [
  ...new Set(AUDIT_ACTIONS.map((action) => splitAction(action).verb)),
]
