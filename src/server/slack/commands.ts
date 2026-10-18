/**
 * The `/marmot` slash command (#129). Every subcommand answers within Slack's three seconds with an
 * ephemeral message (or an in-channel one for a new subscription):
 *
 * - `help`, `link`, `unlink`
 * - `status [monitor | page]`: the organization's monitors (linked members with `monitor:read`) or
 *   a status page (its own pages, or any public page of this instance, for everyone)
 * - `subscribe <page URL>`, `unsubscribe [page URL]`, `subscriptions`: status-page subscribers
 *   (#104) of channel `slack` whose target is this channel (`slack://<team>/<channel>`)
 * - `incident create | update | resolve`: opens the incident modal (`./modals.ts`), handled in
 *   `./interactions.ts`
 *
 * Anything that changes data needs a linked Slack user (`slack-user-links`) and is done with that
 * member's permissions in the installing organization; unlinked users only read.
 */
import type { Payload } from 'payload'

import { offeredChannels } from '@/lib/status-page-subscribers'
import { slackAppTarget, type SlackIncidentMode } from '@/lib/slack-app'
import { childLogger } from '@/lib/logger'
import type { Monitor, SlackInstallation, StatusPage, StatusPageSubscriber } from '@/payload-types'
import type { ServerTranslator } from '@/server/i18n'
import type { RequestUser } from '@/server/monitors/http'
import { isProtectedPage } from '@/server/status-pages/access'
import { buildPublicStatusPageData } from '@/server/status-pages/public'
import { isAudiencePage } from '@/server/status-pages/audiences'
import { publicPageUrl } from '@/server/status-pages/subscribers/links'
import { sendSubscriberWelcome } from '@/server/status-pages/subscribers/signup'
import { DeliveryError } from '@/server/status-pages/subscribers/deliver'
import { canInOrg } from '@/access/overrides'

import { slackApi, SlackApiError } from './api'
import { absoluteUrl } from './config'
import { ephemeral, inChannel, slackEscape, slackTranslator } from './http'
import {
  appSubscriptions,
  findInstallationByTeam,
  installationToken,
  linkedUser,
  linkedUserWith,
  relId,
  unlinkSlackUser,
} from './installations'
import { incidentModal, incidentModalChoices } from './modals'
import { pageVisibleTo, resolveStatusPage, unwrapSlackLink } from './pages'
import { createLinkToken } from './tokens'

const log = childLogger('slack:commands')

export interface SlashCommand {
  teamId: string
  channelId: string
  userId: string
  text: string
  triggerId: string
  responseUrl: string
}

export type SlackReply = Record<string, unknown>

/** Parses the form body of a slash command; `null` without the ids every command needs. */
export function parseSlashCommand(body: string): SlashCommand | null {
  const form = new URLSearchParams(body)
  const teamId = form.get('team_id') ?? ''
  const channelId = form.get('channel_id') ?? ''
  const userId = form.get('user_id') ?? ''
  if (!teamId || !channelId || !userId) return null
  return {
    teamId,
    channelId,
    userId,
    text: (form.get('text') ?? '').trim(),
    triggerId: form.get('trigger_id') ?? '',
    responseUrl: form.get('response_url') ?? '',
  }
}

interface Ctx {
  payload: Payload
  installation: SlackInstallation
  orgId: string | number
  cmd: SlashCommand
  t: ServerTranslator
}

export async function handleSlashCommand(payload: Payload, cmd: SlashCommand): Promise<SlackReply> {
  const installation = await findInstallationByTeam(payload, cmd.teamId)
  const { t } = await slackTranslator(payload, installation)
  if (!installation) return ephemeral(t('slackApp.notInstalled'))
  const orgId = relId(installation.organization)
  if (orgId === null) return ephemeral(t('slackApp.notInstalled'))
  const ctx: Ctx = { payload, installation, orgId, cmd, t }

  const [rawSub = 'help', ...rest] = cmd.text.split(/\s+/).filter(Boolean)
  const sub = rawSub.toLowerCase()
  const args = rest.join(' ')
  try {
    switch (sub) {
      case 'help':
        return ephemeral(t('slackApp.help'))
      case 'link':
        return await link(ctx)
      case 'unlink':
        return ephemeral(
          (await unlinkSlackUser(payload, installation.teamId, cmd.userId))
            ? t('slackApp.unlinked')
            : t('slackApp.notLinked'),
        )
      case 'status':
        return await status(ctx, args)
      case 'subscribe':
        return await subscribe(ctx, args)
      case 'unsubscribe':
        return await unsubscribe(ctx, args)
      case 'subscriptions':
        return await subscriptions(ctx)
      case 'incident':
        return await incident(ctx, rest[0]?.toLowerCase() ?? '')
      default:
        return ephemeral(t('slackApp.unknownCommand', { command: rawSub.slice(0, 40) }))
    }
  } catch (err) {
    log.error({ err, sub }, 'slash command failed')
    return ephemeral(t('slackApp.failed'))
  }
}

