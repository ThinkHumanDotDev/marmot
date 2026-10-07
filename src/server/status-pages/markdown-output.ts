/**
 * Plain Markdown views of a status page for LLM agents and terminals: the page (`/status/<slug>.md`),
 * an incident or maintenance window (`<permalink>.md`, the #107 permalinks
 * `/status/<slug>/events/<kind>/<publicId>`) and `llms.txt` (https://llmstxt.org), which
 * describes the page and links every machine-readable endpoint. Text is rendered in the page's
 * locale with times in the organization's zone. Incident and maintenance text is the author's
 * Markdown, passed through as is.
 */
import type { Payload } from 'payload'

import { getStaticFormatter, getTranslator } from '@/i18n/translator'
import type { Locale } from '@/i18n/locales'
import { statusPageTimeZone } from '@/i18n/resolve'
import type { OccurrenceState, OccurrenceUpdate } from '@/lib/maintenance-announcements'
import type { StatusPage } from '@/payload-types'
import type { PublicMaintenance } from '@/server/maintenance/status-page'

import { announcedMaintenance, listMaintenanceEvents } from './maintenance-events'
import {
  buildPublicGroups,
  componentNamesOf,
  findActiveIncidents,
  pageOverallStatus,
  toPublicIncident,
  type PublicIncident,
} from './public'
import { componentStatus } from './statuspage'
import { STATUSPAGE_ENDPOINTS, type StatusPageLinks } from './urls'

