/**
 * Interactivity of the Slack app (#129): the **Acknowledge** and **Check now** buttons of "Slack
 * (app)" alert messages and the submission of the incident modal. Every action needs a Slack user
 * linked to a member of the installing organization with the matching permission
 * (`monitor-incident:acknowledge`, `monitor:update`, `status-page:update`); the target (incident,
 * monitor, status page) must belong to that organization. Answers go to the action's
 * `response_url`; a modal submission answers inline (`response_action: errors`) or closes.
 */
import type { Payload } from 'payload'

import { supportsCheckNow } from '@/lib/on-demand-check'
import { isIncidentStatus, type IncidentStatus } from '@/lib/incident-timeline'
import { childLogger } from '@/lib/logger'
import { isRemoteMonitor } from '@/lib/probe-locations'
import { SLACK_ACTIONS, SLACK_INCIDENT_MODAL, SLACK_INCIDENT_MODES } from '@/lib/slack-app'
import type {
  Incident,
  Monitor,
  MonitorIncident,
  SlackInstallation,
  StatusPage,
} from '@/payload-types'
import { MANUAL_CHECK_JOB_NAME } from '@/server/engine/names'
import {
  enqueueOnDemandCheck,
  onDemandWaitMs,
  waitForOnDemandCheck,
} from '@/server/engine/on-demand'
import type { ServerTranslator } from '@/server/i18n'
import { acknowledge } from '@/server/incidents/actions'
import { auditIncidentAction } from '@/server/incidents/audit'
import { getIncident } from '@/server/incidents/store'
import type { RequestUser } from '@/server/monitors/http'
import { onDemandCheckLimiter } from '@/server/security/limiters'
import { postIncidentUpdate, toUpdateRow } from '@/server/status-pages/incident-updates'

import { postToResponseUrl, slackApi } from './api'
import { deferSlackTask, slackEscape, slackTranslator } from './http'
import { findInstallationByTeam, installationToken, linkedUserWith, relId } from './installations'
import { MODAL_BLOCKS, modalValues, type IncidentModalMeta } from './modals'

const log = childLogger('slack:interactions')

interface SlackAction {
  action_id?: string
  value?: string
}

interface InteractionPayload {
  type?: string
  user?: { id?: string; team_id?: string }
  team?: { id?: string } | null
  channel?: { id?: string } | null
  actions?: SlackAction[]
  response_url?: string
  view?: {
    callback_id?: string
    private_metadata?: string
    state?: { values?: Parameters<typeof modalValues>[0] }
  }
}

/** Parses the `payload` form field of an interaction request. */
export function parseInteraction(body: string): InteractionPayload | null {
  const raw = new URLSearchParams(body).get('payload')
  if (!raw) return null
  try {
    const data = JSON.parse(raw) as unknown
    return data && typeof data === 'object' ? (data as InteractionPayload) : null
  } catch {
    return null
  }
}

interface Ctx {
  payload: Payload
  request: Request
  installation: SlackInstallation
  orgId: string | number
  slackUserId: string
  t: ServerTranslator
}

/** The HTTP answer to an interaction: an empty 200, or a modal's `response_action`. */
export async function handleInteraction(
  payload: Payload,
  request: Request,
  interaction: InteractionPayload,
): Promise<Record<string, unknown> | null> {
  const teamId = interaction.team?.id ?? interaction.user?.team_id ?? ''
  const slackUserId = interaction.user?.id ?? ''
  const installation = teamId ? await findInstallationByTeam(payload, teamId) : null
  const { t } = await slackTranslator(payload, installation)
  const orgId = installation ? relId(installation.organization) : null
  const reply = (text: string, inChannel = false) =>
    interaction.response_url
      ? postToResponseUrl(interaction.response_url, {
          response_type: inChannel ? 'in_channel' : 'ephemeral',
          replace_original: false,
          text,
        })
      : Promise.resolve()

  if (!installation || orgId === null || !slackUserId) {
    if (interaction.type === 'view_submission') return null
    await reply(t('slackApp.notInstalled'))
    return null
  }
  const ctx: Ctx = { payload, request, installation, orgId, slackUserId, t }

  if (interaction.type === 'block_actions') {
    const action = interaction.actions?.[0]
    if (action?.action_id === SLACK_ACTIONS.acknowledge) {
      await reply(...(await acknowledgeAction(ctx, action.value ?? '')))
    } else if (action?.action_id === SLACK_ACTIONS.checkNow) {
      await checkNowAction(ctx, action.value ?? '', reply)
    }
    // Link buttons (`url`) also report a click; nothing to do.
    return null
  }
  if (
    interaction.type === 'view_submission' &&
    interaction.view?.callback_id === SLACK_INCIDENT_MODAL
  ) {
    return submitIncidentModal(ctx, interaction)
  }
  return null
}

