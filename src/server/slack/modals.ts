/**
 * The incident modal of `/marmot incident create|update|resolve` (#129): Block Kit view and the
 * choices it offers (the organization's status pages, their active incidents), loaded with the
 * linked member's access. Submissions are handled in `./interactions.ts`.
 */
import type { Payload } from 'payload'

import { INCIDENT_STATUSES } from '@/lib/incident-timeline'
import { SLACK_INCIDENT_MODAL, type SlackIncidentMode } from '@/lib/slack-app'
import type { Incident, StatusPage } from '@/payload-types'
import type { ServerTranslator } from '@/server/i18n'
import type { RequestUser } from '@/server/monitors/http'

/** Slack allows 100 options per static select. */
const MAX_OPTIONS = 100

export interface IncidentModalChoices {
  pages: { id: string; title: string }[]
  incidents: { id: string; title: string; page: string }[]
}

export interface IncidentModalMeta {
  mode: SlackIncidentMode
  channelId: string
}

export const MODAL_BLOCKS = {
  page: 'page',
  incident: 'incident',
  title: 'title',
  status: 'status',
  message: 'message',
} as const

/** Action id of every input in the modal (block ids tell them apart). */
export const MODAL_ACTION = 'value'

export async function incidentModalChoices(
  payload: Payload,
  user: RequestUser,
  orgId: string | number,
): Promise<IncidentModalChoices> {
  const { docs: pages } = await payload.find({
    collection: 'status-pages',
    where: { organization: { equals: orgId } },
    sort: 'title',
    depth: 0,
    limit: MAX_OPTIONS,
    user,
    overrideAccess: false,
    select: { title: true },
  })
  const titles = new Map((pages as StatusPage[]).map((page) => [String(page.id), page.title]))
  const { docs: incidents } =
    pages.length === 0
      ? { docs: [] }
      : await payload.find({
          collection: 'incidents',
          where: {
            and: [
              { statusPage: { in: pages.map((page) => page.id) } },
              { active: { equals: true } },
            ],
          },
          sort: '-createdAt',
          depth: 0,
          limit: MAX_OPTIONS,
          user,
          overrideAccess: false,
          select: { title: true, statusPage: true },
        })
  return {
    pages: (pages as StatusPage[]).map((page) => ({ id: String(page.id), title: page.title })),
    incidents: (incidents as Incident[]).map((incident) => {
      const pageId =
        typeof incident.statusPage === 'object' ? incident.statusPage.id : incident.statusPage
      return {
        id: String(incident.id),
        title: incident.title,
        page: titles.get(String(pageId)) ?? '',
      }
    }),
  }
}

const plain = (text: string) => ({ type: 'plain_text', text: text.slice(0, 75), emoji: true })

const option = (value: string, text: string) => ({ text: plain(text), value })

function select(
  blockId: string,
  label: string,
  options: { text: unknown; value: string }[],
  initial?: { text: unknown; value: string },
) {
  return {
    type: 'input',
    block_id: blockId,
    label: plain(label),
    element: {
      type: 'static_select',
      action_id: MODAL_ACTION,
      options,
      ...(initial ? { initial_option: initial } : {}),
    },
  }
}

export function incidentModal(
  t: ServerTranslator,
  mode: SlackIncidentMode,
  choices: IncidentModalChoices,
  meta: { channelId: string },
): Record<string, unknown> {
  const statuses = INCIDENT_STATUSES.map((status) =>
    option(status, t('slackApp.modal.statuses', { status })),
  )
  const blocks: unknown[] = []
  if (mode === 'create') {
    blocks.push(
      select(
        MODAL_BLOCKS.page,
        t('slackApp.modal.page'),
        choices.pages.map((page) => option(page.id, page.title)),
      ),
      {
        type: 'input',
        block_id: MODAL_BLOCKS.title,
        label: plain(t('slackApp.modal.title')),
        element: { type: 'plain_text_input', action_id: MODAL_ACTION, max_length: 200 },
      },
    )
  } else {
    blocks.push(
      select(
        MODAL_BLOCKS.incident,
        t('slackApp.modal.incident'),
        choices.incidents.map((incident) =>
          option(
            incident.id,
            incident.page ? `${incident.page}: ${incident.title}` : incident.title,
          ),
        ),
      ),
    )
  }
  if (mode !== 'resolve') {
    blocks.push(
      select(
        MODAL_BLOCKS.status,
        t('slackApp.modal.status'),
        statuses.filter((s) => s.value !== 'resolved' || mode === 'update'),
        statuses[0],
      ),
    )
  }
  blocks.push({
    type: 'input',
    block_id: MODAL_BLOCKS.message,
    label: plain(t('slackApp.modal.message')),
    optional: mode === 'resolve',
    element: {
      type: 'plain_text_input',
      action_id: MODAL_ACTION,
      multiline: true,
      max_length: 3000,
    },
  })
  const meta_: IncidentModalMeta = { mode, channelId: meta.channelId }
  return {
    type: 'modal',
    callback_id: SLACK_INCIDENT_MODAL,
    private_metadata: JSON.stringify(meta_),
    title: plain(t('slackApp.modal.titles', { mode })),
    submit: plain(t('slackApp.modal.submit')),
    close: plain(t('slackApp.modal.cancel')),
    blocks,
  }
}

type StateValues = Record<
  string,
  Record<string, { value?: string | null; selected_option?: { value?: string } | null }>
>

/** The submitted values of the modal, by block id. */
export function modalValues(values: StateValues | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [blockId, actions] of Object.entries(values ?? {})) {
    const input = actions?.[MODAL_ACTION]
    const value = input?.selected_option?.value ?? input?.value ?? ''
    if (typeof value === 'string') out[blockId] = value.trim()
  }
  return out
}
