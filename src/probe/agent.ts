/**
 * The probe agent (#91, `MARMOT_ROLE=probe`): pulls the monitors assigned to its location from
 * Marmot, runs them in its own network with the same monitor type implementations as the workers
 * (`src/server/monitor-types`, through `runCheck`) and pushes the results back. Every connection is
 * outbound: `GET /api/probe/v1/config` every `refreshSeconds` (with the ETag, so an unchanged
 * configuration costs a `304`) and `POST /api/probe/v1/results` after each check.
 *
 * Results that cannot be delivered wait in a bounded outbox (oldest dropped first) and are retried
 * with backoff; the server drops what it already recorded, so a re-sent batch is stored once. A
 * `401` (token rotated, location deleted) stops every check until a refresh succeeds again.
 *
 * With `CONNECTIVITY_CHECK_ENABLED` the agent judges its own uplink like a worker does (#148):
 * while it is offline, checks of external targets are reported as `checker offline` and held by the
 * server instead of going DOWN.
 */
import type { Payload } from 'payload'

import { childLogger } from '@/lib/logger'
import { probeSupportsType } from '@/lib/probe-locations'
import type { Monitor } from '@/payload-types'
import { nextIntervalSeconds, type CheckResult } from '@/server/engine/beat'
import {
  ConnectivityMonitor,
  connectivityConfigFromEnv,
  guardAgainstOfflineChecker,
  setConnectivityMonitor,
  type ConnectivityConfig,
} from '@/server/engine/connectivity'
import { checkTimeoutMs, runCheck as defaultRunCheck } from '@/server/engine/run-check'
import {
  MAX_RESULTS_PER_REQUEST,
  PROBE_CONFIG_PATH,
  PROBE_HOSTNAME_HEADER,
  PROBE_PLATFORM_HEADER,
  PROBE_RESULTS_PATH,
  PROBE_USER_AGENT_PREFIX,
  type ProbeConfig,
  type ProbeMonitor,
  type ProbeResult,
  type ProbeResultsResponse,
} from '@/server/probes/wire'

const log = childLogger('probe')

/** Results kept while Marmot is unreachable; the oldest are dropped beyond this. */
export const MAX_OUTBOX = 1_000
const RETRY_MIN_MS = 2_000
const RETRY_MAX_MS = 60_000
const REQUEST_TIMEOUT_MS = 30_000

export type CheckRunner = (
  payload: Payload,
  monitor: Monitor,
  timeoutMs: number,
) => Promise<CheckResult>

export interface ProbeAgentOptions {
  /** Base URL of the Marmot server (`MARMOT_URL`). */
  url: string
  /** The location token (`MARMOT_PROBE_TOKEN`). */
  token: string
  version: string
  /** Checks running at once (`WORKER_CONCURRENCY`). */
  concurrency?: number
  hostname?: string
  platform?: string
  /** Self connectivity check of the agent's uplink, `null` when disabled. */
  connectivity?: ConnectivityConfig | null
  fetch?: typeof fetch
  runCheck?: CheckRunner
  now?: () => Date
  /** Random delay before a monitor's first check, in ms (spreads a fleet's checks). */
  initialJitterMs?: (monitor: ProbeMonitor) => number
}

interface Scheduled {
  monitor: Monitor
  /** JSON of the config entry, to detect edits. */
  signature: string
  timer: ReturnType<typeof setTimeout> | null
  /** Seconds until the next check, as the server last said (or derived from the status). */
  nextSeconds: number
}

/**
 * The only Payload calls monitor types make on a probe: resolving the monitor's proxy and Docker
 * host, which the configuration ships along. Everything else is not available without a database.
 */
export function probePayload(resources: ProbeConfig['resources']): Payload {
  const collections: Record<string, Record<string, Record<string, unknown>>> = {
    proxies: resources.proxies,
    'docker-hosts': resources.dockerHosts,
  }
  const unavailable = (what: string) => async () => {
    throw new Error(`${what} is not available on a probe`)
  }
  return {
    findByID: async ({ collection, id }: { collection: string; id: string | number }) => {
      const doc = collections[collection]?.[String(id)]
      if (!doc) throw new Error(`${collection} ${String(id)} is not available on this probe`)
      return doc
    },
    find: unavailable('find'),
    findGlobal: unavailable('findGlobal'),
    count: unavailable('count'),
  } as unknown as Payload
}