const parseId = (payload: Payload, raw: string): string | number | null => {
  if (!raw || raw.length > 64) return null
  return payload.db.defaultIDType === 'number' ? (/^\d+$/.test(raw) ? Number(raw) : null) : raw
}

// ---------------------------------------------------------------------------------------------
// Acknowledge

async function acknowledgeAction(ctx: Ctx, rawId: string): Promise<[string, boolean?]> {
  const { payload, installation, orgId, slackUserId, t } = ctx
  const { user, allowed } = await linkedUserWith(
    payload,
    installation,
    slackUserId,
    'monitor-incident:acknowledge',
  )
  if (!user) return [t('slackApp.linkFirst')]
  if (!allowed) return [t('slackApp.forbidden', { name: user.name || user.email })]

  const id = parseId(payload, rawId)
  const incident = id === null ? null : await getIncident(payload, id)
  if (!incident || String(relId(incident.organization)) !== String(orgId)) {
    return [t('slackApp.incidentNotFound')]
  }
  if (incident.status !== 'open') return [t('slackApp.incidentStates', { state: incident.status })]
  try {
    const summary = await acknowledge(payload, incident as MonitorIncident, {
      userId: user.id,
      via: 'slack',
    })
    await auditIncidentAction(
      payload,
      ctx.request,
      summary,
      'monitor_incident.acknowledged',
      user,
      { via: 'slack', slackUserId },
    )
    return [
      t('slackApp.acknowledged', {
        user: `<@${slackUserId}>`,
        monitor: slackEscape(summary.monitor?.name ?? ''),
      }),
      true,
    ]
  } catch (err) {
    const status = (err as { status?: number }).status
    if (status === 409) return [t('slackApp.incidentStates', { state: 'acknowledged' })]
    throw err
  }
}

// ---------------------------------------------------------------------------------------------
// Check now

async function checkNowAction(
  ctx: Ctx,
  rawId: string,
  reply: (text: string, inChannel?: boolean) => Promise<void>,
): Promise<void> {
  const { payload, installation, orgId, slackUserId, t } = ctx
  const { user, allowed } = await linkedUserWith(
    payload,
    installation,
    slackUserId,
    'monitor:update',
  )
  if (!user) return reply(t('slackApp.linkFirst'))
  if (!allowed) return reply(t('slackApp.forbidden', { name: user.name || user.email }))

  const id = parseId(payload, rawId)
  const monitor =
    id === null
      ? null
      : ((await payload
          .findByID({ collection: 'monitors', id, depth: 0, user, overrideAccess: false })
          .catch(() => null)) as Monitor | null)
  if (!monitor || String(relId(monitor.organization)) !== String(orgId)) {
    return reply(t('slackApp.monitorNotFound'))
  }
  const name = slackEscape(monitor.name)
  if (!supportsCheckNow(monitor.type) || !monitor.active || isRemoteMonitor(monitor)) {
    return reply(t('slackApp.checkUnavailable', { monitor: name }))
  }
  const budget = await onDemandCheckLimiter.consume(String(orgId))
  if (!budget.allowed) return reply(t('slackApp.checkRateLimited'))

  const waitMs = onDemandWaitMs(monitor)
  const monitorId = String(monitor.id)
  let job
  try {
    job = await enqueueOnDemandCheck(
      {
        name: MANUAL_CHECK_JOB_NAME,
        data: { monitorId, record: true, deadline: Date.now() + waitMs },
        dedupeKey: `manual-${monitorId}-record`,
      },
      waitMs,
    )
  } catch (err) {
    log.warn({ err: err instanceof Error ? err.message : String(err) }, 'check-now enqueue failed')
    return reply(t('slackApp.checkFailed', { monitor: name }))
  }
  await reply(t('slackApp.checkQueued', { monitor: name }))
  // The result arrives after Slack's three seconds: report it through the response URL.
  deferSlackTask(async () => {
    const outcome = await waitForOnDemandCheck(job, waitMs)
    if (outcome.kind === 'done') {
      const { result } = outcome
      await reply(
        t('slackApp.checkResult', {
          monitor: name,
          state: result.status,
          message: slackEscape(result.msg || '—').slice(0, 500),
          ping: result.ping === null ? '' : t('slackApp.ping', { ms: Math.round(result.ping) }),
        }),
      )
    } else if (outcome.kind === 'timeout') {
      await reply(t('slackApp.checkTimedOut', { monitor: name }))
    } else {
      await reply(t('slackApp.checkFailed', { monitor: name }))
    }
  })
}

// ---------------------------------------------------------------------------------------------
// Incident modal

const errors = (map: Record<string, string>) => ({ response_action: 'errors', errors: map })

