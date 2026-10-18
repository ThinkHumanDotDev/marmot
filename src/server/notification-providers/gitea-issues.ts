/**
 * Gitea (and Forgejo) Issues provider (#149): opens an issue when a monitor goes DOWN, comments on
 * reminders, comments and closes it on recovery (`./issue-tracker.ts`). Authenticates with an
 * access token that has the `write:issue` scope (and `read:repository` for the Test button).
 */
import { z } from 'zod'

import { httpRequest, trimSlash } from './http'
import {
  issueTemplateFieldMeta,
  issueTemplateSchema,
  markdownBody,
  REPOSITORY_PATTERN,
  runIssueTracker,
  type IssueTrackerClient,
} from './issue-tracker'
import { registerNotificationProvider } from './registry'
import type { NotificationFieldMeta } from './types'

export const giteaIssuesConfigSchema = z.object({
  baseUrl: z.string().url(),
  token: z.string().min(1),
  repository: z.string().trim().regex(REPOSITORY_PATTERN, 'Use the form owner/repository'),
  ...issueTemplateSchema,
})

export type GiteaIssuesConfig = z.infer<typeof giteaIssuesConfigSchema>

export const giteaIssuesFieldMeta: Record<keyof GiteaIssuesConfig, NotificationFieldMeta> = {
  baseUrl: { label: 'Gitea URL', placeholder: 'https://gitea.example.com' },
  token: {
    label: 'Access token',
    secret: true,
    description: 'Settings → Applications: a token with write:issue and read:repository.',
  },
  repository: { label: 'Repository', placeholder: 'acme/status' },
  ...issueTemplateFieldMeta,
}

registerNotificationProvider({
  name: 'gitea-issues',
  label: 'Gitea Issues',
  group: 'generic',
  docsUrl: 'https://docs.gitea.com/development/api-usage',
  configSchema: giteaIssuesConfigSchema,
  fieldMeta: giteaIssuesFieldMeta,
  async send(ctx) {
    const config = giteaIssuesConfigSchema.parse(ctx.config)
    const baseUrl = trimSlash(config.baseUrl)
    const [owner, repo] = config.repository.split('/')
    const repoUrl = `${baseUrl}/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`
    const request = (path: string, method: 'GET' | 'POST' | 'PATCH', json?: unknown) =>
      httpRequest(`${repoUrl}${path}`, {
        method,
        json,
        headers: { Authorization: `token ${config.token}`, Accept: 'application/json' },
      })

    const client: IssueTrackerClient = {
      target: `${baseUrl}/${config.repository}`,
      async open(text) {
        const response = await request('/issues', 'POST', {
          title: text.title,
          body: markdownBody(text),
        })
        const { number } = (await response.json()) as { number?: number }
        if (number === undefined) throw new Error('Gitea did not return the issue number')
        return String(number)
      },
      async comment(id, text) {
        await request(`/issues/${id}/comments`, 'POST', { body: markdownBody(text) })
      },
      async close(id, text) {
        await request(`/issues/${id}/comments`, 'POST', { body: markdownBody(text) })
        await request(`/issues/${id}`, 'PATCH', { state: 'closed' })
      },
      async verify() {
        await request('', 'GET')
      },
    }
    return runIssueTracker(ctx, client)
  },
})
