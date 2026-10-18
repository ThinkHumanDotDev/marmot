/**
 * Shared plumbing of the routes Slack calls (#129): `/api/slack/commands`, `/api/slack/interactions`
 * and `/api/slack/events`. Each one reads the raw body (at most `SLACK_MAX_BODY_BYTES`), verifies
 * the request signature before looking at anything else, and answers 404 while the app is
 * disabled. Work that may outlast Slack's three-second deadline runs after the response
 * (`deferSlackTask`).
 */
import { after } from 'next/server'
import type { Payload } from 'payload'

import { defaultLocale, type Locale } from '@/i18n/locales'
import { childLogger } from '@/lib/logger'
import type { SlackInstallation } from '@/payload-types'
import { getOrganizationI18n, serverTranslator, type ServerTranslator } from '@/server/i18n'
import { readBody } from '@/server/push/inbound-webhook'

import { slackAppConfig, slackDisabledResponse } from './config'
import { relId } from './installations'
import { SLACK_MAX_BODY_BYTES, verifySlackSignature } from './signature'

const log = childLogger('slack:http')

export type VerifiedSlackRequest = { ok: true; body: string } | { ok: false; response: Response }

/**
 * The raw body of a genuine Slack request, or the response for anything else: 404 (app disabled),
 * 413 (too large), 401 (unsigned, forged or replayed).
 */
export async function readVerifiedSlackRequest(request: Request): Promise<VerifiedSlackRequest> {
  const config = slackAppConfig()
  if (!config) return { ok: false, response: slackDisabledResponse() }
  const declared = Number(request.headers.get('content-length') ?? 0)
  const raw = declared > SLACK_MAX_BODY_BYTES ? null : await readBody(request, SLACK_MAX_BODY_BYTES)
  if (!raw) {
    return { ok: false, response: Response.json({ error: 'Payload too large' }, { status: 413 }) }
  }
  const body = Buffer.from(raw).toString('utf8')
  const failure = verifySlackSignature(config.signingSecret, request.headers, body)
  if (failure) {
    log.info({ failure }, 'slack request refused')
    return {
      ok: false,
      response: Response.json({ error: 'Invalid request signature' }, { status: 401 }),
    }
  }
  return { ok: true, body }
}

/** Translator and locale of the installing organization (English for unknown workspaces). */
export async function slackTranslator(
  payload: Payload,
  installation: Pick<SlackInstallation, 'organization'> | null,
): Promise<{ t: ServerTranslator; locale: Locale; timeZone: string }> {
  const i18n = installation
    ? await getOrganizationI18n(payload, relId(installation.organization))
    : { locale: defaultLocale, timeZone: 'UTC' }
  return { t: serverTranslator(i18n.locale), locale: i18n.locale, timeZone: i18n.timeZone }
}

/** A message only the invoking user sees. */
export const ephemeral = (text: string, blocks?: unknown[]) => ({
  response_type: 'ephemeral',
  text,
  ...(blocks ? { blocks } : {}),
})

/** A message everyone in the channel sees. */
export const inChannel = (text: string, blocks?: unknown[]) => ({
  response_type: 'in_channel',
  text,
  ...(blocks ? { blocks } : {}),
})

/** Slack's three control characters in user-provided text. */
export const slackEscape = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

// ---------------------------------------------------------------------------------------------
// Work after the response

const pending = new Set<Promise<unknown>>()

/**
 * Runs `task` after the response is sent (`after()` of Next.js). Outside a request scope (tests,
 * scripts) the task starts at once and is tracked so `settleSlackTasks()` can wait for it.
 */
export function deferSlackTask(task: () => Promise<void>): void {
  const run = () =>
    task().catch((err: unknown) => {
      log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'deferred slack task failed',
      )
    })
  try {
    after(run)
  } catch {
    const promise = run()
    pending.add(promise)
    void promise.finally(() => pending.delete(promise))
  }
}

/** Waits for the tasks `deferSlackTask` started outside a request scope (tests). */
export async function settleSlackTasks(): Promise<void> {
  while (pending.size > 0) await Promise.all([...pending])
}
