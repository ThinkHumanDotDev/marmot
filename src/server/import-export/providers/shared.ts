/**
 * Helpers shared by the provider importers (#120): status page defaults, time handling and the
 * subscriber checks. Pure: no database or network access.
 */
import { BANNER_TEXT_MAX_LENGTH } from '@/collections/status-page-theme'
import type { ImportResource } from '@/lib/import-export'
import { maskTarget, normalizeTarget, type SubscriberChannel } from '@/lib/status-page-subscribers'
import { DEFAULT_THEME_PRESET } from '@/lib/status-page-themes'
import { slugify } from '@/lib/slugify'

import type { ImportText } from '../text'
import type {
  ImportPlan,
  PlannedStatusPage,
  PlannedStatusPageFields,
  PlannedSubscriber,
} from '../types'
import type { FetchLike } from './fetch'

export type Credentials = Record<string, string>

export interface ImportProvider<Snapshot = unknown> {
  /** Product name used in messages. */
  label: string
  /** Reads everything `resources` needs from the provider's API. Throws `ProviderError`. */
  fetch(
    credentials: Credentials,
    resources: ReadonlySet<ImportResource>,
    fetchImpl: FetchLike,
  ): Promise<Snapshot>
  /** Maps a snapshot onto an import plan. Pure. */
  plan(
    snapshot: Snapshot,
    resources: ReadonlySet<ImportResource>,
    t: ImportText,
    now?: Date,
  ): ImportPlan
}

export const issueList = (issues: { path: PropertyKey[]; message: string }[]): string =>
  issues
    .map((issue) =>
      issue.path.length ? `${issue.path.join('.')}: ${issue.message}` : issue.message,
    )
    .join('; ')

/** Status page fields of an imported page; everything the source has no equivalent for is default. */
export function providerPageFields(
  fields: Pick<PlannedStatusPageFields, 'title' | 'slug'> & Partial<PlannedStatusPageFields>,
): PlannedStatusPageFields {
  const slug = slugify(fields.slug || fields.title) || 'status'
  return {
    description: null,
    homepageUrl: null,
    contactUrl: null,
    theme: 'auto',
    themePreset: DEFAULT_THEME_PRESET,
    themeOverrides: null,
    // Imported pages start unpublished so they can be reviewed before visitors see them.
    published: false,
    searchEngineIndex: false,
    showTags: false,
    showCertificateExpiry: false,
    showPoweredBy: true,
    showValues: true,
    autoRefreshInterval: 300,
    footerText: null,
    customCSS: null,
    googleAnalyticsId: null,
    ...fields,
    title: fields.title.slice(0, 200),
    slug,
    bannerText: fields.bannerText?.trim().slice(0, BANNER_TEXT_MAX_LENGTH) || null,
  }
}

/** ISO time of `value`, or `null` when it is missing or unparsable. */
export function isoTime(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null
  const time = new Date(value)
  return Number.isNaN(time.getTime()) ? null : time.toISOString()
}

/** Incident updates may not lie in the future (the collection refuses them). */
export const notAfter = (iso: string, now: Date): string =>
  new Date(iso).getTime() > now.getTime() ? now.toISOString() : iso

/** Hostname of a custom domain value (`status.example.com`, with or without scheme). */
export function hostnameOf(value: string | null): string | null {
  if (!value) return null
  try {
    const url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`)
    return url.hostname.toLowerCase() || null
  } catch {
    return null
  }
}

/**
 * Adds a subscriber to `page` after normalising its target; invalid and duplicate targets are
 * skipped with a reason.
 */
export function addSubscriber(
  plan: ImportPlan,
  page: PlannedStatusPage,
  seen: Set<string>,
  subscriber: { channel: SubscriberChannel; target: string; componentKeys: string[] | null },
  t: ImportText,
): void {
  // Reports are shown and logged: addresses appear masked.
  const name = maskTarget(subscriber.channel, subscriber.target)
  const check = normalizeTarget(subscriber.channel, subscriber.target)
  if (!check.ok) {
    plan.skipped.subscribers.push({
      name,
      reason: t('subscriberInvalid', { channel: subscriber.channel }),
    })
    return
  }
  const id = `${subscriber.channel}:${check.target}`
  if (seen.has(id)) {
    plan.skipped.subscribers.push({ name, reason: t('subscriberDuplicate') })
    return
  }
  seen.add(id)
  const planned: PlannedSubscriber = {
    channel: subscriber.channel,
    target: check.target,
    componentKeys: subscriber.componentKeys,
  }
  ;(page.subscribers ??= []).push(planned)
}
