/**
 * Self connectivity check (#148).
 *
 * When the worker's own uplink or DNS fails, every external monitor would go DOWN at once and every
 * channel would be flooded although nothing but Marmot's connectivity is down. The worker therefore
 * probes a few well-known targets (`CONNECTIVITY_CHECK_TARGETS`, every `CONNECTIVITY_CHECK_INTERVAL`
 * seconds, `any` or `all` of them must answer) and, while it is offline, holds the checks of
 * monitors that need the internet: `guardAgainstOfflineChecker` turns them into PENDING
 * "checker offline" beats (`holdBeatWhileCheckerOffline` in `beat.ts`) that are neither notified nor
 * counted as downtime. Monitors whose targets are all private or local keep running.
 *
 * A check that fails while the cached verdict says "online" triggers a fresh probe (at most every
 * `RECHECK_AFTER_FAILURE_MS`), so an uplink lost between two probes is caught before the failure
 * turns into a DOWN.
 *
 * Probing is per location: `ConnectivityMonitor`s are registered by location id and
 * `connectivityLocationOf(monitor)` picks the one that judges a monitor. Today every worker runs
 * one monitor for `DEFAULT_LOCATION`; multi-location checks (#92) register one per location.
 */
import dns from 'node:dns'
import net from 'node:net'
import type { Payload } from 'payload'

import { env } from '@/env'
import { parseConnectivityTargets, type ConnectivityTarget } from '@/lib/connectivity-targets'
import { childLogger } from '@/lib/logger'
import type { DockerHost, Monitor } from '@/payload-types'
import { AddressPolicy, stripAddress } from '@/server/security/address-policy'
import { connectionTargets } from '@/server/security/connection-hosts'
import { looseHost } from '@/server/security/monitor-targets'
import type { CheckResult } from './beat'

const log = childLogger('engine:connectivity')

/** The only location until multi-location checks (#92) exist. */
export const DEFAULT_LOCATION = 'default'

/** Message of the PENDING beat written instead of a check while the worker is offline. */
export const CHECKER_OFFLINE_MSG = 'checker offline'

/** A failed check re-probes connectivity when the last verdict is older than this. */
export const RECHECK_AFTER_FAILURE_MS = 10_000

export interface ConnectivityConfig {
  targets: ConnectivityTarget[]
  /** `any`: one answering target is enough; `all`: every target must answer. */
  mode: 'any' | 'all'
  intervalMs: number
  timeoutMs: number
}

/** The configuration from `CONNECTIVITY_CHECK_*`, or `null` when the check is disabled. */
export function connectivityConfigFromEnv(): ConnectivityConfig | null {
  if (!env.CONNECTIVITY_CHECK_ENABLED) return null
  return {
    targets: parseConnectivityTargets(env.CONNECTIVITY_CHECK_TARGETS),
    mode: env.CONNECTIVITY_CHECK_MODE,
    intervalMs: env.CONNECTIVITY_CHECK_INTERVAL * 1000,
    timeoutMs: env.CONNECTIVITY_CHECK_TIMEOUT * 1000,
  }
}

// ---- Probing ---------------------------------------------------------------------------------

/** Resolves when the target answered, rejects otherwise. Injectable so tests can cut the uplink. */
export type TargetProber = (target: ConnectivityTarget, timeoutMs: number) => Promise<void>

function probeTcp(host: string, port: number, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port })
    const done = (err?: Error) => {
      socket.destroy()
      if (err) reject(err)
      else resolve()
    }
    socket.setTimeout(timeoutMs, () => done(new Error(`timeout after ${timeoutMs} ms`)))
    socket.once('connect', () => done())
    socket.once('error', (err) => done(err))
  })
}

async function probeHttp(url: string, timeoutMs: number): Promise<void> {
  // Any HTTP response proves the round trip; the status code does not matter.
  const response = await fetch(url, {
    method: 'HEAD',
    redirect: 'manual',
    signal: AbortSignal.timeout(timeoutMs),
  })
  await response.body?.cancel().catch(() => undefined)
}

