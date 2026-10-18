/**
 * GitHub Issues provider (#149): opens an issue when a monitor goes DOWN, comments on reminders,
 * comments and closes it on recovery (`./issue-tracker.ts`). Authenticates with a personal access
 * token (fine-grained with Issues read/write, or classic `repo`) or as a GitHub App installation.
 * `apiUrl` points at GitHub Enterprise Server (`https://github.example.com/api/v3`).
 */
import { createSign } from 'node:crypto'

import { z } from 'zod'

import { httpRequest, trimSlash } from './http'
import {
  issueTemplateFieldMeta,
  issueTemplateSchema,
  markdownBody,
  REPOSITORY_PATTERN,
  runIssueTracker,
  splitList,
  type IssueTrackerClient,
} from './issue-tracker'
import { registerNotificationProvider } from './registry'
import type { NotificationFieldMeta } from './types'

export const GITHUB_API_URL = 'https://api.github.com'

export const githubIssuesConfigSchema = z
  .object({
    apiUrl: z.string().url().default(GITHUB_API_URL),
    repository: z.string().trim().regex(REPOSITORY_PATTERN, 'Use the form owner/repository'),
    authMethod: z.enum(['token', 'app']).default('token'),
    token: z.string().optional(),
    appId: z.string().optional(),
    installationId: z.string().optional(),
    privateKey: z.string().optional(),
    labels: z.string().optional(),
    assignees: z.string().optional(),
    ...issueTemplateSchema,
  })
  .superRefine((config, ctx) => {
    const keys =
      config.authMethod === 'app'
        ? (['appId', 'installationId', 'privateKey'] as const)
        : (['token'] as const)
    for (const key of keys) {
      if (!config[key]?.trim()) ctx.addIssue({ code: 'custom', path: [key], message: 'Required' })
    }
  })

export type GithubIssuesConfig = z.infer<typeof githubIssuesConfigSchema>

export const githubIssuesFieldMeta: Record<keyof GithubIssuesConfig, NotificationFieldMeta> = {
  apiUrl: {
    label: 'API URL',
    placeholder: GITHUB_API_URL,
    description: 'GitHub Enterprise Server: https://github.example.com/api/v3.',
  },
  repository: { label: 'Repository', placeholder: 'acme/status' },
  authMethod: {
    label: 'Authentication',
    options: { token: 'Personal access token', app: 'GitHub App installation' },
  },
  token: {
    label: 'Access token',
    secret: true,
    description:
      'Token only: a fine-grained token with Issues read and write on the repository, or a classic token with repo.',
  },
  appId: { label: 'App ID', description: 'GitHub App only.' },
  installationId: {
    label: 'Installation ID',
    description: 'GitHub App only: the number at the end of the installation’s settings URL.',
  },
  privateKey: {
    label: 'App private key',
    secret: true,
    multiline: true,
    description: 'GitHub App only: the PEM file generated in the app settings.',
  },
  labels: { label: 'Labels', description: 'Comma-separated; added to new issues.' },
  assignees: { label: 'Assignees', description: 'Comma-separated GitHub user names.' },
  ...issueTemplateFieldMeta,
}

const base64url = (value: string | Buffer) => Buffer.from(value).toString('base64url')

/** A pasted key may carry literal `\n` sequences instead of line breaks. */
const normalizePem = (pem: string) => pem.trim().replace(/\\n/g, '\n')

/** RS256 JWT that authenticates as the GitHub App (valid for 9 minutes, backdated 60 s). */
export function githubAppJwt(appId: string, privateKey: string, now = Date.now()): string {
  const iat = Math.floor(now / 1000) - 60
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const claims = base64url(JSON.stringify({ iat, exp: iat + 600, iss: appId.trim() }))
  let signature: string
  try {
    signature = createSign('RSA-SHA256')
      .update(`${header}.${claims}`)
      .sign(normalizePem(privateKey), 'base64url')
  } catch {
    throw new Error('GitHub App private key is not a valid PEM key')
  }
  return `${header}.${claims}.${signature}`
}

const GITHUB_HEADERS = {
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'Marmot',
}

async function githubToken(config: GithubIssuesConfig, apiUrl: string): Promise<string> {
  if (config.authMethod !== 'app') return config.token!.trim()
  const jwt = githubAppJwt(config.appId!, config.privateKey!)
  const response = await httpRequest(
    `${apiUrl}/app/installations/${encodeURIComponent(config.installationId!.trim())}/access_tokens`,
    { method: 'POST', headers: { ...GITHUB_HEADERS, Authorization: `Bearer ${jwt}` } },
  )
  const { token } = (await response.json()) as { token?: string }
  if (!token) throw new Error('GitHub did not return an installation access token')
  return token
}

registerNotificationProvider({
  name: 'github-issues',
  label: 'GitHub Issues',
  group: 'generic',
  docsUrl: 'https://docs.github.com/en/rest/issues/issues',
  configSchema: githubIssuesConfigSchema,
  fieldMeta: githubIssuesFieldMeta,
  async send(ctx) {
    const config = githubIssuesConfigSchema.parse(ctx.config)
    const apiUrl = trimSlash(config.apiUrl)
    const [owner, repo] = config.repository.split('/')
    const repoUrl = `${apiUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`
    let token: string | null = null
    const request = async (path: string, method: 'GET' | 'POST' | 'PATCH', json?: unknown) => {
      token ??= await githubToken(config, apiUrl)
      return httpRequest(`${repoUrl}${path}`, {
        method,
        json,
        headers: { ...GITHUB_HEADERS, Authorization: `Bearer ${token}` },
      })
    }

    const client: IssueTrackerClient = {
      target: `${apiUrl}/${config.repository}`,
      async open(text) {
        const labels = splitList(config.labels)
        const assignees = splitList(config.assignees)
        const response = await request('/issues', 'POST', {
          title: text.title,
          body: markdownBody(text),
          ...(labels.length ? { labels } : {}),
          ...(assignees.length ? { assignees } : {}),
        })
        const { number } = (await response.json()) as { number?: number }
        if (number === undefined) throw new Error('GitHub did not return the issue number')
        return String(number)
      },
      async comment(id, text) {
        await request(`/issues/${id}/comments`, 'POST', { body: markdownBody(text) })
      },
      async close(id, text) {
        await request(`/issues/${id}/comments`, 'POST', { body: markdownBody(text) })
        await request(`/issues/${id}`, 'PATCH', { state: 'closed', state_reason: 'completed' })
      },
      async verify() {
        await request('', 'GET')
      },
    }
    return runIssueTracker(ctx, client)
  },
})
