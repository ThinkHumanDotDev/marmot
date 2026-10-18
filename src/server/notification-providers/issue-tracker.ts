/**
 * Shared flow of the issue-tracker providers (#149: `github-issues`, `gitlab-issues`,
 * `gitea-issues`, `jira`, `linear`). Not a provider itself: each tracker supplies an
 * `IssueTrackerClient` and calls `runIssueTracker`.
 *
 * - DOWN opens an issue and remembers it (`ctx.issues`, `notification-sent-history` type `issue`);
 *   a DOWN while an issue is still open comments on it instead of opening another one.
 * - Reminders comment on the open issue (and open one when the channel joined mid-outage).
 * - UP comments on the open issue, closes it and forgets it.
 * - Other monitor events (acknowledged, resolved, degraded, certificate) comment on an open issue
 *   and do nothing otherwise; organization-wide messages (maintenance, declared incidents) are
 *   ignored.
 * - The Test button opens a test issue and closes it right away for the `down` sample (proving the
 *   token may create, comment and close) and only reads the repository or project for the others.
 */
import { z } from 'zod'

import {
  monitorDashboardUrl,
  providerText,
  renderMessageTemplate,
} from '@/server/notifications/message'
import { OK_MESSAGE } from './http'
import type { NotificationFieldMeta, NotificationSendContext } from './types'

export const DEFAULT_ISSUE_TITLE_TEMPLATE = 'alert(marmot): {{ name }}'
export const DEFAULT_ISSUE_BODY_TEMPLATE = '{{ msg }}'
export const NO_ACTION_MESSAGE = 'no action required'

/** Config keys every issue-tracker provider shares. */
export const issueTemplateSchema = {
  titleTemplate: z.string().default(DEFAULT_ISSUE_TITLE_TEMPLATE),
  bodyTemplate: z.string().default(DEFAULT_ISSUE_BODY_TEMPLATE),
}

export const issueTemplateFieldMeta = {
  titleTemplate: {
    label: 'Issue title',
    template: 'text',
    description: 'Liquid template for the title of the issue opened on DOWN.',
  },
  bodyTemplate: {
    label: 'Issue body and comments',
    template: 'text',
    multiline: true,
    description:
      'Liquid template for the issue body and for the comments on reminders and recovery. A link to the monitor is added when the text has none.',
  },
} satisfies Record<keyof typeof issueTemplateSchema, NotificationFieldMeta>

/** Comma-separated list → trimmed, non-empty entries. */
export const splitList = (value: string | undefined | null): string[] =>
  (value ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)

/** `owner/repo` with exactly one slash. */
export const REPOSITORY_PATTERN = /^[^/\s]+\/[^/\s]+$/

/** What one notification does to the tracker. */
export type IssueAction = 'open' | 'comment' | 'close' | 'test' | 'verify' | 'none'

/** The rendered text of one notification. */
export interface IssueText {
  title: string
  /** Body or comment, rendered from `bodyTemplate`. */
  body: string
  /** Link to the monitor in Marmot (empty when unknown). */
  link: string
  /** Label of the link (`Open API`). */
  linkLabel: string
}

export interface IssueTrackerClient {
  /** Repository, project or team; part of the stored row's key. */
  readonly target: string
  /** Open an issue and resolve with its id (number, key or id) as stored for later updates. */
  open(text: IssueText): Promise<string>
  comment(id: string, text: IssueText): Promise<void>
  /** Comment with `text` and close (or transition to done). */
  close(id: string, text: IssueText): Promise<void>
  /** Read-only check of the credentials and the target. */
  verify(): Promise<void>
}

/** `text.body` with a Markdown link to the monitor unless the body already contains the URL. */
export function markdownBody(text: IssueText): string {
  if (!text.link || text.body.includes(text.link)) return text.body
  return `${text.body}\n\n[${text.linkLabel}](${text.link})`
}

/** Decide what a notification does (see the module comment). */
export function issueAction(
  ctx: Pick<NotificationSendContext, 'monitor' | 'heartbeat' | 'event'>,
): IssueAction {
  const event = ctx.event ?? null
  if (!ctx.monitor) {
    if (event === null || event === 'down') return 'test'
    if (event === 'maintenance' || event === 'incident') return 'none'
    return 'verify'
  }
  const status = ctx.heartbeat?.status
  if (event === 'up' || (event === null && status === 'up')) return 'close'
  if (event === 'down' || event === 'reminder' || (event === null && status === 'down')) {
    return 'open'
  }
  return 'comment'
}

/** Thrown by a client when the stored issue no longer exists (deleted or moved by hand). */
export class IssueGoneError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'IssueGoneError'
  }
}

/** The tracker answered that the stored issue no longer exists. */
const isGone = (error: unknown) =>
  error instanceof IssueGoneError ||
  (error instanceof Error && /\(HTTP (404|410)\b/.test(error.message))

export function renderIssueText(ctx: NotificationSendContext, testTitle?: string): IssueText {
  const config = ctx.config as { titleTemplate?: string; bodyTemplate?: string }
  const extras = {
    event: ctx.event,
    downtimeSeconds: ctx.downtimeSeconds,
    organization: ctx.organization,
    timeZone: ctx.timeZone,
  }
  const render = (template: string | undefined, fallback: string) => {
    const source = template?.trim() ? template : fallback
    return renderMessageTemplate(
      source,
      ctx.message,
      ctx.monitor,
      ctx.heartbeat,
      ctx.locale,
      extras,
    ).trim()
  }
  const title =
    testTitle ??
    (render(config.titleTemplate, DEFAULT_ISSUE_TITLE_TEMPLATE).replace(/\s+/g, ' ') ||
      render(DEFAULT_ISSUE_TITLE_TEMPLATE, DEFAULT_ISSUE_TITLE_TEMPLATE))
  const body = render(config.bodyTemplate, DEFAULT_ISSUE_BODY_TEMPLATE) || ctx.message
  return {
    title: title.slice(0, 250),
    body,
    link: monitorDashboardUrl(ctx.monitor, ctx.organization),
    linkLabel: providerText(ctx.locale)('openMonitor', { name: ctx.monitor?.name ?? 'Marmot' }),
  }
}

/** Run one notification against a tracker. Resolves with the provider's success string. */
export async function runIssueTracker(
  ctx: NotificationSendContext,
  client: IssueTrackerClient,
): Promise<string> {
  const action = issueAction(ctx)
  if (action === 'none') return NO_ACTION_MESSAGE
  if (action === 'verify') {
    await client.verify()
    return OK_MESSAGE
  }
  if (action === 'test') {
    const text = renderIssueText(ctx, `alert(marmot): ${providerText(ctx.locale)('test')}`)
    const id = await client.open(text)
    await client.close(id, text)
    return OK_MESSAGE
  }

  const text = renderIssueText(ctx)
  const store = ctx.issues
  const openId = store ? await store.get(client.target) : null

  if (action === 'close') {
    if (!openId || !store) return NO_ACTION_MESSAGE
    try {
      await client.close(openId, text)
    } catch (error) {
      // Deleted by hand: nothing left to close.
      if (!isGone(error)) throw error
    }
    await store.clear(client.target)
    return OK_MESSAGE
  }

  if (openId) {
    try {
      await client.comment(openId, text)
      return OK_MESSAGE
    } catch (error) {
      if (!isGone(error)) throw error
      await store?.clear(client.target)
      if (action === 'comment') return NO_ACTION_MESSAGE
    }
  } else if (action === 'comment') {
    return NO_ACTION_MESSAGE
  }

  const id = await client.open(text)
  await store?.set(client.target, id)
  return OK_MESSAGE
}