/** Default prober: a TCP connect for `host:port`, an HTTP HEAD request for URLs. */
export const probeTarget: TargetProber = (target, timeoutMs) =>
  target.kind === 'tcp'
    ? probeTcp(target.host, target.port, timeoutMs)
    : probeHttp(target.url, timeoutMs)

export interface TargetResult {
  target: string
  ok: boolean
  /** Round trip in ms when the target answered. */
  ms: number | null
  error?: string
}

/** Probe every target in parallel and apply the `any` / `all` rule. */
export async function probeConnectivity(
  config: ConnectivityConfig,
  prober: TargetProber = probeTarget,
): Promise<{ online: boolean; results: TargetResult[] }> {
  const results = await Promise.all(
    config.targets.map(async (target): Promise<TargetResult> => {
      const startedAt = Date.now()
      try {
        await prober(target, config.timeoutMs)
        return { target: target.label, ok: true, ms: Date.now() - startedAt }
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err)
        return { target: target.label, ok: false, ms: null, error }
      }
    }),
  )
  const online = config.mode === 'all' ? results.every((r) => r.ok) : results.some((r) => r.ok)
  return { online, results }
}

// ---- State per location ----------------------------------------------------------------------

export type ConnectivityStatus = 'online' | 'offline' | 'unknown'

export interface ConnectivitySnapshot {
  location: string
  status: ConnectivityStatus
  /** When the current status began (ISO), `null` before the first probe. */
  since: string | null
  /** When the last probe finished (ISO). */
  checkedAt: string | null
  results: TargetResult[]
}

export interface ConnectivityMonitorOptions {
  location?: string
  config: ConnectivityConfig
  prober?: TargetProber
  now?: () => Date
  /** Called after every probe that changed the status (`previous` is the status before). */
  onChange?: (snapshot: ConnectivitySnapshot, previous: ConnectivityStatus) => unknown
  /** Called after every probe (publishing the state, flushing notices). */
  onProbe?: (snapshot: ConnectivitySnapshot) => unknown
}

/** Cached connectivity verdict of one location, refreshed by a timer and on demand. */
export class ConnectivityMonitor {
  readonly location: string
  readonly config: ConnectivityConfig
  private readonly prober: TargetProber
  private readonly now: () => Date
  private readonly options: ConnectivityMonitorOptions
  private status: ConnectivityStatus = 'unknown'
  private since: Date | null = null
  private checkedAt: Date | null = null
  private results: TargetResult[] = []
  private inflight: Promise<ConnectivitySnapshot> | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private readonly held = new Set<string>()

  constructor(options: ConnectivityMonitorOptions) {
    this.options = options
    this.location = options.location ?? DEFAULT_LOCATION
    this.config = options.config
    this.prober = options.prober ?? probeTarget
    this.now = options.now ?? (() => new Date())
  }

  snapshot(): ConnectivitySnapshot {
    return {
      location: this.location,
      status: this.status,
      since: this.since?.toISOString() ?? null,
      checkedAt: this.checkedAt?.toISOString() ?? null,
      results: this.results,
    }
  }

  /** The cached verdict when it is younger than `maxAgeMs` (default: the interval), else a probe. */
  async refresh({ maxAgeMs }: { maxAgeMs?: number } = {}): Promise<ConnectivitySnapshot> {
    const age = this.checkedAt ? this.now().getTime() - this.checkedAt.getTime() : Infinity
    if (age < (maxAgeMs ?? this.config.intervalMs)) return this.snapshot()
    // One probe at a time: concurrent checks share it.
    this.inflight ??= this.probe().finally(() => {
      this.inflight = null
    })
    return this.inflight
  }

  private async probe(): Promise<ConnectivitySnapshot> {
    const { online, results } = await probeConnectivity(this.config, this.prober)
    const previous = this.status
    const next: ConnectivityStatus = online ? 'online' : 'offline'
    const now = this.now()
    this.checkedAt = now
    this.results = results
    if (next !== previous) {
      this.status = next
      this.since = now
      const level = next === 'offline' ? 'warn' : 'info'
      log[level]({ location: this.location, previous, results }, `checker ${next}`)
    }
    const snapshot = this.snapshot()
    if (next !== previous) await this.callback(() => this.options.onChange?.(snapshot, previous))
    await this.callback(() => this.options.onProbe?.(snapshot))
    return snapshot
  }