// ---------------------------------------------------------------------------------------------
// Linking

async function link({ payload, installation, cmd, t }: Ctx): Promise<SlackReply> {
  const user = await linkedUser(payload, installation, cmd.userId)
  if (user) return ephemeral(t('slackApp.alreadyLinked', { name: user.name || user.email }))
  const url = absoluteUrl(
    `/slack/link/${createLinkToken({ teamId: installation.teamId, slackUserId: cmd.userId })}`,
  )
  const text = t('slackApp.linkPrompt')
  return ephemeral(text, [
    { type: 'section', text: { type: 'mrkdwn', text } },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          action_id: 'marmot_link',
          style: 'primary',
          text: { type: 'plain_text', text: t('slackApp.linkButton') },
          url,
        },
      ],
    },
  ])
}

/** The linked member, or the reply telling the user to link first. */
async function requireLinked(ctx: Ctx): Promise<RequestUser | SlackReply> {
  const user = await linkedUser(ctx.payload, ctx.installation, ctx.cmd.userId)
  return user ?? ephemeral(ctx.t('slackApp.linkFirst'))
}

const isReply = (value: RequestUser | SlackReply): value is SlackReply => 'response_type' in value

// ---------------------------------------------------------------------------------------------
// Status

type MonitorRow = Pick<Monitor, 'id' | 'name' | 'active' | 'type' | 'status'>

const monitorState = (monitor: MonitorRow): string =>
  monitor.active === false ? 'paused' : (monitor.status?.lastStatus ?? 'unknown')

async function status(ctx: Ctx, args: string): Promise<SlackReply> {
  const { payload, orgId, t } = ctx
  const query = unwrapSlackLink(args)
  if (query) {
    const page = await resolveStatusPage(payload, query)
    if (page && !isProtectedPage(page)) return pageStatus(ctx, page)
    // The organization's own protected pages: linked members who may read them.
    if (page && String(relId(page.organization)) === String(orgId)) {
      const reader = await linkedUserWith(
        payload,
        ctx.installation,
        ctx.cmd.userId,
        'status-page:read',
      )
      if (reader.allowed) return pageStatus(ctx, page)
    }
  }

  // The organization's monitors: linked members who may read them.
  const { user, allowed } = await linkedUserWith(
    payload,
    ctx.installation,
    ctx.cmd.userId,
    'monitor:read',
  )
  if (!user) {
    return ephemeral(query ? t('slackApp.statusNotFound', { query }) : t('slackApp.linkFirst'))
  }
  if (!allowed) return ephemeral(t('slackApp.forbidden', { name: user.name || user.email }))

  const { docs } = await payload.find({
    collection: 'monitors',
    where: { organization: { equals: orgId } },
    depth: 0,
    limit: 1000,
    sort: 'name',
    user,
    overrideAccess: false,
    select: { name: true, active: true, type: true, status: true },
  })
  const monitors = (docs as MonitorRow[]).filter((m) => m.type !== 'group')
  if (query) {
    const needle = query.toLowerCase()
    const matches = monitors.filter((m) => m.name.toLowerCase().includes(needle))
    const exact = matches.find((m) => m.name.toLowerCase() === needle)
    const shown = exact ? [exact] : matches.slice(0, 10)
    if (shown.length === 0) return ephemeral(t('slackApp.statusNotFound', { query }))
    const lines = shown.map((m) => monitorLine(t, m))
    return ephemeral(lines.join('\n'))
  }

  const counts = { up: 0, down: 0, other: 0 }
  for (const monitor of monitors) {
    const state = monitorState(monitor)
    if (state === 'up' || state === 'degraded') counts.up += 1
    else if (state === 'down') counts.down += 1
    else counts.other += 1
  }
  const down = monitors.filter((m) => monitorState(m) === 'down')
  const lines = [
    t('slackApp.statusSummary', { total: monitors.length, ...counts }),
    ...down.slice(0, 15).map((m) => monitorLine(t, m)),
  ]
  if (down.length > 15) lines.push(t('slackApp.statusMore', { count: down.length - 15 }))
  return ephemeral(lines.join('\n'))
}

