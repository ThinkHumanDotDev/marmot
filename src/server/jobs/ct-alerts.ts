/**
 * Certificate transparency alerts (#143).
 *
 * Every `CT_ALERTS_TICK_MS` the `ct-alerts` job (own `marmot:ct` queue, one job at a time) looks up
 * the monitors with `ctAlerts` on whose next lookup is due (`CT_CHECK_INTERVAL_MINUTES`) in a
 * certificate transparency source: crt.sh's JSON by default, or any URL template in
 * `CT_SOURCE_URL` that answers crt.sh JSON or Cert Spotter issuances. Each certificate for the
 * monitor's hostname (and, with `ctIncludeSubdomains`, its subdomains) logged after the baseline
 * is announced once through the monitor's channels that accept the `certificate` event (#126):
 * issuer, names, validity and a link to the entry. Certificates from an issuer outside
 * `ctExpectedIssuers` are flagged as unexpected.
 *
 * - **Baseline**: the first run after the option is turned on (or the hostname or the subdomain
 *   option changes) only records `ctState.since`; certificates logged before it are never
 *   announced. Turning the option off clears `ctState` (Monitors `beforeChange`).
 * - **Dedupe**: an announced certificate is claimed in `notification-sent-history` (type `ct`,
 *   `fingerprint`, unique index) before it is sent, so overlapping runs and re-runs never repeat
 *   it. When every channel fails the claim is released and the next lookup retries.
 * - **Rate limits and backoff**: requests to the source are spaced by `CT_REQUESTS_PER_MINUTE`
 *   and identical lookups are made once per run. A failed lookup ends the run: the source pauses
 *   for an exponential backoff (or its `Retry-After`, whichever is longer) and the monitor's next
 *   lookup moves back the same way, up to a day.
 */
import { createHash } from 'node:crypto'

import type { Job, Queue, Worker } from 'bullmq'
import type { Payload } from 'payload'

import { env } from '@/env'
import { childLogger } from '@/lib/logger'
import type { Monitor, Notification } from '@/payload-types'
import { isDemoMode } from '@/server/demo/config'
import { QUEUE_NAMES } from '@/server/engine/names'
import { createQueue, createWorker, type QueueFactoryOptions } from '@/server/engine/queues'
import { getOrganizationI18n, organizationFormatter, serverTranslator } from '@/server/i18n'
import {
  channelsAcceptingEvent,
  getMonitorNotifications,
  sendNotification,
} from '@/server/notifications'
import { extractDomain } from './domain-expiry'

const log = childLogger('jobs:ct-alerts')

export const CT_QUEUE_NAME = QUEUE_NAMES.ct
export const CT_ALERTS_JOB_NAME = 'ct-alerts'
/** How often the job looks for due monitors; each monitor is looked up every interval only. */
export const CT_ALERTS_TICK_MS = 5 * 60_000
/** A run stops starting lookups after this long, so two runs never overlap. */
export const CT_RUN_BUDGET_MS = CT_ALERTS_TICK_MS - 30_000
export const CT_BACKOFF_BASE_MS = 5 * 60_000
export const CT_BACKOFF_MAX_MS = 24 * 60 * 60_000
/** Certificates announced per monitor and run; the rest follow on the next run. */
export const CT_MAX_ALERTS_PER_RUN = 10
/**
 * Sources without a log timestamp (Cert Spotter) are compared on `notBefore`, which CAs backdate
 * (Let's Encrypt by an hour): those count from a day before the baseline.
 */
export const CT_NOT_BEFORE_GRACE_MS = 24 * 60 * 60_000
export const CT_REQUEST_TIMEOUT_MS = 60_000

const relationId = (value: unknown): string | number | null => {
  if (value === null || value === undefined) return null
  if (typeof value === 'object') return (value as { id?: string | number }).id ?? null
  return value as string | number
}

// ---- Certificates ---------------------------------------------------------------------------