  private async callback(fn: () => unknown): Promise<void> {
    try {
      await fn()
    } catch (err) {
      log.error({ err, location: this.location }, 'connectivity callback failed')
    }
  }

  /** Probe now and then every interval (the timer does not keep the process alive). */
  async start(): Promise<ConnectivitySnapshot> {
    this.stop()
    this.timer = setInterval(() => {
      void this.refresh({ maxAgeMs: 0 }).catch((err) =>
        log.error({ err, location: this.location }, 'connectivity probe failed'),
      )
    }, this.config.intervalMs)
    this.timer.unref?.()
    return this.refresh({ maxAgeMs: 0 })
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** Remember a monitor whose check was held, so it is re-checked when connectivity returns. */
  markHeld(monitorId: string | number): void {
    this.held.add(String(monitorId))
  }

  /** The monitors held since the last call (and forget them). */
  takeHeld(): string[] {
    const ids = [...this.held]
    this.held.clear()
    return ids
  }
}

const registry = new Map<string, ConnectivityMonitor>()

/** Install (or with `null` remove) the monitor of a location. */
export function setConnectivityMonitor(
  monitor: ConnectivityMonitor | null,
  location: string = monitor?.location ?? DEFAULT_LOCATION,
): void {
  registry.get(location)?.stop()
  if (monitor) registry.set(location, monitor)
  else registry.delete(location)
}

export function getConnectivityMonitor(
  location: string = DEFAULT_LOCATION,
): ConnectivityMonitor | null {
  return registry.get(location) ?? null
}

/**
 * Location whose connectivity judges `monitor`'s checks. Extension point for multi-location
 * checks (#92): a monitor will be checked from (and judged by) the location it is assigned to.
 */
export function connectivityLocationOf(_monitor: Monitor): string {
  return DEFAULT_LOCATION
}

// ---- Which monitors need the internet --------------------------------------------------------

/** Classifies private, loopback, link-local and CGNAT addresses (the guard's private set). */
const privateAddresses = new AddressPolicy({ denyPrivate: true })

const LOCAL_SUFFIXES = ['.localhost', '.local', '.lan', '.internal', '.home.arpa', '.localdomain']

/** A host that never needs the uplink by its name alone, or `null` when it must be resolved. */
function localByName(rawHost: string): boolean | null {
  const host = stripAddress(rawHost).toLowerCase().replace(/\.$/, '')
  if (net.isIP(host)) return privateAddresses.classify(host).allowed === false
  if (host === 'localhost' || !host.includes('.')) return true
  if (LOCAL_SUFFIXES.some((suffix) => host.endsWith(suffix))) return true
  return null
}

export type HostResolver = (host: string) => Promise<string[]>

const LOCAL_LOOKUP_TIMEOUT_MS = 2_000

const lookupAll: HostResolver = (host) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('lookup timed out')), LOCAL_LOOKUP_TIMEOUT_MS)
    dns.lookup(host, { all: true }, (err, addresses) => {
      clearTimeout(timer)
      if (err) reject(err)
      else resolve(addresses.map((a) => a.address))
    })
  })

/** Whether `host` is private/local: by name, or because every address it resolves to is. */
export async function isLocalHost(host: string, resolve: HostResolver = lookupAll) {
  const byName = localByName(host)
  if (byName !== null) return byName
  try {
    const addresses = await resolve(host)
    return (
      addresses.length > 0 && addresses.every((a) => privateAddresses.classify(a).allowed === false)
    )
  } catch {
    // The name does not resolve (DNS is probably what failed): treat it as external.
    return false
  }
}

const relationId = (value: unknown): string | number | null => {
  if (value === null || value === undefined || value === '') return null
  if (typeof value === 'object') return (value as { id?: string | number }).id ?? null
  return value as string | number
}

