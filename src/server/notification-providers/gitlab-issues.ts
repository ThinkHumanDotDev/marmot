/**
 * GitLab Issues provider (#149): opens an issue when a monitor goes DOWN, comments on reminders,
 * comments and closes it on recovery (`./issue-tracker.ts`). Works with GitLab.com and
 * self-managed instances (`baseUrl`); authenticates with a personal, group or project access token
 * with the `api` scope.
 */
import { z } from 'zod'

import { httpRequest, trimSlash } from './http'
import {
  issueTemplateFieldMeta,
  issueTemplateSchema,
  markdownBody,
  runIssueTracker,
  splitList,
  type IssueTrackerClient,
} from './issue-tracker'
import { registerNotificationProvider } from './registry'
import type { NotificationFieldMeta } from './types'

export const GITLAB_URL = 'https://gitlab.com'

export const gitlabIssuesConfigSchema = z.object({
  baseUrl: z.string().url().default(GITLAB_URL),
  token: z.string().min(1),
  projectId: z.string().trim().min(1),
  labels: z.string().optional(),
  ...issueTemplateSchema,
})

export type GitlabIssuesConfig = z.infer<typeof gitlabIssuesConfigSchema>

export const gitlabIssuesFieldMeta: Record<keyof GitlabIssuesConfig, NotificationFieldMeta> = {
  baseUrl: {
    label: 'GitLab URL',
    placeholder: GITLAB_URL,
    description: 'Your instance’s address for self-managed GitLab.',
  },
  token: {
    label: 'Access token',
    secret: true,
    description:
      'A personal, group or project access token with the api scope (Reporter or above).',
  },
  projectId: {
    label: 'Project',
    placeholder: 'acme/status',
    description: 'Numeric project ID or full path.',
  },
  labels: { label: 'Labels', description: 'Comma-separated; added to new issues.' },
  ...issueTemplateFieldMeta,
}

registerNotificationProvider({
  name: 'gitlab-issues',
  label: 'GitLab Issues',
  group: 'generic',
  docsUrl: 'https://docs.gitlab.com/api/issues/',
  configSchema: gitlabIssuesConfigSchema,
  fieldMeta: gitlabIssuesFieldMeta,
  async send(ctx) {
    const config = gitlabIssuesConfigSchema.parse(ctx.config)
    const baseUrl = trimSlash(config.baseUrl)
    const projectUrl = `${baseUrl}/api/v4/projects/${encodeURIComponent(config.projectId)}`
    const request = (path: string, method: 'GET' | 'POST' | 'PUT', json?: unknown) =>
      httpRequest(`${projectUrl}${path}`, {
        method,
        json,
        headers: { 'PRIVATE-TOKEN': config.token },
      })

    const client: IssueTrackerClient = {
      target: `${baseUrl}/${config.projectId}`,
      async open(text) {
        const labels = splitList(config.labels)
        const response = await request('/issues', 'POST', {
          title: text.title,
          description: markdownBody(text),
          ...(labels.length ? { labels: labels.join(',') } : {}),
        })
        const { iid } = (await response.json()) as { iid?: number }
        if (iid === undefined) throw new Error('GitLab did not return the issue IID')
        return String(iid)
      },
      async comment(id, text) {
        await request(`/issues/${id}/notes`, 'POST', { body: markdownBody(text) })
      },
      async close(id, text) {
        await request(`/issues/${id}/notes`, 'POST', { body: markdownBody(text) })
        await request(`/issues/${id}`, 'PUT', { state_event: 'close' })
      },
      async verify() {
        await request('', 'GET')
      },
    }
    return runIssueTracker(ctx, client)
  },
})