/** Backslash-escapes Markdown syntax in plain text (titles, names). */
export const escapeMarkdown = (value: string): string =>
  value.replace(/[\\`*_[\]<>#|]/g, (c) => `\\${c}`).replace(/\r?\n/g, ' ')

export interface MarkdownInput {
  payload: Payload
  page: StatusPage
  links: StatusPageLinks
  locale: Locale
  now?: Date
}

const tools = (page: StatusPage, locale: Locale) => {
  const t = getTranslator(locale)
  const format = getStaticFormatter(locale, statusPageTimeZone(page))
  const time = (value: string) => format.dateTime(new Date(value), 'zoned')
  return { t, time }
}

type Tools = ReturnType<typeof tools>

function incidentSection(
  incident: PublicIncident,
  { t, time }: Tools,
  heading: '###' | '####',
): string[] {
  const out: string[] = []
  for (const update of incident.updates) {
    out.push(
      `${heading} ${escapeMarkdown(t(`statusPages.public.incidents.status.${update.status}`))} · ${time(update.postedAt)}`,
      '',
    )
    if (update.message.trim()) out.push(update.message.trim(), '')
    if (update.components.length > 0) {
      out.push(
        `_${escapeMarkdown(
          t('statusPages.public.incidents.affected', {
            components: update.components
              .map((c) =>
                t('statusPages.public.incidents.componentImpact', {
                  name: c.name,
                  impact: t(`statusPages.public.impact.${c.impact}`),
                }),
              )
              .join(', '),
          }),
        )}_`,
        '',
      )
    }
    if (update.editedAt) {
      out.push(
        `_${escapeMarkdown(t('statusPages.public.incidents.editedAt', { time: time(update.editedAt) }))}_`,
        '',
      )
    }
  }
  return out
}

interface MaintenanceView {
  state: OccurrenceState
  start: string | null
  end: string | null
  description: string | null
  /** Newest first. */
  updates: OccurrenceUpdate[]
}

/** Status and window of a maintenance occurrence, as list items. */
function maintenanceFacts(view: MaintenanceView, { t, time }: Tools): string[] {
  const when =
    view.start && view.end
      ? t('statusPages.machine.markdown.window', { start: time(view.start), end: time(view.end) })
      : t('statusPages.machine.markdown.untilFurtherNotice')
  return [
    `- ${escapeMarkdown(t('statusPages.machine.markdown.status'))}: ${escapeMarkdown(
      t(`statusPages.public.maintenance.state.${view.state}`),
    )}`,
    `- ${escapeMarkdown(t('statusPages.machine.markdown.when'))}: ${escapeMarkdown(when)}`,
  ]
}

/** Timeline of a maintenance occurrence (newest first). */
function maintenanceUpdates(
  updates: readonly OccurrenceUpdate[],
  { t, time }: Tools,
  heading: '###' | '####',
): string[] {
  return updates.flatMap((update) => [
    `${heading} ${escapeMarkdown(t(`statusPages.public.maintenance.state.${update.status}`))} · ${time(update.postedAt)}`,
    '',
    update.message.trim() ||
      escapeMarkdown(t(`statusPages.public.maintenance.defaultMessage.${update.status}`)),
    '',
  ])
}

/** The whole page: overall status, components, ongoing incidents, maintenance and links. */
export async function renderPageMarkdown({
  payload,
  page,
  links,
  locale,
  now = new Date(),
}: MarkdownInput): Promise<string> {
  const helpers = tools(page, locale)
  const { t } = helpers
  const [incidents, events] = await Promise.all([
    findActiveIncidents(payload, page.id),
    listMaintenanceEvents(payload, page.id, { now }),
  ])
  const groups = await buildPublicGroups(payload, page, { incidents })
  const names = componentNamesOf(groups)
  const active = incidents.map((incident) => toPublicIncident(incident, names))
  const overall = pageOverallStatus(groups, active)
  const maintenance = await announcedMaintenance(payload, page, events, now)

  const out: string[] = [`# ${escapeMarkdown(page.title)}`, '']
  if (page.description?.trim()) out.push(page.description.trim(), '')
  out.push(
    `**${escapeMarkdown(t('statusPages.machine.markdown.currentStatus'))}:** ${escapeMarkdown(
      page.bannerText?.trim() || t(`statusPages.overall.${overall}`),
    )}`,
    '',
  )

  out.push(`## ${escapeMarkdown(t('statusPages.sections.services'))}`, '')
  if (groups.every((g) => g.monitors.length === 0)) {
    out.push(escapeMarkdown(t('statusPages.monitors.empty')), '')
  }
  for (const group of groups) {
    if (group.monitors.length === 0) continue
    out.push(`### ${escapeMarkdown(group.name)}`, '')
    for (const row of group.monitors) {
      const label = t(`statusPages.machine.componentStatus.${componentStatus(row)}`)
      out.push(`- ${escapeMarkdown(row.name)}: ${escapeMarkdown(label)}`)
    }
    out.push('')
  }

  out.push(`## ${escapeMarkdown(t('statusPages.sections.ongoingIncidents'))}`, '')
  if (active.length === 0) {
    out.push(escapeMarkdown(t('statusPages.machine.markdown.noIncidents')), '')
  }
  for (const incident of active) {
    out.push(
      `### [${escapeMarkdown(incident.title)}](${links.event('incident', incident.publicId)})`,
      '',
      `- ${escapeMarkdown(t('statusPages.machine.markdown.status'))}: ${escapeMarkdown(
        t(`statusPages.public.incidents.status.${incident.status}`),
      )}`,
      `- ${escapeMarkdown(t('statusPages.machine.markdown.impact'))}: ${escapeMarkdown(
        t(`statusPages.public.impact.${incident.impact}`),
      )}`,
      `- ${escapeMarkdown(t('statusPages.machine.markdown.details'))}: ${links.eventMarkdown('incident', incident.publicId)}`,
      '',
    )
    out.push(...incidentSection(incident, helpers, '####'))
  }

  out.push(`## ${escapeMarkdown(t('statusPages.sections.maintenance'))}`, '')
  if (maintenance.length === 0) {
    out.push(escapeMarkdown(t('statusPages.machine.markdown.noMaintenance')), '')
  }
  for (const event of maintenance) {
    out.push(
      `### [${escapeMarkdown(event.title)}](${links.event('maintenance', event.publicId)})`,
      '',
      ...maintenanceFacts(event, helpers),
      `- ${escapeMarkdown(t('statusPages.machine.markdown.details'))}: ${links.eventMarkdown('maintenance', event.publicId)}`,
      '',
      ...(event.description ? [event.description, ''] : []),
      ...maintenanceUpdates(event.updates.slice().reverse(), helpers, '####'),
    )
  }

  out.push(
    '---',
    '',
    `${escapeMarkdown(t('statusPages.machine.markdown.machineReadable'))}: [summary.json](${links.api('summary')}) · [Atom](${links.atom}) · [JSON Feed](${links.jsonFeed}) · [RSS](${links.rss}) · [iCalendar](${links.calendar}) · [llms.txt](${links.llms})`,
    '',
  )
  return out.join('\n')
}

/** One incident with its full timeline (newest update first), for its permalink's `.md`. */
export function renderIncidentMarkdown(
  page: StatusPage,
  view: PublicIncident,
  links: StatusPageLinks,
  locale: Locale,
): string {
  const helpers = tools(page, locale)
  const { t, time } = helpers
  const startedAt = view.updates.at(-1)?.postedAt ?? view.createdAt
  const out: string[] = [
    `# ${escapeMarkdown(view.title)}`,
    '',
    `- ${escapeMarkdown(t('statusPages.machine.markdown.status'))}: ${escapeMarkdown(
      t(`statusPages.public.incidents.status.${view.status}`),
    )}`,
    `- ${escapeMarkdown(t('statusPages.machine.markdown.impact'))}: ${escapeMarkdown(
      t(`statusPages.public.impact.${view.impact}`),
    )}`,
    `- ${escapeMarkdown(t('statusPages.machine.markdown.started'))}: ${time(startedAt)}`,
  ]
  if (view.resolvedAt) {
    out.push(
      `- ${escapeMarkdown(t('statusPages.machine.markdown.resolved'))}: ${time(view.resolvedAt)}`,
    )
  }
  if (view.components.length > 0) {
    out.push(
      `- ${escapeMarkdown(t('statusPages.public.incidents.affectedLabel'))}: ${escapeMarkdown(
        view.components
          .map((c) =>
            t('statusPages.public.incidents.componentImpact', {
              name: c.name,
              impact: t(`statusPages.public.impact.${c.impact}`),
            }),
          )
          .join(', '),
      )}`,
    )
  }
  out.push(
    `- ${escapeMarkdown(t('statusPages.machine.markdown.statusPage'))}: [${escapeMarkdown(page.title)}](${links.page})`,
    '',
    `## ${escapeMarkdown(t('statusPages.machine.markdown.updates'))}`,
    '',
    ...incidentSection(view, helpers, '###'),
  )
  return out.join('\n')
}

/** One maintenance occurrence with its timeline, for its permalink's `.md`. */
export function renderMaintenanceMarkdown(
  page: StatusPage,
  view: PublicMaintenance,
  links: StatusPageLinks,
  locale: Locale,
): string {
  const helpers = tools(page, locale)
  const { t } = helpers
  return [
    `# ${escapeMarkdown(view.title)}`,
    '',
    ...maintenanceFacts(view, helpers),
    `- ${escapeMarkdown(t('statusPages.machine.markdown.statusPage'))}: [${escapeMarkdown(page.title)}](${links.page})`,
    '',
    ...(view.description ? [view.description, ''] : []),
    `## ${escapeMarkdown(t('statusPages.machine.markdown.updates'))}`,
    '',
    ...maintenanceUpdates(view.updates, helpers, '###'),
  ].join('\n')
}

/** `llms.txt`: what the page is, its current state, and links to every machine-readable view. */
export async function renderLlmsTxt({
  payload,
  page,
  links,
  locale,
}: MarkdownInput): Promise<string> {
  const { t } = tools(page, locale)
  const incidents = await findActiveIncidents(payload, page.id)
  const groups = await buildPublicGroups(payload, page, { incidents })
  const names = componentNamesOf(groups)
  const overall = pageOverallStatus(
    groups,
    incidents.map((incident) => toPublicIncident(incident, names)),
  )
  const link = (label: string, url: string, description: string) =>
    `- [${escapeMarkdown(label)}](${url}): ${escapeMarkdown(description)}`
  const api = (name: (typeof STATUSPAGE_ENDPOINTS)[number]) =>
    link(`${name}.json`, links.api(name), t(`statusPages.machine.llms.api.${name}`))

  const summary = page.description?.trim()
    ? page.description.trim().replace(/\s*\n\s*/g, ' ')
    : t('statusPages.machine.llms.summary', { title: page.title })

  return [
    `# ${escapeMarkdown(page.title)}`,
    '',
    `> ${summary}`,
    '',
    escapeMarkdown(
      t('statusPages.machine.llms.currentStatus', {
        status: page.bannerText?.trim() || t(`statusPages.overall.${overall}`),
      }),
    ),
    escapeMarkdown(t('statusPages.machine.llms.incidentMarkdown')),
    '',
    `## ${escapeMarkdown(t('statusPages.machine.llms.statusSection'))}`,
    '',
    link(
      t('statusPages.machine.llms.markdownLabel'),
      links.markdown,
      t('statusPages.machine.llms.markdown'),
    ),
    ...STATUSPAGE_ENDPOINTS.map(api),
    '',
    `## ${escapeMarkdown(t('statusPages.machine.llms.feedsSection'))}`,
    '',
    link('Atom', links.atom, t('statusPages.machine.llms.atom')),
    link('JSON Feed', links.jsonFeed, t('statusPages.machine.llms.jsonFeed')),
    link('RSS', links.rss, t('statusPages.machine.llms.rss')),
    link('iCalendar', links.calendar, t('statusPages.machine.llms.calendar')),
    '',
    `## Optional`,
    '',
    link('OpenAPI', links.openapi, t('statusPages.machine.llms.openapi')),
    link(page.title, links.page, t('statusPages.machine.llms.page')),
    link(
      t('statusPages.machine.llms.eventsLabel'),
      links.events,
      t('statusPages.machine.llms.events'),
    ),
    '',
  ].join('\n')
}