/** One certificate of a CT source, normalised. */
export interface CtCertificate {
  /** Dedupe key: SHA-256 hex, the same for a precertificate and its certificate. */
  fingerprint: string
  issuer: string
  commonName: string | null
  /** DNS names (SANs), lower-cased. */
  names: string[]
  notBefore: string | null
  notAfter: string | null
  /** When the certificate was logged (crt.sh `entry_timestamp`), if the source says. */
  loggedAt: string | null
  /** Link to the entry, e.g. `https://crt.sh/?id=…`. */
  link: string | null
}

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')

/** crt.sh timestamps are UTC without a zone (`2026-10-01T12:00:00.123`). */
function isoTimestamp(value: unknown): string | null {
  if (typeof value !== 'string' || !value) return null
  const text = /[zZ]|[+-]\d\d:?\d\d$/.test(value) ? value : `${value}Z`
  const date = new Date(text)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

const nameList = (value: unknown): string[] => {
  const raw = Array.isArray(value)
    ? value.filter((v): v is string => typeof v === 'string')
    : typeof value === 'string'
      ? value.split(/\s+/)
      : []
  return [...new Set(raw.map((v) => v.trim().toLowerCase()).filter(Boolean))]
}

function parseCrtShEntry(entry: Record<string, unknown>): CtCertificate | null {
  const issuer = typeof entry.issuer_name === 'string' ? entry.issuer_name : ''
  const serial = typeof entry.serial_number === 'string' ? entry.serial_number.toLowerCase() : ''
  const id = entry.id
  if (!serial && id === undefined) return null
  const commonName = typeof entry.common_name === 'string' ? entry.common_name : null
  const names = nameList(entry.name_value)
  if (commonName && !names.includes(commonName.toLowerCase())) {
    names.unshift(commonName.toLowerCase())
  }
  return {
    // Issuer + serial identify a certificate; crt.sh lists the precertificate separately.
    fingerprint: sha256(serial ? `${issuer}|${serial}` : `crtsh:${String(id)}`),
    issuer,
    commonName,
    names,
    notBefore: isoTimestamp(entry.not_before),
    notAfter: isoTimestamp(entry.not_after),
    loggedAt: isoTimestamp(entry.entry_timestamp),
    link:
      typeof id === 'number' || typeof id === 'string'
        ? `https://crt.sh/?id=${encodeURIComponent(String(id))}`
        : null,
  }
}

function parseCertSpotterEntry(entry: Record<string, unknown>): CtCertificate | null {
  const key =
    (typeof entry.tbs_sha256 === 'string' && entry.tbs_sha256) ||
    (typeof entry.cert_sha256 === 'string' && entry.cert_sha256) ||
    null
  if (!key) return null
  const issuerObject = entry.issuer as { name?: unknown; friendly_name?: unknown } | undefined
  const issuer =
    (typeof issuerObject?.name === 'string' && issuerObject.name) ||
    (typeof issuerObject?.friendly_name === 'string' && issuerObject.friendly_name) ||
    ''
  const names = nameList(entry.dns_names)
  const certSha = typeof entry.cert_sha256 === 'string' ? entry.cert_sha256 : null
  return {
    fingerprint: key.toLowerCase(),
    issuer,
    commonName: names[0] ?? null,
    names,
    notBefore: isoTimestamp(entry.not_before),
    notAfter: isoTimestamp(entry.not_after),
    loggedAt: null,
    link: certSha ? `https://crt.sh/?sha256=${encodeURIComponent(certSha)}` : null,
  }
}

/** Parse a source's answer: crt.sh JSON or Cert Spotter issuances. Unknown entries are skipped. */
export function parseCtEntries(body: unknown): CtCertificate[] {
  if (!Array.isArray(body)) return []
  const out: CtCertificate[] = []
  const seen = new Set<string>()
  for (const entry of body) {
    if (!entry || typeof entry !== 'object') continue
    const record = entry as Record<string, unknown>
    const cert =
      'dns_names' in record || 'tbs_sha256' in record || 'cert_sha256' in record
        ? parseCertSpotterEntry(record)
        : parseCrtShEntry(record)
    if (!cert || seen.has(cert.fingerprint)) continue
    seen.add(cert.fingerprint)
    out.push(cert)
  }
  return out
}

/**
 * Lookup URLs for a hostname. A `{query}` template gets the crt.sh identity: the hostname, plus
 * `%.hostname` for the subdomains (crt.sh matches those separately). Other templates get one
 * request with `{domain}` and `{subdomains}`.
 */
export function buildCtRequestUrls(template: string, host: string, subdomains: boolean): string[] {
  const fill = (query: string) =>
    template
      .replaceAll('{query}', encodeURIComponent(query))
      .replaceAll('{domain}', encodeURIComponent(host))
      .replaceAll('{subdomains}', subdomains ? 'true' : 'false')
  if (!template.includes('{query}')) return [fill(host)]
  return subdomains ? [fill(host), fill(`%.${host}`)] : [fill(host)]
}

/** Does the certificate name the hostname (or, with `subdomains`, one of its subdomains)? */
export function certificateMatchesHost(
  cert: Pick<CtCertificate, 'names'>,
  host: string,
  subdomains: boolean,
): boolean {
  return cert.names.some((name) => name === host || (subdomains && name.endsWith(`.${host}`)))
}

/** `true` when no issuers are expected or the issuer contains one of them (case-insensitive). */
export function isExpectedIssuer(issuer: string, expected: readonly string[] | null | undefined) {
  const list = (expected ?? []).map((v) => v.trim().toLowerCase()).filter(Boolean)
  if (list.length === 0) return true
  const name = issuer.toLowerCase()
  return list.some((v) => name.includes(v))
}

/** Logged (or, without a log timestamp, valid from) at or after the baseline? */
export function isAfterBaseline(cert: CtCertificate, since: Date): boolean {
  if (cert.loggedAt) return new Date(cert.loggedAt).getTime() >= since.getTime()
  if (cert.notBefore) {
    return new Date(cert.notBefore).getTime() >= since.getTime() - CT_NOT_BEFORE_GRACE_MS
  }
  return false
}

/** Exponential backoff after `failures` failed lookups in a row: 5 min, 10, 20 … up to a day. */
export function ctBackoffMs(failures: number): number {
  if (failures <= 0) return 0
  return Math.min(CT_BACKOFF_BASE_MS * 2 ** (failures - 1), CT_BACKOFF_MAX_MS)
}

// ---- Monitor state --------------------------------------------------------------------------

/** What `monitors.ctState` stores. */
export interface CtState {
  /** Hostname and subdomain option the baseline was taken for. */
  host: string
  subdomains: boolean
  /** Baseline: certificates logged before it are never announced. */
  since: string
  lastCheckedAt: string | null
  nextCheckAt: string
  /** Failed lookups in a row. */
  failures: number
  error: string | null
}

export function isCtState(value: unknown): value is CtState {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as CtState).host === 'string' &&
    typeof (value as CtState).since === 'string' &&
    typeof (value as CtState).nextCheckAt === 'string'
  )
}