/** The configuration entry as the `Monitor` the check implementations expect. */
export function toCheckMonitor(entry: ProbeMonitor, resources: ProbeConfig['resources']): Monitor {
  const monitor = { ...entry } as unknown as Monitor & Record<string, unknown>
  const proxyId = entry.proxy as string | number | null | undefined
  if (proxyId !== null && proxyId !== undefined) {
    monitor.proxy = (resources.proxies[String(proxyId)] ?? proxyId) as unknown as Monitor['proxy']
  }
  const hostId = entry.dockerHost as string | number | null | undefined
  if (hostId !== null && hostId !== undefined) {
    monitor.dockerHost = (resources.dockerHosts[String(hostId)] ??
      hostId) as unknown as Monitor['dockerHost']
  }
  return monitor
}

const statusOf = (entry: ProbeMonitor): string | null => entry.status?.lastStatus ?? null

export class ProbeAgent {
  private readonly options: Required<
    Omit<ProbeAgentOptions, 'hostname' | 'platform' | 'connectivity'>
  > &
    Pick<ProbeAgentOptions, 'hostname' | 'platform' | 'connectivity'>
  private readonly base: string
  private config: ProbeConfig | null = null
  private etag: string | null = null
  private payload: Payload = probePayload({ proxies: {}, dockerHosts: {} })
  private readonly scheduled = new Map<string, Scheduled>()
  private readonly running = new Set<string>()
  private readonly waiting: (() => void)[] = []
  private active = 0
  private outbox: ProbeResult[] = []
  private flushing: Promise<void> | null = null
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private retryDelay = RETRY_MIN_MS
  private refreshTimer: ReturnType<typeof setTimeout> | null = null
  private connectivity: ConnectivityMonitor | null = null
  private stopped = true
  /** `false` after a 401: the token is no longer valid. */
  authorized = true

  constructor(options: ProbeAgentOptions) {
    this.options = {
      concurrency: 10,
      fetch: globalThis.fetch.bind(globalThis),
      runCheck: defaultRunCheck,
      now: () => new Date(),
      initialJitterMs: (monitor) => Math.random() * Math.min(monitor.interval * 1000, 10_000),
      ...options,
    }
    this.base = options.url.replace(/\/+$/, '')
  }

  /** Monitor ids currently scheduled (tests, logging). */
  monitorIds(): string[] {
    return [...this.scheduled.keys()]
  }

  /** Results waiting for delivery (tests). */
  pendingResults(): number {
    return this.outbox.length
  }