/** Hosts a monitor connects to; `local: true` when it only talks to this host (socket, group). */
async function monitorTargets(
  payload: Payload,
  monitor: Monitor,
): Promise<{ local: true } | { local: false; hosts: string[] }> {
  const hosts = (...values: (string | null | undefined)[]) => ({
    local: false as const,
    hosts: values.map((v) => looseHost(v)).filter((v): v is string => Boolean(v)),
  })
  switch (monitor.type) {
    case 'group':
    case 'manual':
      return { local: true }
    case 'push':
    case 'tailscale-ping':
      // Pushes come in from outside, and a tailnet needs its coordination server.
      return { local: false, hosts: [] }
    case 'http':
    case 'keyword':
    case 'json-query':
    case 'websocket-upgrade':
    case 'real-browser':
      return hosts(monitor.url)
    case 'dns':
      return hosts(...(monitor.dnsResolveServer ?? '').split(','))
    case 'mysql':
    case 'postgres':
    case 'sqlserver':
    case 'mongodb':
    case 'redis': {
      const targets = connectionTargets(monitor.databaseConnectionString ?? '')
      if (targets.localSocket) return { local: true }
      return { local: false, hosts: targets.srvName ? [targets.srvName] : targets.hosts }
    }
    case 'kafka-producer':
      return hosts(...(monitor.kafkaProducerBrokers ?? []))
    case 'rabbitmq':
      return hosts(...(monitor.rabbitmqNodes ?? []))
    case 'grpc-keyword':
      return hosts(monitor.grpcUrl?.replace(/^dns:(\/\/[^/]*\/)?/i, ''))
    case 'docker': {
      const id = relationId(monitor.dockerHost)
      const host =
        id === null
          ? null
          : ((await payload
              .findByID({ collection: 'docker-hosts', id, depth: 0, overrideAccess: true })
              .catch(() => null)) as DockerHost | null)
      if (host && host.connectionType !== 'tcp') return { local: true }
      return hosts(host?.url)
    }
    default:
      return hosts(monitor.hostname)
  }
}

/**
 * Does the monitor need the internet? `false` when every target is private or local (RFC 1918,
 * loopback, `.local` names, a Docker socket, group monitors): those keep running while the worker
 * is offline. Unknown targets count as external.
 */
export async function monitorNeedsInternet(
  payload: Payload,
  monitor: Monitor,
  resolve?: HostResolver,
): Promise<boolean> {
  const targets = await monitorTargets(payload, monitor)
  if (targets.local) return false
  if (targets.hosts.length === 0) return true
  for (const host of targets.hosts) {
    if (!(await isLocalHost(host, resolve))) return true
  }
  return false
}

// ---- The gate around a check -----------------------------------------------------------------

/** The result recorded instead of a check while the worker is offline. */
export const checkerOfflineResult = (): CheckResult => ({
  ok: false,
  msg: CHECKER_OFFLINE_MSG,
  checkerOffline: true,
})

/**
 * Run `check` unless the worker is offline and the monitor needs the internet; a failed check is
 * re-judged against a fresh probe. Returns the check's result, or `checkerOfflineResult()` when
 * the beat must be held. A pass-through when the connectivity check is disabled.
 */
export async function guardAgainstOfflineChecker(
  payload: Payload,
  monitor: Monitor,
  check: () => Promise<CheckResult>,
): Promise<CheckResult> {
  const connectivity = getConnectivityMonitor(connectivityLocationOf(monitor))
  if (!connectivity) return check()

  const hold = async (): Promise<boolean> => {
    if (!(await monitorNeedsInternet(payload, monitor))) return false
    connectivity.markHeld(monitor.id)
    return true
  }

  // The timer keeps the verdict fresh; only probe here when it fell far behind.
  const before = await connectivity.refresh({ maxAgeMs: connectivity.config.intervalMs * 2 })
  if (before.status === 'offline' && (await hold())) return checkerOfflineResult()

  const result = await check()
  if (result.ok || result.blocked || result.underMaintenance || before.status === 'offline') {
    return result
  }
  const after = await connectivity.refresh({ maxAgeMs: RECHECK_AFTER_FAILURE_MS })
  if (after.status === 'offline' && (await hold())) return checkerOfflineResult()
  return result
}
