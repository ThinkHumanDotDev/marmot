/**
 * Domain registration expiry via RDAP.
 *
 * Inspired by Uptime Kuma 2.5.5 `server/model/domain_expiry.js` — Copyright (c) 2021 Louis Lam,
 * MIT License. See THIRD_PARTY_NOTICES.md. Marmot asks the public `rdap.org` bootstrap (which
 * redirects to the registry's RDAP server) instead of shipping IANA's bootstrap file, and finds the
 * registrable domain by retrying with one label less whenever the registry answers 404
 * (`www.example.com` → `example.com`) instead of depending on a public-suffix list.
 *
 * The lookup result is cached on the monitor (`monitors.domainExpiry`) and refreshed at most once a
 * day (once an hour after a failed lookup). Warnings follow the same threshold/history rules as the
 * certificate ones: `[name][target] Domain name <domain> will expire in N days`.
 */
import net from 'node:net'

import { defaultLocale, type Locale } from '@/i18n/locales'
import { childLogger } from '@/lib/logger'
import type { Monitor } from '@/payload-types'
import { daysUntil } from '@/server/engine/tls'
import { serverTranslator } from '@/server/i18n'
import type { ExpirySender } from './cert-expiry'
import { sortedThresholds, type SentHistoryStore } from './expiry-history'

const log = childLogger('expiry:domain')

export const RDAP_BOOTSTRAP_URL = 'https://rdap.org/domain/'
export const DOMAIN_EXPIRY_RECHECK_MS = 24 * 60 * 60 * 1000
export const DOMAIN_EXPIRY_RETRY_MS = 60 * 60 * 1000
/** How many parent domains to try after the full hostname (`a.b.example.com` → `example.com`). */
export const MAX_RDAP_ATTEMPTS = 4

/** What `monitors.domainExpiry` stores. */
export interface DomainExpiryInfo {
  /** Hostname of the monitor's target the lookup was made for (cache key). */
  host: string
  /** Registrable domain the registry answered for (`www.example.com` → `example.com`). */
  domain: string
  /** ISO timestamp, null when the registry publishes no expiration event. */
  expiresAt: string | null
  /** Whole days until `expiresAt` at the time of the check (negative once expired). */
  daysRemaining: number | null
  /** ISO timestamp of the lookup. */
  checkedAt: string
  /** Why the lookup produced no date (unsupported TLD, network error, …). */
  error: string | null
}

export type DomainMonitorSource = Pick<Monitor, 'type' | 'url' | 'hostname'>

const LOCAL_SUFFIXES = ['.localhost', '.local', '.internal', '.lan', '.home', '.arpa', '.test']

/**
 * Hostname of the monitor's target, lower-cased, or null when it is not a public domain name
 * (IP addresses, single-label and reserved local names).
 */
export function extractDomain(monitor: DomainMonitorSource): string | null {
  let host: string | null = null
  if (monitor.url && ['http', 'keyword', 'json-query'].includes(monitor.type)) {
    try {
      host = new URL(monitor.url).hostname
    } catch {
      return null
    }
  } else if (monitor.hostname && ['port', 'ping', 'dns'].includes(monitor.type)) {
    host = monitor.hostname
  }
  if (!host) return null
  host = host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '')
  if (!host || net.isIP(host) || !host.includes('.')) return null
  if (LOCAL_SUFFIXES.some((suffix) => host!.endsWith(suffix))) return null
  if (!/^[a-z0-9.-]+$/.test(host)) return null
  return host
}

/** Full hostname first, then its parents down to two labels, at most `MAX_RDAP_ATTEMPTS`. */
export function domainCandidates(host: string): string[] {
  const labels = host.split('.')
  const out: string[] = []
  for (let i = 0; i < labels.length - 1 && out.length < MAX_RDAP_ATTEMPTS; i += 1) {
    out.push(labels.slice(i).join('.'))
  }
  return out
}

/** The `expiration` event date of an RDAP domain object, or null. */
export function parseRdapExpiry(body: unknown): Date | null {
  if (!body || typeof body !== 'object') return null
  const events = (body as { events?: unknown }).events
  if (!Array.isArray(events)) return null
  for (const event of events) {
    if (!event || typeof event !== 'object') continue
    const { eventAction, eventDate } = event as { eventAction?: unknown; eventDate?: unknown }
    if (eventAction === 'expiration' && typeof eventDate === 'string') {
      const date = new Date(eventDate)
      if (!Number.isNaN(date.getTime())) return date
    }
  }
  return null
}

export interface LookupOptions {
  fetchImpl?: typeof fetch
  signal?: AbortSignal
  timeoutMs?: number
  now?: Date
  bootstrapUrl?: string
}

/**
 * Query RDAP for `host`, walking up to the registrable domain. Never throws: failures are reported
 * in `error` so they can be cached and retried later.
 */