async function submitIncidentModal(
  ctx: Ctx,
  interaction: InteractionPayload,
): Promise<Record<string, unknown> | null> {
  const { payload, installation, orgId, slackUserId, t } = ctx
  let meta: IncidentModalMeta | null = null
  try {
    meta = JSON.parse(interaction.view?.private_metadata ?? '') as IncidentModalMeta
  } catch {
    meta = null
  }
  const mode = meta?.mode
  if (!mode || !(SLACK_INCIDENT_MODES as readonly string[]).includes(mode)) return null
  const values = modalValues(interaction.view?.state?.values)
  const firstBlock = mode === 'create' ? MODAL_BLOCKS.page : MODAL_BLOCKS.incident

  const { user, allowed } = await linkedUserWith(
    payload,
    installation,
    slackUserId,
    'status-page:update',
  )
  if (!user) return errors({ [firstBlock]: t('slackApp.linkFirst') })
  if (!allowed) {
    return errors({ [firstBlock]: t('slackApp.forbidden', { name: user.name || user.email }) })
  }

  const status: IncidentStatus | null =
    mode === 'resolve'
      ? 'resolved'
      : isIncidentStatus(values[MODAL_BLOCKS.status])
        ? (values[MODAL_BLOCKS.status] as IncidentStatus)
        : null
  if (!status) return errors({ [MODAL_BLOCKS.status]: t('slackApp.modal.invalid') })
  const message = values[MODAL_BLOCKS.message] ?? ''

  try {
    const posted =
      mode === 'create'
        ? await createIncident(payload, user, orgId, values, status, message)
        : await updateIncident(payload, user, orgId, values, status, message)
    if ('error' in posted) return errors({ [posted.block]: t(posted.error) })
    await confirm(ctx, meta!.channelId, t('slackApp.incidentPosted', posted))
    return null
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'incident from slack failed',
    )
    const text = (err as { data?: { errors?: { message?: string }[] } }).data?.errors?.[0]?.message
    return errors({ [firstBlock]: text?.slice(0, 150) || t('slackApp.modal.invalid') })
  }
}

type Posted =
  | { title: string; page: string }
  | { error: 'slackApp.modal.invalid' | 'slackApp.incidentNotFound'; block: string }

async function createIncident(
  payload: Payload,
  user: RequestUser,
  orgId: string | number,
  values: Record<string, string>,
  status: IncidentStatus,
  message: string,
): Promise<Posted> {
  const title = values[MODAL_BLOCKS.title] ?? ''
  if (!title) return { error: 'slackApp.modal.invalid', block: MODAL_BLOCKS.title }
  const pageId = parseId(payload, values[MODAL_BLOCKS.page] ?? '')
  const page =
    pageId === null
      ? null
      : ((await payload
          .findByID({
            collection: 'status-pages',
            id: pageId,
            depth: 0,
            user,
            overrideAccess: false,
          })
          .catch(() => null)) as StatusPage | null)
  if (!page || String(relId(page.organization)) !== String(orgId)) {
    return { error: 'slackApp.modal.invalid', block: MODAL_BLOCKS.page }
  }
  await payload.create({
    collection: 'incidents',
    data: {
      title,
      statusPage: page.id,
      organization: orgId as Incident['organization'],
      updates: [toUpdateRow({ status, message, components: [] })],
    },
    depth: 0,
    user,
    overrideAccess: false,
  })
  return { title, page: page.title }
}

async function updateIncident(
  payload: Payload,
  user: RequestUser,
  orgId: string | number,
  values: Record<string, string>,
  status: IncidentStatus,
  message: string,
): Promise<Posted> {
  const id = parseId(payload, values[MODAL_BLOCKS.incident] ?? '')
  const incident =
    id === null
      ? null
      : ((await payload
          .findByID({ collection: 'incidents', id, depth: 1, user, overrideAccess: false })
          .catch(() => null)) as Incident | null)
  const page =
    incident && typeof incident.statusPage === 'object' ? (incident.statusPage as StatusPage) : null
  if (!incident || !page || String(relId(page.organization)) !== String(orgId)) {
    return { error: 'slackApp.incidentNotFound', block: MODAL_BLOCKS.incident }
  }
  const plain = { ...incident, statusPage: page.id } as Incident
  // The latest update's components keep their impact unless the incident is resolved.
  const last = (incident.updates ?? []).at(-1)
  const components =
    status === 'resolved'
      ? []
      : (last?.components ?? []).flatMap((row) =>
          row?.component && row.impact ? [{ component: row.component, impact: row.impact }] : [],
        )
  await postIncidentUpdate({ payload, user }, plain, { status, message, components })
  return { title: incident.title, page: page.title }
}

/** Tells the submitter (only) that the update was posted, in the channel they started from. */
async function confirm(ctx: Ctx, channelId: string | undefined, text: string): Promise<void> {
  const token = installationToken(ctx.installation)
  if (!token || !channelId) return
  await slackApi('chat.postEphemeral', token, {
    channel: channelId,
    user: ctx.slackUserId,
    text,
  }).catch(() => undefined)
}