// ---- Source ---------------------------------------------------------------------------------

export class CtSourceError extends Error {
  constructor(
    message: string,
    readonly status: number | null = null,
    readonly retryAfterMs: number | null = null,
  ) {
    super(message)
    this.name = 'CtSourceError'
  }
}

/** Source-wide health, shared by the runs of this process. */
export interface CtSourceHealth {
  failures: number
  pausedUntil: number
}

const sourceHealth: CtSourceHealth = { failures: 0, pausedUntil: 0 }

/** Forget the source's backoff (tests). */
export function resetCtSourceHealth(): void {
  sourceHealth.failures = 0
  sourceHealth.pausedUntil = 0
}

function parseRetryAfter(value: string | null, now: number): number | null {
  if (!value) return null
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000
  const date = Date.parse(value)
  return Number.isNaN(date) ? null : Math.max(0, date - now)
}

export interface CtFetcherOptions {
  fetchImpl?: typeof fetch
  requestsPerMinute?: number
  sleep?: (ms: number) => Promise<void>
  clock?: () => number
  timeoutMs?: number
}

/**
 * Fetches lookups from the source, spaced by `requestsPerMinute`, each URL at most once per run.
 * Throws `CtSourceError` on network errors, non-2xx answers and invalid JSON.
 */
export function createCtFetcher(options: CtFetcherOptions = {}) {
  const fetchImpl = options.fetchImpl ?? fetch
  const spacing = 60_000 / (options.requestsPerMinute ?? env.CT_REQUESTS_PER_MINUTE)
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)))
  const clock = options.clock ?? Date.now
  const cache = new Map<string, CtCertificate[]>()
  let nextRequestAt = 0
  let requests = 0

  return {
    get requests() {
      return requests
    },
    async get(url: string): Promise<CtCertificate[]> {
      const cached = cache.get(url)
      if (cached) return cached
      const wait = nextRequestAt - clock()
      if (wait > 0) await sleep(wait)
      nextRequestAt = clock() + spacing
      requests += 1
      let response: Response
      try {
        response = await fetchImpl(url, {
          headers: { accept: 'application/json' },
          redirect: 'follow',
          signal: AbortSignal.timeout(options.timeoutMs ?? CT_REQUEST_TIMEOUT_MS),
        })
      } catch (err) {
        throw new CtSourceError(
          `CT source request failed: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
      if (!response.ok) {
        throw new CtSourceError(
          `CT source answered ${response.status}`,
          response.status,
          parseRetryAfter(response.headers.get('retry-after'), clock()),
        )
      }
      let body: unknown
      try {
        body = await response.json()
      } catch {
        throw new CtSourceError('CT source returned invalid JSON', response.status)
      }
      if (!Array.isArray(body)) {
        throw new CtSourceError('CT source returned an unexpected answer', response.status)
      }
      const certs = parseCtEntries(body)
      cache.set(url, certs)
      return certs
    },
  }
}

export type CtFetcher = ReturnType<typeof createCtFetcher>

// ---- Notifications --------------------------------------------------------------------------

export interface CtAlertNotice {
  fingerprint: string
  unexpected: boolean
  message: string
}

/** `[name] New certificate for example.com issued by … Names: … Valid … to …. <link>` */
export async function ctAlertMessage(
  payload: Payload,
  monitor: Pick<Monitor, 'name' | 'organization'>,
  host: string,
  cert: CtCertificate,
  unexpected: boolean,
): Promise<string> {
  const i18n = await getOrganizationI18n(payload, relationId(monitor.organization))
  const t = serverTranslator(i18n.locale)
  const format = organizationFormatter(i18n)
  const date = (value: string | null) =>
    value ? format.dateTime(new Date(value), 'zoned') : t('notifications.messages.ctUnknownDate')
  return t(
    unexpected
      ? 'notifications.messages.ctUnexpectedCertificate'
      : 'notifications.messages.ctNewCertificate',
    {
      name: monitor.name,
      domain: host,
      issuer: cert.issuer || t('notifications.messages.ctUnknownIssuer'),
      names: cert.names.join(', '),
      notBefore: date(cert.notBefore),
      notAfter: date(cert.notAfter),
      link: cert.link ?? '',
    },
  ).trim()
}

async function sendToChannels(
  payload: Payload,
  monitor: Monitor,
  channels: Notification[],
  message: string,
): Promise<boolean> {
  const { locale } = await getOrganizationI18n(payload, relationId(monitor.organization))
  let sent = false
  for (const channel of channels) {
    try {
      await sendNotification(payload, channel, {
        message,
        monitor,
        heartbeat: null,
        event: 'certificate',
        locale,
      })
      sent = true
    } catch (err) {
      log.error(
        { err, notificationId: channel.id, type: channel.type, monitorId: monitor.id },
        'cannot send certificate transparency alert',
      )
    }
  }
  return sent
}

// ---- History (notification-sent-history, type `ct`) -----------------------------------------

async function announcedFingerprints(payload: Payload, monitorId: string | number) {
  const { docs } = await payload.find({
    collection: 'notification-sent-history',
    where: { and: [{ type: { equals: 'ct' } }, { monitor: { equals: monitorId } }] },
    select: { fingerprint: true },
    depth: 0,
    limit: 0,
    pagination: false,
    overrideAccess: true,
  })
  return new Set(docs.map((doc) => doc.fingerprint ?? ''))
}

/** Claim a certificate; `false` when another run already did (unique index). */
async function claim(payload: Payload, monitor: Monitor, fingerprint: string): Promise<boolean> {
  try {
    await payload.create({
      collection: 'notification-sent-history',
      depth: 0,
      overrideAccess: true,
      data: {
        type: 'ct',
        monitor: monitor.id,
        days: 0,
        fingerprint,
        organization: relationId(monitor.organization),
      } as never,
    })
    return true
  } catch (err) {
    log.debug({ err, monitorId: monitor.id, fingerprint }, 'certificate already claimed')
    return false
  }
}

async function release(payload: Payload, monitorId: string | number, fingerprint: string) {
  await payload.delete({
    collection: 'notification-sent-history',
    where: {
      and: [
        { type: { equals: 'ct' } },
        { monitor: { equals: monitorId } },
        { fingerprint: { equals: fingerprint } },
      ],
    },
    depth: 0,
    overrideAccess: true,
  })
}

async function clearHistory(payload: Payload, monitorId: string | number) {
  await payload.delete({
    collection: 'notification-sent-history',
    where: { and: [{ type: { equals: 'ct' } }, { monitor: { equals: monitorId } }] },
    depth: 0,
    overrideAccess: true,
  })
}

// ---- Run ------------------------------------------------------------------------------------

export interface CtRunOptions {
  now?: Date
  /** URL template (default `CT_SOURCE_URL`). */
  sourceUrl?: string
  /** Minutes between two lookups of a monitor (default `CT_CHECK_INTERVAL_MINUTES`). */
  intervalMinutes?: number
  fetcher?: CtFetcher
  fetch?: CtFetcherOptions
  health?: CtSourceHealth
  /** Stop starting lookups after this many ms (default `CT_RUN_BUDGET_MS`). */
  budgetMs?: number
}

export type CtMonitorOutcome =
  | { monitorId: string; result: 'baseline' }
  | { monitorId: string; result: 'checked'; alerts: CtAlertNotice[] }

export interface CtRunResult {
  checked: number
  baselines: number
  alerts: number
  /** Why the run did nothing or stopped early. */
  stopped: 'paused' | 'error' | 'budget' | 'demo' | null
  error?: string
  monitors: CtMonitorOutcome[]
}

async function saveState(payload: Payload, monitorId: string | number, state: CtState) {
  await payload.update({
    collection: 'monitors',
    id: monitorId,
    depth: 0,
    overrideAccess: true,
    context: { skipEngineSync: true },
    data: { ctState: state as unknown as Monitor['ctState'] },
  })
}

/**
 * One monitor: take the baseline when there is none (or the hostname/subdomain option changed),
 * otherwise look the hostname up and announce the certificates not announced yet. Throws
 * `CtSourceError` when the lookup fails (the caller backs off).
 */
export async function processCtMonitor(
  payload: Payload,
  monitor: Monitor,
  fetcher: CtFetcher,
  options: { now: Date; sourceUrl: string; intervalMs: number },
): Promise<CtMonitorOutcome | null> {
  const host = extractDomain(monitor)
  if (!host) return null
  const { now } = options
  const subdomains = Boolean(monitor.ctIncludeSubdomains)
  const stored: unknown = monitor.ctState
  const state: CtState | null = isCtState(stored) ? stored : null
  const monitorId = String(monitor.id)

  if (!state || state.host !== host || Boolean(state.subdomains) !== subdomains) {
    // Earlier announcements were about another name; a subdomain switch keeps them.
    if (state && state.host !== host) await clearHistory(payload, monitor.id)
    await saveState(payload, monitor.id, {
      host,
      subdomains,
      since: now.toISOString(),
      lastCheckedAt: null,
      nextCheckAt: new Date(now.getTime() + options.intervalMs).toISOString(),
      failures: 0,
      error: null,
    })
    log.info({ monitorId, host, subdomains }, 'certificate transparency baseline taken')
    return { monitorId, result: 'baseline' }
  }
  if (new Date(state.nextCheckAt).getTime() > now.getTime()) return null

  let certs: CtCertificate[]
  try {
    const lists = []
    for (const url of buildCtRequestUrls(options.sourceUrl, host, subdomains)) {
      lists.push(await fetcher.get(url))
    }
    certs = lists.flat()
  } catch (err) {
    const failures = (state.failures ?? 0) + 1
    const error = err instanceof Error ? err.message : String(err)
    const retryAfter = err instanceof CtSourceError ? (err.retryAfterMs ?? 0) : 0
    await saveState(payload, monitor.id, {
      ...state,
      failures,
      error,
      nextCheckAt: new Date(
        now.getTime() + Math.max(ctBackoffMs(failures), retryAfter),
      ).toISOString(),
    })
    throw err
  }

  const since = new Date(state.since)
  const announced = await announcedFingerprints(payload, monitor.id)
  const unique = new Map<string, CtCertificate>()
  for (const cert of certs) {
    if (unique.has(cert.fingerprint) || announced.has(cert.fingerprint)) continue
    if (!certificateMatchesHost(cert, host, subdomains) || !isAfterBaseline(cert, since)) continue
    unique.set(cert.fingerprint, cert)
  }
  const fresh = [...unique.values()].sort((a, b) =>
    (a.loggedAt ?? a.notBefore ?? '').localeCompare(b.loggedAt ?? b.notBefore ?? ''),
  )
  const batch = fresh.slice(0, CT_MAX_ALERTS_PER_RUN)

  const alerts: CtAlertNotice[] = []
  if (batch.length > 0) {
    const channels = channelsAcceptingEvent(
      await getMonitorNotifications(payload, monitor),
      'certificate',
    )
    for (const cert of batch) {
      if (!(await claim(payload, monitor, cert.fingerprint))) continue
      const unexpected = !isExpectedIssuer(cert.issuer, monitor.ctExpectedIssuers)
      const message = await ctAlertMessage(payload, monitor, host, cert, unexpected)
      // Without channels the certificate is only recorded, so a channel added later is not
      // flooded with old certificates.
      if (channels.length > 0 && !(await sendToChannels(payload, monitor, channels, message))) {
        await release(payload, monitor.id, cert.fingerprint)
        continue
      }
      log.info(
        { monitorId, host, issuer: cert.issuer, unexpected, fingerprint: cert.fingerprint },
        'certificate transparency alert',
      )
      alerts.push({ fingerprint: cert.fingerprint, unexpected, message })
    }
  }

  await saveState(payload, monitor.id, {
    ...state,
    lastCheckedAt: now.toISOString(),
    // More than a batch waiting: continue on the next run instead of after the interval.
    nextCheckAt: new Date(
      fresh.length > batch.length ? now.getTime() : now.getTime() + options.intervalMs,
    ).toISOString(),
    failures: 0,
    error: null,
  })
  return { monitorId, result: 'checked', alerts }
}

/** Look up every due monitor with CT alerts on. Never throws for a single monitor's failure. */
export async function runCtAlerts(
  payload: Payload,
  options: CtRunOptions = {},
): Promise<CtRunResult> {
  const now = options.now ?? new Date()
  const health = options.health ?? sourceHealth
  const result: CtRunResult = { checked: 0, baselines: 0, alerts: 0, stopped: null, monitors: [] }
  // Demo mode (#159): the lookups would query a third party for visitor-chosen domains.
  if (isDemoMode()) return { ...result, stopped: 'demo' }
  if (health.pausedUntil > now.getTime()) return { ...result, stopped: 'paused' }

  const sourceUrl = options.sourceUrl ?? env.CT_SOURCE_URL
  const intervalMs = (options.intervalMinutes ?? env.CT_CHECK_INTERVAL_MINUTES) * 60_000
  const fetcher = options.fetcher ?? createCtFetcher(options.fetch)
  const budgetMs = options.budgetMs ?? CT_RUN_BUDGET_MS
  const started = Date.now()

  const { docs } = await payload.find({
    collection: 'monitors',
    where: { and: [{ ctAlerts: { equals: true } }, { active: { not_equals: false } }] },
    depth: 0,
    limit: 0,
    pagination: false,
    overrideAccess: true,
  })
  for (const monitor of docs as Monitor[]) {
    if (Date.now() - started > budgetMs) {
      result.stopped = 'budget'
      break
    }
    try {
      const outcome = await processCtMonitor(payload, monitor, fetcher, {
        now,
        sourceUrl,
        intervalMs,
      })
      if (!outcome) continue
      result.monitors.push(outcome)
      if (outcome.result === 'baseline') result.baselines += 1
      else {
        result.checked += 1
        result.alerts += outcome.alerts.length
        health.failures = 0
      }
    } catch (err) {
      if (!(err instanceof CtSourceError)) {
        log.error({ err, monitorId: monitor.id }, 'certificate transparency check failed')
        continue
      }
      // The source is struggling or rate limiting us: leave it alone for a while.
      health.failures += 1
      const pause = Math.max(ctBackoffMs(health.failures), err.retryAfterMs ?? 0)
      health.pausedUntil = now.getTime() + pause
      log.warn(
        { err: err.message, status: err.status, pauseMs: pause, monitorId: monitor.id },
        'certificate transparency source failed; backing off',
      )
      result.stopped = 'error'
      result.error = err.message
      break
    }
  }
  return result
}

// ---- Queue ----------------------------------------------------------------------------------

let ctQueue: Queue | undefined

export function getCtQueue(options: QueueFactoryOptions = {}): Queue {
  ctQueue ??= createQueue(CT_QUEUE_NAME, options)
  return ctQueue
}

export async function closeCtQueue(): Promise<void> {
  await ctQueue?.close()
  ctQueue = undefined
}

/** Upsert the `ct-alerts` scheduler (removed in demo mode). Idempotent. */
export async function scheduleCtAlertsJob(queue: Queue): Promise<void> {
  if (isDemoMode()) {
    await queue.removeJobScheduler(CT_ALERTS_JOB_NAME)
    return
  }
  await queue.upsertJobScheduler(
    CT_ALERTS_JOB_NAME,
    { every: CT_ALERTS_TICK_MS },
    { name: CT_ALERTS_JOB_NAME, opts: { removeOnComplete: 10, removeOnFail: 50 } },
  )
}

export const processCtAlertsJob =
  (payload: Payload) =>
  async (job: Job): Promise<CtRunResult | undefined> => {
    if (job.name !== CT_ALERTS_JOB_NAME) return undefined
    return runCtAlerts(payload)
  }

/**
 * Worker entrypoint helper: upsert the scheduler and consume the `ct` queue one job at a time (a
 * queue of its own, so slow lookups never hold up the maintenance jobs).
 */
export async function startCtAlertsWorker(
  payload: Payload,
  options: QueueFactoryOptions = {},
): Promise<Worker> {
  await scheduleCtAlertsJob(getCtQueue(options))
  const worker = createWorker(CT_QUEUE_NAME, processCtAlertsJob(payload), {
    ...options,
    concurrency: 1,
  })
  worker.on('failed', (job, err) => {
    log.error({ err, jobId: job?.id, name: job?.name }, 'certificate transparency job failed')
  })
  worker.on('error', (err) => {
    log.error({ err }, 'certificate transparency worker error')
  })
  return worker
}
