'use client'

import { useTranslations } from 'next-intl'
import type * as React from 'react'

import { PastIncidents } from '@/components/status-pages/public/event-list'
import { MaintenanceCard } from '@/components/status-pages/public/maintenance-card'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { EmbedSection } from '@/lib/status-page-embed'
import { EVENTS_PATH, eventPath, type EventKind } from '@/lib/status-page-events'
import type { PublicStatusPageData } from '@/server/status-pages/public'

import { GroupSection, IncidentCard, OverallBanner } from './status-page-view'
import { useLiveStatus } from './use-live-status'

/**
 * Every link of an embedded page opens in a new tab, never inside the host site's frame: the target
 * is set just before the browser follows the link (click, Enter, or a middle click's auxclick).
 */
function openLinksInNewTab(event: React.MouseEvent<HTMLElement>) {
  const target = event.target instanceof Element ? event.target : null
  const link = target?.closest<HTMLAnchorElement>('a[href]')
  if (!link || link.target === '_blank') return
  link.target = '_blank'
  link.rel = 'noopener noreferrer'
}

/**
 * Embed mode of a public status page (`?embed=all` or `?embed=banner,components,…`, #109): the chosen
 * sections without the header and footer, refreshed on the page's interval like the page itself.
 */
export function StatusPageEmbed({
  slug,
  initial,
  basePath,
  sections,
}: {
  slug: string
  initial: PublicStatusPageData
  /** `/status/<slug>`, or `''` on a custom domain. */
  basePath: string
  sections: readonly EmbedSection[]
}) {
  const t = useTranslations('statusPages')
  const { data } = useLiveStatus(slug, initial)
  const { config, groups, incidents, overall, maintenance } = data
  const show = (section: EmbedSection) => sections.includes(section)
  const link = (kind: EventKind, publicId: string) => `${basePath}${eventPath(kind, publicId)}`

  return (
    <TooltipProvider delayDuration={200}>
      <div
        className="flex w-full flex-col gap-4 p-3 sm:p-4"
        data-embed={sections.join(',')}
        onClickCapture={openLinksInNewTab}
        onAuxClickCapture={openLinksInNewTab}
      >
        {show('banner') && <OverallBanner status={overall} text={config.bannerText} />}

        {show('maintenance') && maintenance.length > 0 && (
          <section aria-label={t('sections.maintenance')} className="flex flex-col gap-3">
            {maintenance.map((item) => (
              <MaintenanceCard
                key={item.id}
                item={item}
                href={link('maintenance', item.publicId)}
              />
            ))}
          </section>
        )}

        {show('incidents') && incidents.length > 0 && (
          <section aria-label={t('sections.incidents')} className="flex flex-col gap-3">
            {incidents.map((incident) => (
              <IncidentCard
                key={incident.id}
                incident={incident}
                href={link('incident', incident.publicId)}
              />
            ))}
          </section>
        )}

        {show('components') &&
          (groups.length === 0 ? (
            <p className="rounded-xl border border-dashed px-5 py-6 text-center text-sm text-muted-foreground">
              {t('monitors.empty')}
            </p>
          ) : (
            <section aria-label={t('sections.services')} className="flex flex-col gap-3">
              {groups.map((group, i) => (
                <GroupSection key={`${group.name}-${i}`} group={group} />
              ))}
            </section>
          ))}

        {show('history') && data.pastIncidentsDays > 0 && (
          <PastIncidents
            days={data.pastIncidents}
            historyHref={`${basePath}${EVENTS_PATH}`}
            basePath={basePath}
          />
        )}
      </div>
    </TooltipProvider>
  )
}
