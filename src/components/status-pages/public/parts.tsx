'use client'

import { useFormatter, useTranslations } from 'next-intl'

import type { ComponentImpact } from '@/lib/status-page-components'
import { renderMarkdown } from '@/lib/markdown'
import { cn } from '@/lib/utils'
import type { PublicConfig, PublicIncidentUpdate } from '@/server/status-pages/public'

/*
 * Building blocks shared by the public status page, its history and the permalinks (#107).
 */

/**
 * Light and dark logos, swapped by the `dark` class (CSS only, so it follows the visitor toggle
 * without re-rendering). With a single logo it is shown in both modes.
 */
export function StatusPageLogo({
  config,
  alt = '',
  className,
}: {
  config: Pick<PublicConfig, 'logo' | 'logoDark'>
  alt?: string
  className?: string
}) {
  const { logo, logoDark } = config
  if (!logo && !logoDark) return null
  const img = (src: string, extra?: string, mode?: 'light' | 'dark') => (
    // eslint-disable-next-line @next/next/no-img-element -- user upload, arbitrary size
    <img
      src={src}
      alt={alt}
      data-logo={mode}
      className={cn('size-14 shrink-0 rounded-lg object-contain', className, extra)}
      width={56}
      height={56}
    />
  )
  if (logo && logoDark) {
    return (
      <>
        {img(logo, 'dark:hidden', 'light')}
        {img(logoDark, 'hidden dark:block', 'dark')}
      </>
    )
  }
  return img((logo ?? logoDark)!)
}

export const MARKDOWN_CLASS =
  'prose-sm max-w-none text-sm leading-relaxed [&_a]:underline [&_code]:rounded [&_code]:bg-background/60 [&_code]:px-1 [&_p+p]:mt-2 [&_ul]:list-disc [&_ul]:pl-5'

/** Badge colours per component impact (incident cards and component rows). */
export const impactStyles: Record<ComponentImpact, string> = {
  operational: 'border-status-up/40 text-status-up',
  degraded_performance: 'border-status-pending/50 text-status-pending',
  partial_outage: 'border-status-pending/50 text-status-pending',
  major_outage: 'border-status-down/40 text-status-down',
}

export function ImpactBadge({ impact, name }: { impact: ComponentImpact; name?: string }) {
  const t = useTranslations('statusPages.public')
  const label = t(`impact.${impact}`)
  return (
    <span
      data-impact={impact}
      className={cn(
        'inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium whitespace-nowrap',
        impactStyles[impact],
      )}
    >
      {name ? t('incidents.componentImpact', { name, impact: label }) : label}
    </span>
  )
}

export function IncidentUpdateEntry({ update }: { update: PublicIncidentUpdate }) {
  const t = useTranslations('statusPages.public.incidents')
  const format = useFormatter()
  return (
    <div data-update-status={update.status}>
      <p className="flex flex-wrap items-baseline gap-x-2 text-xs">
        <span className="font-semibold">{t(`status.${update.status}`)}</span>
        <time dateTime={update.postedAt} className="text-muted-foreground">
          {format.dateTime(new Date(update.postedAt), 'short')}
        </time>
        {update.editedAt && (
          <span
            className="text-muted-foreground italic"
            title={t('editedAt', { time: format.dateTime(new Date(update.editedAt), 'short') })}
          >
            ({t('edited')})
          </span>
        )}
      </p>
      {update.message && (
        <div
          className={cn('mt-1', MARKDOWN_CLASS)}
          dangerouslySetInnerHTML={{ __html: renderMarkdown(update.message) }}
        />
      )}
      {update.components.length > 0 && (
        <p className="mt-1.5 flex flex-wrap gap-1">
          {update.components.map((c) => (
            <ImpactBadge key={c.id} impact={c.impact} name={c.name} />
          ))}
        </p>
      )}
    </div>
  )
}
