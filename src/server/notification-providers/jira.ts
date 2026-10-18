/**
 * Jira provider (#149): creates an issue when a monitor goes DOWN, comments on reminders, comments
 * and transitions it to a configured status on recovery (`./issue-tracker.ts`).
 *
 * - Jira Cloud: REST API v3 with an Atlassian account email and API token (Basic auth); bodies are
 *   Atlassian Document Format.
 * - Jira Data Center / Server: REST API v2 with a personal access token (Bearer); bodies are wiki
 *   markup.
 */
import { z } from 'zod'

import { httpRequest, trimSlash } from './http'
import {
  issueTemplateFieldMeta,
  issueTemplateSchema,
  runIssueTracker,
  splitList,
  type IssueText,
  type IssueTrackerClient,
} from './issue-tracker'
import { registerNotificationProvider } from './registry'
import type { NotificationFieldMeta } from './types'

export const jiraConfigSchema = z
  .object({
    deployment: z.enum(['cloud', 'datacenter']).default('cloud'),
    baseUrl: z.string().url(),
    email: z.string().optional(),
    apiToken: z.string().min(1),
    projectKey: z.string().trim().min(1),
    issueType: z.string().trim().min(1).default('Bug'),
    labels: z.string().optional(),
    doneStatus: z.string().trim().min(1).default('Done'),
    ...issueTemplateSchema,
  })
  .superRefine((config, ctx) => {
    if (config.deployment === 'cloud' && !config.email?.trim()) {
      ctx.addIssue({ code: 'custom', path: ['email'], message: 'Required' })
    }
  })

export type JiraConfig = z.infer<typeof jiraConfigSchema>

export const jiraFieldMeta: Record<keyof JiraConfig, NotificationFieldMeta> = {
  deployment: {
    label: 'Deployment',
    options: { cloud: 'Jira Cloud', datacenter: 'Jira Data Center / Server' },
  },
  baseUrl: { label: 'Jira URL', placeholder: 'https://acme.atlassian.net' },
  email: {
    label: 'Account email',
    placeholder: 'ops@example.com',
    description: 'Jira Cloud only: the Atlassian account the API token belongs to.',
  },
  apiToken: {
    label: 'API token',
    secret: true,
    description: 'Jira Cloud: an API token; Data Center: a personal access token.',
  },
  projectKey: { label: 'Project key', placeholder: 'OPS' },
  issueType: { label: 'Issue type', placeholder: 'Bug' },
  labels: { label: 'Labels', description: 'Comma-separated; Jira labels cannot contain spaces.' },
  doneStatus: {
    label: 'Status on recovery',
    placeholder: 'Done',
    description: 'The issue is moved to this status (or through the transition of that name).',
  },
  ...issueTemplateFieldMeta,
}

type AdfNode = Record<string, unknown>

const URL_PATTERN = /https?:\/\/[^\s<>()]+/g

/** One ADF paragraph for a line, with URLs as links. */
function adfParagraph(line: string, link?: { href: string; label: string }): AdfNode {
  if (link) {
    return {
      type: 'paragraph',
      content: [
        { type: 'text', text: link.label, marks: [{ type: 'link', attrs: { href: link.href } }] },
      ],
    }
  }
  const content: AdfNode[] = []
  let last = 0
  for (const match of line.matchAll(URL_PATTERN)) {
    const index = match.index ?? 0
    if (index > last) content.push({ type: 'text', text: line.slice(last, index) })
    content.push({
      type: 'text',
      text: match[0],
      marks: [{ type: 'link', attrs: { href: match[0] } }],
    })
    last = index + match[0].length
  }
  if (last < line.length) content.push({ type: 'text', text: line.slice(last) })
  return { type: 'paragraph', content }
}

/** The body (one paragraph per non-empty line) plus the monitor link, as an ADF document. */
export function jiraAdf(text: IssueText): AdfNode {
  const content = text.body
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => adfParagraph(line))
  if (text.link && !text.body.includes(text.link)) {
    content.push(adfParagraph('', { href: text.link, label: text.linkLabel }))
  }
  return { type: 'doc', version: 1, content }
}

/** The body plus the monitor link in wiki markup (Data Center). */
export function jiraWiki(text: IssueText): string {
  if (!text.link || text.body.includes(text.link)) return text.body
  return `${text.body}\n\n[${text.linkLabel.replace(/[|\]]/g, ' ')}|${text.link}]`
}

interface JiraTransition {
  id: string
  name?: string
  to?: { name?: string }
}

registerNotificationProvider({
  name: 'jira',
  label: 'Jira',
  group: 'generic',
  docsUrl:
    'https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issues/#api-rest-api-3-issue-post',
  configSchema: jiraConfigSchema,
  fieldMeta: jiraFieldMeta,
  async send(ctx) {
    const config = jiraConfigSchema.parse(ctx.config)
    const cloud = config.deployment === 'cloud'
    const baseUrl = trimSlash(config.baseUrl)
    const apiUrl = `${baseUrl}/rest/api/${cloud ? 3 : 2}`
    const authorization = cloud
      ? `Basic ${Buffer.from(`${config.email!.trim()}:${config.apiToken}`).toString('base64')}`
      : `Bearer ${config.apiToken}`
    const request = (path: string, method: 'GET' | 'POST', json?: unknown) =>
      httpRequest(`${apiUrl}${path}`, {
        method,
        json,
        headers: { Authorization: authorization, Accept: 'application/json' },
      })
    const body = (text: IssueText) => (cloud ? jiraAdf(text) : jiraWiki(text))
    const issuePath = (id: string) => `/issue/${encodeURIComponent(id)}`

    const client: IssueTrackerClient = {
      target: `${baseUrl}/${config.projectKey}`,
      async open(text) {
        const labels = splitList(config.labels)
        const response = await request('/issue', 'POST', {
          fields: {
            project: { key: config.projectKey },
            issuetype: { name: config.issueType },
            summary: text.title,
            description: body(text),
            ...(labels.length ? { labels } : {}),
          },
        })
        const { key } = (await response.json()) as { key?: string }
        if (!key) throw new Error('Jira did not return the issue key')
        return key
      },
      async comment(id, text) {
        await request(`${issuePath(id)}/comment`, 'POST', { body: body(text) })
      },
      async close(id, text) {
        await request(`${issuePath(id)}/comment`, 'POST', { body: body(text) })
        const response = await request(`${issuePath(id)}/transitions`, 'GET')
        const { transitions = [] } = (await response.json()) as { transitions?: JiraTransition[] }
        const wanted = config.doneStatus.toLowerCase()
        const transition =
          transitions.find((t) => t.to?.name?.toLowerCase() === wanted) ??
          transitions.find((t) => t.name?.toLowerCase() === wanted)
        if (!transition) {
          // Already moved there by hand: nothing to do.
          const issue = await request(`${issuePath(id)}?fields=status`, 'GET')
          const { fields } = (await issue.json()) as { fields?: { status?: { name?: string } } }
          if (fields?.status?.name?.toLowerCase() === wanted) return
          const available = transitions.map((t) => t.to?.name ?? t.name).filter(Boolean)
          throw new Error(
            `Jira has no transition from ${id} to "${config.doneStatus}"` +
              (available.length ? ` (available: ${available.join(', ')})` : ''),
          )
        }
        await request(`${issuePath(id)}/transitions`, 'POST', {
          transition: { id: transition.id },
        })
      },
      async verify() {
        await request(`/project/${encodeURIComponent(config.projectKey)}`, 'GET')
      },
    }
    return runIssueTracker(ctx, client)
  },
})
