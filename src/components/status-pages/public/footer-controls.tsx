'use client'

import { Clock, Languages } from 'lucide-react'
import { useTimeZone, useTranslations } from 'next-intl'

import { STATUS_LOCALE_COOKIE, STATUS_LOCALE_COOKIE_MAX_AGE } from '@/lib/status-page-locales'
import { cn } from '@/lib/utils'

import { useStatusPageI18n } from './intl-provider'
import {
  chooseTimeZone,
  useBrowserTimeZone,
  useTimeZoneChoice,
  type TimeZoneChoice,
} from './visitor-time-zone'

/**
 * Remembers the visitor's language so the page's plain URL no longer redirects them by
 * `Accept-Language` (and sends them to their language on the next visit).
 */
function rememberLocale(locale: string) {
  document.cookie = `${STATUS_LOCALE_COOKIE}=${encodeURIComponent(locale)}; Path=/; Max-Age=${STATUS_LOCALE_COOKIE_MAX_AGE}; SameSite=Lax`
}

/**
 * Language switcher of a public status page: plain links to the current view in every offered
 * language (they work without JavaScript and carry `hreflang`), the current one marked.
 */
export function LocaleSwitcher({ className }: { className?: string }) {
  const i18n = useStatusPageI18n()
  const t = useTranslations('statusPages.localeSwitcher')
  if (!i18n || i18n.alternates.length < 2) return null
  return (
    <nav aria-label={t('label')} className={cn('flex items-center gap-1.5', className)}>
      <Languages className="size-3.5 shrink-0" aria-hidden />
      <ul className="flex flex-wrap items-center gap-x-2 gap-y-1" data-locale-switcher>
        {i18n.alternates.map((alternate) => (
          <li key={alternate.locale}>
            {alternate.locale === i18n.locale ? (
              <span aria-current="true" lang={alternate.locale} className="text-foreground">
                {alternate.name}
              </span>
            ) : (
              <a
                href={alternate.href}
                hrefLang={alternate.locale}
                lang={alternate.locale}
                onClick={() => rememberLocale(alternate.locale)}
                className="hover:text-foreground"
              >
                {alternate.name}
              </a>
            )}
          </li>
        ))}
      </ul>
    </nav>
  )
}

/**
 * Says which time zone the page's times are in and, once hydrated and when the visitor's zone
 * differs from the page's, lets the visitor switch between the two.
 */
export function TimeZoneSwitcher({ className }: { className?: string }) {
  const i18n = useStatusPageI18n()
  const t = useTranslations('statusPages.timeZone')
  const zone = useTimeZone() ?? i18n?.pageTimeZone ?? 'UTC'
  const browser = useBrowserTimeZone()
  const choice = useTimeZoneChoice()
  if (!i18n) return null
  const switchable = browser !== null && browser !== i18n.pageTimeZone
  const value: TimeZoneChoice = choice ?? (i18n.followVisitor ? 'visitor' : 'page')
  return (
    <span className={cn('flex items-center gap-1.5', className)} data-time-zone={zone}>
      <Clock className="size-3.5 shrink-0" aria-hidden />
      <span>{t('notice', { zone })}</span>
      {switchable && (
        <select
          aria-label={t('label')}
          value={value}
          onChange={(event) => chooseTimeZone(event.target.value as TimeZoneChoice)}
          className="max-w-48 cursor-pointer truncate rounded-sm border bg-transparent px-1 py-0.5 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          <option value="visitor">{t('visitor', { zone: browser })}</option>
          <option value="page">{t('page', { zone: i18n.pageTimeZone })}</option>
        </select>
      )}
    </span>
  )
}
