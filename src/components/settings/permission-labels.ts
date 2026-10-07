/**
 * Message keys of the permission table's resource and action labels
 * (`settings.permissions.resources.*` / `settings.permissions.actions.*`). Every resource and action
 * of `PERMISSIONS` needs an entry; `src/i18n/settings.test.ts` checks that.
 */
export const PERMISSION_RESOURCE_KEYS = {
  organization: 'organization',
  member: 'member',
  monitor: 'monitor',
  'monitor-incident': 'monitorIncident',
  notification: 'notification',
  'status-page': 'statusPage',
  subscriber: 'subscriber',
  maintenance: 'maintenance',
  template: 'template',
  tag: 'tag',
  proxy: 'proxy',
  'docker-host': 'dockerHost',
  'api-key': 'apiKey',
  'audit-log': 'auditLog',
  webhook: 'webhook',
  sso: 'sso',
} as const

export const PERMISSION_ACTION_KEYS = {
  read: 'read',
  create: 'create',
  update: 'update',
  delete: 'delete',
  invite: 'invite',
  remove: 'remove',
  'update-role': 'updateRole',
  manage: 'manage',
  send: 'send',
  acknowledge: 'acknowledge',
  resolve: 'resolve',
} as const

export type PermissionResourceKey =
  (typeof PERMISSION_RESOURCE_KEYS)[keyof typeof PERMISSION_RESOURCE_KEYS]
export type PermissionActionKey =
  (typeof PERMISSION_ACTION_KEYS)[keyof typeof PERMISSION_ACTION_KEYS]

export const resourceKey = (resource: string): PermissionResourceKey | null =>
  Object.hasOwn(PERMISSION_RESOURCE_KEYS, resource)
    ? PERMISSION_RESOURCE_KEYS[resource as keyof typeof PERMISSION_RESOURCE_KEYS]
    : null

export const actionKey = (action: string): PermissionActionKey | null =>
  Object.hasOwn(PERMISSION_ACTION_KEYS, action)
    ? PERMISSION_ACTION_KEYS[action as keyof typeof PERMISSION_ACTION_KEYS]
    : null