const STATE_EMOJI: Record<string, string> = {
  up: ':large_green_circle:',
  degraded: ':large_yellow_circle:',
  down: ':red_circle:',
  pending: ':large_orange_circle:',
  maintenance: ':large_blue_circle:',
  paused: ':white_circle:',
  unknown: ':white_circle:',
}

function monitorLine(t: ServerTranslator, monitor: MonitorRow): string {
  const state = monitorState(monitor)
  return `${STATE_EMOJI[state] ?? ':white_circle:'} *${slackEscape(monitor.name)}*: ${t(
    'slackApp.monitorStates',
    { state },
  )}`
}

async function pageStatus({ payload, t }: Ctx, page: StatusPage): Promise<SlackReply> {
  const full = (await payload.findByID({
    collection: 'status-pages',
    id: page.id,
    depth: 1,
    overrideAccess: true,
  })) as StatusPage
  const data = await buildPublicStatusPageData(payload, full)
  const lines = [
    `*${slackEscape(page.title)}*: ${t('slackApp.pageStates', { state: data.overall })}`,
    ...data.groups.flatMap((group) =>
      group.monitors.map(
        (row) =>
          `${STATE_EMOJI[row.status] ?? ':white_circle:'} ${slackEscape(row.name)}: ${t(
            'slackApp.monitorStates',
            { state: row.status },
          )}`,
      ),
    ),
    ...data.incidents.map((incident) =>
      t('slackApp.activeIncident', { title: slackEscape(incident.title) }),
    ),
    `<${publicPageUrl(page)}|${t('slackApp.viewPage')}>`,
  ]
  return ephemeral(lines.slice(0, 60).join('\n'))
}

// ---------------------------------------------------------------------------------------------
// Subscriptions

const isUniqueViolation = (err: unknown): boolean =>
  /unique|duplicate|E11000|already subscribed/i.test(
    err instanceof Error
      ? `${err.message} ${JSON.stringify((err as { data?: unknown }).data ?? '')}`
      : String(err),
  )

async function subscribe(ctx: Ctx, args: string): Promise<SlackReply> {
  const { payload, installation, orgId, cmd, t } = ctx
  const linked = await requireLinked(ctx)
  if (isReply(linked)) return linked
  if (!args) return ephemeral(t('slackApp.subscribeUsage'))

  const page = await resolveStatusPage(payload, args)
  if (!page || !pageVisibleTo(page, orgId)) {
    return ephemeral(t('slackApp.pageNotFound', { query: unwrapSlackLink(args).slice(0, 200) }))
  }
  const title = slackEscape(page.title)
  const ownPage = String(relId(page.organization)) === String(orgId)
  if (ownPage) {
    // Adding a subscriber to the organization's own page is an owner action.
    if (!(await canInOrg(payload, linked, orgId, 'subscriber:manage'))) {
      return ephemeral(t('slackApp.forbidden', { name: linked.name || linked.email }))
    }
    if (!page.subscriptions?.enabled)
      return ephemeral(t('slackApp.subscriptionsOff', { page: title }))
  } else if (!offeredChannels(page.subscriptions).includes('slack')) {
    return ephemeral(t('slackApp.subscriptionsOff', { page: title }))
  }
  // Audience pages (#151) only tell a subscriber about the components of their audiences.
  if (isAudiencePage(page)) return ephemeral(t('slackApp.subscriptionsOff', { page: title }))

  const target = slackAppTarget(installation.teamId, cmd.channelId)
  let subscriber: StatusPageSubscriber
  try {
    subscriber = (await payload.create({
      collection: 'status-page-subscribers',
      data: {
        statusPage: page.id,
        organization: page.organization,
        channel: 'slack',
        target,
        source: ownPage ? 'added_by_owner' : 'self_signup',
        // Installing the app and running the command in the channel is the opt-in.
        confirmedAt: new Date().toISOString(),
      },
      depth: 0,
      overrideAccess: true,
      context: { slackAppSubscription: true },
    })) as StatusPageSubscriber
  } catch (err) {
    if (isUniqueViolation(err)) return ephemeral(t('slackApp.alreadySubscribed', { page: title }))
    throw err
  }

  // The welcome message carries the manage and unsubscribe links, and proves the bot can post here.
  try {
    await sendSubscriberWelcome(payload, page, subscriber)
  } catch (err) {
    await payload
      .delete({ collection: 'status-page-subscribers', id: subscriber.id, overrideAccess: true })
      .catch(() => undefined)
    if (err instanceof DeliveryError && !err.retryable) {
      return ephemeral(t('slackApp.botNotInChannel'))
    }
    throw err
  }
  log.info({ pageId: page.id, teamId: installation.teamId }, 'slack channel subscribed')
  return inChannel(t('slackApp.subscribed', { page: title, user: `<@${cmd.userId}>` }))
}

