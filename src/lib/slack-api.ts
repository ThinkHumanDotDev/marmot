/** Client-side calls for the Slack app (#129). */
import { api } from '@/lib/api'
import type { SlackSettings } from '@/lib/slack-app'

type Id = string | number

export const slackApi = {
  get: (orgId: Id) => api.get<SlackSettings>(`/api/orgs/${orgId}/slack`),
  uninstall: (orgId: Id) => api.delete<{ deleted: boolean }>(`/api/orgs/${orgId}/slack`),
  unlink: (orgId: Id, linkId: Id) =>
    api.delete<{ deleted: boolean }>(`/api/orgs/${orgId}/slack/links/${linkId}`),
  /** Same-origin URL that starts "Add to Slack" (a browser navigation, not a fetch). */
  installUrl: (orgId: Id) => `/api/orgs/${orgId}/slack/install`,
  confirmLink: (token: string) => api.post<{ linked: boolean }>('/api/slack/link', { token }),
}
