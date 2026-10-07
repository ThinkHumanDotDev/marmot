import { api } from '@/lib/api'
import type { Notification } from '@/payload-types'
import type {
  NotificationFieldDescriptor,
  NotificationProviderDescriptor,
} from '@/server/notification-providers/describe'
import type { NotificationProviderGroup } from '@/server/notification-providers/types'

export type { NotificationFieldDescriptor, NotificationProviderDescriptor }

/** Channel as the client sees it: ids are strings, config is a plain object. */
export interface NotificationRow {
  id: string
  name: string
  type: string
  config: Record<string, unknown>
  isDefault: boolean
  active: boolean
  lastSentAt: string | null
  lastError: string | null
  updatedAt: string
}

/** Display order of the provider groups; their labels are `notifications.groups.<group>`. */
export const PROVIDER_GROUP_ORDER: NotificationProviderGroup[] = [
  'chat',
  'push',
  'email',
  'generic',
]

export function toNotificationRow(doc: Notification): NotificationRow {
  return {
    id: String(doc.id),
    name: doc.name,
    type: doc.type,
    config:
      doc.config && typeof doc.config === 'object' && !Array.isArray(doc.config)
        ? (doc.config as Record<string, unknown>)
        : {},
    isDefault: Boolean(doc.isDefault),
    active: doc.active !== false,
    lastSentAt: doc.lastSentAt ?? null,
    lastError: doc.lastError ?? null,
    updatedAt: doc.updatedAt,
  }
}

export type NotificationInput = {
  name: string
  type: string
  config: Record<string, unknown>
  isDefault: boolean
  applyExisting: boolean
  active: boolean
}

export interface TestResult {
  ok: boolean
  result?: string
  error?: string
}

const base = (orgId: string) => `/api/orgs/${encodeURIComponent(orgId)}/notifications`

export const notificationsApi = {
  list: async (orgId: string) =>
    (await api.get<{ docs: Notification[] }>(base(orgId))).docs.map(toNotificationRow),
  create: async (orgId: string, input: NotificationInput) =>
    toNotificationRow((await api.post<{ doc: Notification }>(base(orgId), input)).doc),
  update: async (orgId: string, id: string, input: Partial<NotificationInput>) =>
    toNotificationRow(
      (await api.patch<{ doc: Notification }>(`${base(orgId)}/${encodeURIComponent(id)}`, input))
        .doc,
    ),
  remove: (orgId: string, id: string) =>
    api.delete<{ ok: boolean }>(`${base(orgId)}/${encodeURIComponent(id)}`),
  /** Saved channel (`notificationId`), unsaved edits of one (`notificationId` + `config`) or a new one. */
  test: (
    orgId: string,
    body: {
      notificationId?: string
      type?: string
      config?: Record<string, unknown>
      name?: string
    },
  ) => api.post<TestResult>(`${base(orgId)}/test`, body),
}