  get location(): ProbeConfig['location'] | null {
    return this.config?.location ?? null
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      Authorization: `Bearer ${this.options.token}`,
      'User-Agent': `${PROBE_USER_AGENT_PREFIX}${this.options.version}`,
      Accept: 'application/json',
      ...(this.options.hostname ? { [PROBE_HOSTNAME_HEADER]: this.options.hostname } : {}),
      ...(this.options.platform ? { [PROBE_PLATFORM_HEADER]: this.options.platform } : {}),
      ...extra,
    }
  }

  /** Start: first refresh now, then every `refreshSeconds`. Resolves after the first refresh. */
  async start(): Promise<void> {
    this.stopped = false
    await this.refreshLoop()
  }

  /** Stop every timer and try once more to deliver the results that wait. */
  async stop(): Promise<void> {
    this.stopped = true
    if (this.refreshTimer) clearTimeout(this.refreshTimer)
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.refreshTimer = null
    this.retryTimer = null
    for (const entry of this.scheduled.values()) if (entry.timer) clearTimeout(entry.timer)
    this.scheduled.clear()
    this.connectivity?.stop()
    if (this.connectivity) setConnectivityMonitor(null, this.connectivity.location)
    this.connectivity = null
    await this.flush().catch(() => undefined)
  }

  private async refreshLoop(): Promise<void> {
    try {
      await this.refresh()
    } catch (err) {
      log.warn({ err: err instanceof Error ? err.message : err }, 'config refresh failed')
    }
    if (this.stopped) return
    const seconds = this.config?.refreshSeconds ?? 60
    this.refreshTimer = setTimeout(() => void this.refreshLoop(), seconds * 1000)
    this.refreshTimer.unref?.()
  }

  /** Pull the configuration once (304 keeps the current one). */
  async refresh(): Promise<void> {
    const response = await this.options.fetch(`${this.base}${PROBE_CONFIG_PATH}`, {
      headers: this.headers(this.etag ? { 'If-None-Match': this.etag } : {}),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (response.status === 304) {
      await response.body?.cancel().catch(() => undefined)
      this.authorized = true
      return
    }
    if (response.status === 401) {
      await response.body?.cancel().catch(() => undefined)
      if (this.authorized) log.error('the probe token was rejected (rotated or location deleted)')
      this.authorized = false
      this.etag = null
      this.apply(null)
      return
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined)
      throw new Error(`config request failed: HTTP ${response.status}`)
    }
    const config = (await response.json()) as ProbeConfig
    this.authorized = true
    this.etag = response.headers.get('etag')
    this.apply(config)
  }

  /** Install a configuration: (re)schedule new and edited monitors, drop removed ones. */
  apply(config: ProbeConfig | null): void {
    const previousLocation = this.config?.location.id ?? null
    this.config = config
    this.payload = probePayload(config?.resources ?? { proxies: {}, dockerHosts: {} })
    if (config && previousLocation !== config.location.id) {
      log.info(
        { location: config.location.slug, monitors: config.monitors.length },
        'probe connected',
      )
    }
    this.installConnectivity(config)

    const wanted = new Map<string, ProbeMonitor>()
    for (const entry of config?.monitors ?? []) {
      if (probeSupportsType(entry.type)) wanted.set(String(entry.id), entry)
    }
    for (const [id, entry] of this.scheduled) {
      if (!wanted.has(id)) {
        if (entry.timer) clearTimeout(entry.timer)
        this.scheduled.delete(id)
      }
    }
    for (const [id, entry] of wanted) {
      const signature = JSON.stringify({ ...entry, status: null })
      const monitor = toCheckMonitor(entry, config!.resources)
      const existing = this.scheduled.get(id)
      if (existing && existing.signature === signature) {
        existing.monitor = monitor
        continue
      }
      if (existing?.timer) clearTimeout(existing.timer)
      const scheduled: Scheduled = {
        monitor,
        signature,
        timer: null,
        nextSeconds: nextIntervalSeconds(
          (statusOf(entry) ?? 'up') as Parameters<typeof nextIntervalSeconds>[0],
          { interval: entry.interval, retryInterval: entry.retryInterval ?? null },
        ),
      }
      this.scheduled.set(id, scheduled)
      if (!this.stopped) this.schedule(id, existing ? 0 : this.options.initialJitterMs(entry))
    }
  }

  private installConnectivity(config: ProbeConfig | null): void {
    const location = config?.location.id ?? null
    if (this.connectivity && this.connectivity.location !== location) {
      setConnectivityMonitor(null, this.connectivity.location)
      this.connectivity = null
    }
    const connectivityConfig =
      this.options.connectivity === undefined
        ? connectivityConfigFromEnv()
        : this.options.connectivity
    if (!location || !connectivityConfig || this.connectivity || this.stopped) return
    // Registered under the location's id: `connectivityLocationOf(monitor)` picks it.
    this.connectivity = new ConnectivityMonitor({ location, config: connectivityConfig })
    setConnectivityMonitor(this.connectivity)
    void this.connectivity.start().catch((err) => log.error({ err }, 'connectivity probe failed'))
  }

  private schedule(id: string, delayMs: number): void {
    const entry = this.scheduled.get(id)
    if (!entry || this.stopped) return
    if (entry.timer) clearTimeout(entry.timer)
    entry.timer = setTimeout(() => void this.runScheduled(id), Math.max(0, delayMs))
    entry.timer.unref?.()
  }

  private async acquire(): Promise<void> {
    if (this.active < this.options.concurrency) {
      this.active += 1
      return
    }
    await new Promise<void>((resolve) => this.waiting.push(resolve))
    this.active += 1
  }

  private release(): void {
    this.active -= 1
    this.waiting.shift()?.()
  }

  private async runScheduled(id: string): Promise<void> {
    if (!this.scheduled.has(id) || this.running.has(id)) return
    this.running.add(id)
    try {
      await this.checkNow(id)
    } finally {
      this.running.delete(id)
      // The entry may have been replaced by an edit or removed meanwhile.
      const current = this.scheduled.get(id)
      if (current) this.schedule(id, current.nextSeconds * 1000)
    }
  }

  /** Run one monitor's check and deliver its result (exposed for tests). */
  async checkNow(id: string): Promise<void> {
    const entry = this.scheduled.get(id)
    if (!entry) return
    await this.acquire()
    let result: CheckResult
    try {
      const { monitor } = entry
      result = await guardAgainstOfflineChecker(this.payload, monitor, () =>
        this.options.runCheck(this.payload, monitor, checkTimeoutMs(monitor)),
      )
    } catch (err) {
      result = { ok: false, msg: err instanceof Error ? err.message : String(err) }
    } finally {
      this.release()
    }
    this.enqueue({
      monitorId: entry.monitor.id,
      time: this.options.now().toISOString(),
      ok: result.ok,
      ...(result.ok && result.status ? { status: wireStatus(result.status) } : {}),
      msg: (result.msg ?? '').slice(0, 5_000),
      ping: finiteOrNull(result.ping),
      duration: finiteOrNull(result.duration),
      tlsInfo: (result.tlsInfo as Record<string, unknown> | null | undefined) ?? null,
      assertions: (result.assertions as Record<string, unknown>[] | null | undefined) ?? null,
      ...(result.blocked ? { blocked: true } : {}),
      ...(result.checkerOffline ? { checkerOffline: true } : {}),
      ...(result.deferred ? { deferred: true } : {}),
    })
    await this.flush()
  }

  private enqueue(result: ProbeResult): void {
    this.outbox.push(result)
    if (this.outbox.length > MAX_OUTBOX) {
      const dropped = this.outbox.length - MAX_OUTBOX
      this.outbox.splice(0, dropped)
      log.warn({ dropped }, 'result outbox full; dropped the oldest results')
    }
  }

  /** Deliver the outbox in order, `MAX_RESULTS_PER_REQUEST` at a time. One flush at a time. */
  flush(): Promise<void> {
    if (this.flushing) return this.flushing
    this.flushing = this.deliver().finally(() => {
      this.flushing = null
    })
    return this.flushing
  }

  private async deliver(): Promise<void> {
    while (this.outbox.length > 0) {
      const batch = this.outbox.slice(0, MAX_RESULTS_PER_REQUEST)
      let response: Response
      try {
        response = await this.options.fetch(`${this.base}${PROBE_RESULTS_PATH}`, {
          method: 'POST',
          headers: this.headers({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({ results: batch }),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        })
      } catch (err) {
        this.retryLater(err instanceof Error ? err.message : String(err))
        return
      }
      if (response.status === 400) {
        // A malformed batch never becomes valid: drop it rather than block the outbox.
        log.error({ body: await response.text().catch(() => '') }, 'results refused (400)')
        this.outbox.splice(0, batch.length)
        continue
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined)
        if (response.status === 401) this.authorized = false
        this.retryLater(`HTTP ${response.status}`)
        return
      }
      const body = (await response.json()) as ProbeResultsResponse
      this.outbox.splice(0, batch.length)
      this.retryDelay = RETRY_MIN_MS
      let refresh = false
      for (const outcome of body.results ?? []) {
        const entry = this.scheduled.get(String(outcome.monitorId))
        if (outcome.accepted && entry && typeof outcome.nextCheckSeconds === 'number') {
          entry.nextSeconds = Math.max(1, outcome.nextCheckSeconds)
        }
        if (
          !outcome.accepted &&
          ['unknown-monitor', 'not-assigned', 'inactive', 'unsupported-type'].includes(
            outcome.reason ?? '',
          )
        ) {
          refresh = true
        }
      }
      // The configuration is out of date (monitor moved, paused or deleted): pull it now.
      if (refresh) void this.refresh().catch(() => undefined)
    }
  }

  private retryLater(reason: string): void {
    log.warn({ reason, pending: this.outbox.length }, 'results not delivered; retrying')
    if (this.retryTimer || this.stopped) return
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      void this.flush()
    }, this.retryDelay)
    this.retryTimer.unref?.()
    this.retryDelay = Math.min(RETRY_MAX_MS, this.retryDelay * 2)
  }
}

const finiteOrNull = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null

const wireStatus = (status: string): ProbeResult['status'] =>
  status === 'down' || status === 'pending' || status === 'degraded' ? status : 'up'