async function unsubscribe(ctx: Ctx, args: string): Promise<SlackReply> {
  const { payload, installation, cmd, t } = ctx
  const linked = await requireLinked(ctx)
  if (isReply(linked)) return linked
  let rows = await appSubscriptions(payload, installation.teamId, cmd.channelId)
  if (args) {
    const page = await resolveStatusPage(payload, args)
    rows = page ? rows.filter((row) => String(row.statusPage) === String(page.id)) : []
  }
  for (const row of rows) {
    await payload.delete({
      collection: 'status-page-subscribers',
      id: row.id,
      overrideAccess: true,
    })
  }
  return ephemeral(t('slackApp.unsubscribed', { count: rows.length }))
}

async function subscriptions({ payload, installation, cmd, t }: Ctx): Promise<SlackReply> {
  const rows = await appSubscriptions(payload, installation.teamId, cmd.channelId)
  if (rows.length === 0) return ephemeral(t('slackApp.subscriptionsNone'))
  const ids = rows.map((row) => row.statusPage).filter((id) => id !== null)
  const { docs } = await payload.find({
    collection: 'status-pages',
    where: { id: { in: ids } },
    depth: 0,
    limit: ids.length,
    overrideAccess: true,
    select: { title: true, slug: true, domains: true },
  })
  const lines = (docs as StatusPage[]).map(
    (page) => `• <${publicPageUrl(page)}|${slackEscape(page.title)}>`,
  )
  return ephemeral([t('slackApp.subscriptionsList'), ...lines].join('\n'))
}

// ---------------------------------------------------------------------------------------------
// Incidents

const MODES: readonly SlackIncidentMode[] = ['create', 'update', 'resolve']

async function incident(ctx: Ctx, mode: string): Promise<SlackReply> {
  const { payload, installation, cmd, t, orgId } = ctx
  if (!MODES.includes(mode as SlackIncidentMode)) return ephemeral(t('slackApp.incidentUsage'))
  const { user, allowed } = await linkedUserWith(
    payload,
    installation,
    cmd.userId,
    'status-page:update',
  )
  if (!user) return ephemeral(t('slackApp.linkFirst'))
  if (!allowed) return ephemeral(t('slackApp.forbidden', { name: user.name || user.email }))

  const choices = await incidentModalChoices(payload, user, orgId)
  if (choices.pages.length === 0) return ephemeral(t('slackApp.noPages'))
  if (mode !== 'create' && choices.incidents.length === 0) {
    return ephemeral(t('slackApp.noActiveIncidents'))
  }
  const token = installationToken(installation)
  if (!token || !cmd.triggerId) return ephemeral(t('slackApp.failed'))
  try {
    await slackApi('views.open', token, {
      trigger_id: cmd.triggerId,
      view: incidentModal(t, mode as SlackIncidentMode, choices, {
        channelId: cmd.channelId,
      }),
    })
  } catch (err) {
    log.warn({ err: err instanceof SlackApiError ? err.code : String(err) }, 'views.open failed')
    return ephemeral(t('slackApp.failed'))
  }
  // An empty 200 keeps the channel quiet; the modal is the answer.
  return {}
}