export async function lookupDomainExpiry(
  host: string,
  options: LookupOptions = {},
): Promise<DomainExpiryInfo> {
  const fetchImpl = options.fetchImpl ?? fetch
  const now = options.now ?? new Date()
  const bootstrap = options.bootstrapUrl ?? RDAP_BOOTSTRAP_URL
  const result = (
    domain: string,
    expiresAt: Date | null,
    error: string | null,
  ): DomainExpiryInfo => ({
    host,
    domain,
    expiresAt: expiresAt ? expiresAt.toISOString() : null,
    daysRemaining: expiresAt ? daysUntil(expiresAt, now) : null,
    checkedAt: now.toISOString(),
    error,
  })

  let lastError = 'No RDAP record found'
  for (const candidate of domainCandidates(host)) {
    const signals = [AbortSignal.timeout(options.timeoutMs ?? 15_000)]
    if (options.signal) signals.push(options.signal)
    let response: Response
    try {
      response = await fetchImpl(`${bootstrap}${encodeURIComponent(candidate)}`, {
        headers: { accept: 'application/rdap+json, application/json' },
        redirect: 'follow',
        signal: AbortSignal.any(signals),
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log.warn({ domain: candidate, err: message }, 'RDAP request failed')
      return result(host, null, `RDAP request failed: ${message}`)
    }

    if (response.status === 404) {
      lastError = `No RDAP record for ${candidate}`
      continue
    }
    if (!response.ok) {
      return result(candidate, null, `RDAP server answered ${response.status}`)
    }
    let body: unknown
    try {
      body = await response.json()
    } catch {
      return result(candidate, null, 'RDAP server returned invalid JSON')
    }
    const expiresAt = parseRdapExpiry(body)
    return result(candidate, expiresAt, expiresAt ? null : 'RDAP record has no expiration event')
  }
  return result(host, null, lastError)
}

/** Loose runtime guard for the JSON stored in `monitors.domainExpiry`. */
export function isDomainExpiryInfo(value: unknown): value is DomainExpiryInfo {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as { domain?: unknown }).domain === 'string' &&
    typeof (value as { host?: unknown }).host === 'string' &&
    typeof (value as { checkedAt?: unknown }).checkedAt === 'string'
  )
}

/** Should the cached lookup be refreshed? Daily after a success, hourly after a failure. */
export function isDomainExpiryStale(
  info: DomainExpiryInfo | null | undefined,
  now: Date = new Date(),
): boolean {
  if (!info) return true
  const checkedAt = new Date(info.checkedAt).getTime()
  if (Number.isNaN(checkedAt)) return true
  const maxAge = info.expiresAt ? DOMAIN_EXPIRY_RECHECK_MS : DOMAIN_EXPIRY_RETRY_MS
  return now.getTime() - checkedAt >= maxAge
}

/** The registration was renewed (expiry moved later), so earlier warnings no longer apply. */
export function domainRenewed(
  previous: DomainExpiryInfo | null | undefined,
  next: DomainExpiryInfo,
): boolean {
  if (!previous?.expiresAt || !next.expiresAt) return false
  return new Date(next.expiresAt).getTime() > new Date(previous.expiresAt).getTime()
}

export interface DomainExpiryNotice {
  targetDays: number
  daysRemaining: number
  domain: string
  message: string
}

export interface NotifyDomainExpiryOptions {
  monitor: { id: string | number; name: string; url?: string | null; hostname?: string | null }
  info: DomainExpiryInfo | null | undefined
  /** `domainExpiryNotifyDays` from the instance settings. */
  notifyDays: readonly number[]
  history: SentHistoryStore
  send: ExpirySender
  now?: Date
  /** Language of the warning (the monitor organization's `settings.language`). */
  locale?: Locale
}

export function domainExpiryMessage(
  monitor: { name: string; url?: string | null; hostname?: string | null },
  domain: string,
  daysRemaining: number,
  locale: Locale = defaultLocale,
): string {
  return serverTranslator(locale)('notifications.messages.domainExpiry', {
    name: monitor.name,
    address: monitor.url ?? monitor.hostname ?? '',
    domain,
    // `count` picks the plural form; `days` is printed as is (no digit grouping, like before).
    count: daysRemaining,
    days: String(daysRemaining),
  })
}

/** Send the tightest due threshold (once), like Uptime Kuma's `DomainExpiry.sendNotifications`. */
export async function notifyDomainExpiry(
  options: NotifyDomainExpiryOptions,
): Promise<DomainExpiryNotice | null> {
  const { monitor, info, history, send } = options
  if (!info?.expiresAt) return null
  const expiresAt = new Date(info.expiresAt)
  if (Number.isNaN(expiresAt.getTime())) return null
  const daysRemaining = daysUntil(expiresAt, options.now ?? new Date())

  for (const targetDays of sortedThresholds(options.notifyDays)) {
    if (daysRemaining > targetDays) continue
    if (await history.wasSent('domain', monitor.id, targetDays)) {
      log.debug({ monitorId: monitor.id, targetDays }, 'domain warning already sent')
      continue
    }
    const message = domainExpiryMessage(monitor, info.domain, daysRemaining, options.locale)
    log.info(
      { monitorId: monitor.id, domain: info.domain, daysRemaining, targetDays },
      'sending domain expiry warning',
    )
    if (!(await send(message))) return null // every channel failed; retry on the next beat
    await history.markSent('domain', monitor.id, targetDays)
    return { targetDays, daysRemaining, domain: info.domain, message }
  }
  return null
}
