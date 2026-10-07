/**
 * Plain Markdown views of a status page for LLM agents and terminals: the page (`/status/<slug>.md`),
 * an incident (`/status/<slug>/incidents/<id>.md`) and `llms.txt` (https://llmstxt.org), which
 * describes the page and links every machine-readable endpoint. Text is rendered in the page's
 * locale with times in the organization's zone. Incident and maintenance text is the author's
 * Markdown, passed through as is.
 */
import type { Payload } from 'payload'

import { getStaticFormatter, getTranslator } from '@/i18n/translator'
import type { Locale } from '@/i18n/locales'
import { statusPageTimeZone } from '@/i18n/resolve'
import type { Incident, StatusPage } from '@/payload-types'

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

/** The whole page: overall status, components, ongoing incidents, maintenance and links. */
export async function renderPageMarkdown({
  payload,
  page,
  links,
  locale,
  now = new Date(),
}: MarkdownInput): Promise<string> {
  const helpers = tools(page, locale)
  const { t, time } = helpers
  const [incidents, events] = await Promise.all([
    findActiveIncidents(payload, page.id),
    listMaintenanceEvents(payload, page.id, { now }),
  ])
  const groups = await buildPublicGroups(payload, page, { incidents })
  const names = componentNamesOf(groups)
  const active = incidents.map((incident) => toPublicIncident(incident, names))
  const overall = pageOverallStatus(groups, active)
  const maintenance = announcedMaintenance(events, now)

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
      `### [${escapeMarkdown(incident.title)}](${links.incident(incident.id)})`,
      '',
      `- ${escapeMarkdown(t('statusPages.machine.markdown.status'))}: ${escapeMarkdown(
        t(`statusPages.public.incidents.status.${incident.status}`),
      )}`,
      `- ${escapeMarkdown(t('statusPages.machine.markdown.impact'))}: ${escapeMarkdown(
        t(`statusPages.public.impact.${incident.impact}`),
      )}`,
      `- ${escapeMarkdown(t('statusPages.machine.markdown.details'))}: ${links.incidentMarkdown(incident.id)}`,
      '',
    )
    out.push(...incidentSection(incident, helpers, '####'))
  }

  out.push(`## ${escapeMarkdown(t('statusPages.sections.maintenance'))}`, '')
  if (maintenance.length === 0) {
    out.push(escapeMarkdown(t('statusPages.machine.markdown.noMaintenance')), '')
  }
  for (const event of maintenance) {
    const when =
      event.start && event.end
        ? t('statusPages.machine.markdown.window', {
            start: time(event.start),
            end: time(event.end),
          })
        : t('statusPages.machine.markdown.untilFurtherNotice')
    out.push(
      `### ${escapeMarkdown(event.title)}`,
      '',
      `- ${escapeMarkdown(t('statusPages.machine.markdown.status'))}: ${escapeMarkdown(
        t(`statusPages.machine.maintenanceStatus.${event.status}`),
      )}`,
      `- ${escapeMarkdown(t('statusPages.machine.markdown.when'))}: ${escapeMarkdown(when)}`,
      '',
    )
    if (event.description) out.push(event.description, '')
  }

  out.push(
    '---',
    '',
    `${escapeMarkdown(t('statusPages.machine.markdown.machineReadable'))}: [summary.json](${links.api('summary')}) · [Atom](${links.atom}) · [JSON Feed](${links.jsonFeed}) · [RSS](${links.rss}) · [iCalendar](${links.calendar}) · [llms.txt](${links.llms})`,
    '',
  )
  return out.join('\n')
}

/** One incident with its full timeline (newest update first). */
export function renderIncidentMarkdown(
  page: StatusPage,
  incident: Incident,
  names: ReadonlyMap<string, string>,
  links: StatusPageLinks,
  locale: Locale,
): string {
  const helpers = tools(page, locale)
  const { t, time } = helpers
  const view = toPublicIncident(incident, names)
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
    '',
  ].join('\n')
}
