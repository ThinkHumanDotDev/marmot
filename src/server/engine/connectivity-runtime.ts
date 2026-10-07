/**
 * Worker wiring of the self connectivity check (#148): starts the probe timer, publishes every
 * verdict to Redis (`connectivity-state.ts`), broadcasts status changes to the UI, sends one
 * "checker offline" notice per outage (and a "back online" one when it ends) to the instance
 * superadmins and/or one notification channel, and re-checks the monitors whose beats were held
 * as soon as connectivity returns.
 */
import os from 'node:os'

import type { Redis } from 'ioredis'
import type { Payload } from 'payload'

import { env } from '@/env'
import { toLocale, getStaticFormatter } from '@/i18n/translator'
import type { Locale } from '@/i18n/locales'
import { childLogger } from '@/lib/logger'
import type { Notification, User } from '@/payload-types'
import { getChannelLocale, sendNotification } from '@/server/notifications/send'
import { serverTranslator } from '@/server/i18n'
import { emitCheckerStatus } from '@/server/realtime/emitter'
import { createRedis } from '@/server/redis'
import {
  ConnectivityMonitor,
  connectivityConfigFromEnv,
  DEFAULT_LOCATION,
  setConnectivityMonitor,
  type ConnectivityConfig,
  type ConnectivitySnapshot,
  type TargetProber,
  type TargetResult,
} from './connectivity'
import { getCheckerSummary, publishCheckerState } from './connectivity-state'
import { CHECK_JOB_NAME } from './names'
import { getChecksQueue, type ChecksQueue } from './queues'

const log = childLogger('engine:connectivity')

// ---- Notices ---------------------------------------------------------------------------------

export interface CheckerNotice {
  kind: 'offline' | 'online'
  location: string
  /** When the status changed (ISO). */
  at: string
  /** `online`: when the outage began (ISO). */
  offlineSince?: string | null
  /** `offline`: the probe results that decided it. */
  results?: TargetResult[]
}

/** Subject and plain-text body of a notice in `locale` (times in UTC). */
export function renderCheckerNotice(
  notice: CheckerNotice,
  locale?: Locale,
): { subject: string; text: string } {
  const t = serverTranslator(locale)
  const format = getStaticFormatter(locale)
  const time = format.dateTime(new Date(notice.at), 'zoned')
  if (notice.kind === 'offline') {
    const results = (notice.results ?? [])
      .map((r) => `${r.target} ${r.ok ? 'ok' : `failed${r.error ? ` (${r.error})` : ''}`}`)
      .join('; ')
    const text = t('email.checker.offlineText', { time, location: notice.location })
    return {
      subject: t('email.checker.offlineSubject'),
      text: results ? `${text}\n\n${t('email.checker.results', { results })}` : text,
    }
  }
  const since = notice.offlineSince ? new Date(notice.offlineSince).getTime() : null
  const minutes =
    since === null ? 0 : Math.max(0, Math.round((Date.parse(notice.at) - since) / 60_000))
  return {
    subject: t('email.checker.onlineSubject'),
    text: t('email.checker.onlineText', { time, location: notice.location, minutes }),
  }
}

export type CheckerNoticeDeliverer = (payload: Payload, notice: CheckerNotice) => Promise<void>

/**
 * Default delivery: an email to every superadmin (`CONNECTIVITY_CHECK_NOTIFY_EMAIL`, in their
 * language) and a message through the channel `CONNECTIVITY_CHECK_NOTIFICATION_ID`. Throws when a
 * delivery failed, so the outbox retries it (mail usually needs the uplink that just went away).
 */
export const deliverCheckerNotice: CheckerNoticeDeliverer = async (payload, notice) => {
  if (env.CONNECTIVITY_CHECK_NOTIFY_EMAIL) {
    const { docs } = await payload.find({
      collection: 'users',
      where: { superadmin: { equals: true } },
      depth: 0,
      limit: 0,
      pagination: false,
      overrideAccess: true,
    })
    for (const user of docs as User[]) {
      const { subject, text } = renderCheckerNotice(notice, toLocale(user.language))
      await payload.sendEmail({ to: user.email, subject, text })
    }
  }
  const channelId = env.CONNECTIVITY_CHECK_NOTIFICATION_ID?.trim()
  if (channelId) {
    const id =
      payload.db.defaultIDType === 'number' && /^\d+$/.test(channelId)
        ? Number(channelId)
        : channelId
    const channel = (await payload
      .findByID({ collection: 'notifications', id, depth: 0, overrideAccess: true })
      .catch(() => null)) as Notification | null
    if (!channel) {
      log.warn({ channelId }, 'CONNECTIVITY_CHECK_NOTIFICATION_ID does not name a channel')
      return
    }
    const locale = await getChannelLocale(payload, channel)
    const { subject, text } = renderCheckerNotice(notice, locale)
    await sendNotification(payload, channel, {
      message: `${subject}\n${text}`,
      monitor: null,
      heartbeat: null,
      locale,
    })
  }
}

/** Notices waiting for delivery, retried in order after every probe until they go through. */
export class CheckerNoticeOutbox {
  private readonly pending: CheckerNotice[] = []

  constructor(
    private readonly deliver: (notice: CheckerNotice) => Promise<void>,
    private readonly max = 20,
  ) {}

  push(notice: CheckerNotice): void {
    this.pending.push(notice)
    if (this.pending.length > this.max) this.pending.shift()
  }

  get size(): number {
    return this.pending.length
  }

  private flushing: Promise<void> | null = null

  /** Deliver what is pending, in order; stops at the first failure. One flush at a time. */
  flush(): Promise<void> {
    this.flushing ??= this.drain().finally(() => {
      this.flushing = null
    })
    return this.flushing
  }

  private async drain(): Promise<void> {
    while (this.pending.length > 0) {
      try {
        await this.deliver(this.pending[0])
        this.pending.shift()
      } catch (err) {
        log.warn(
          { err, kind: this.pending[0].kind },
          'checker notice not delivered yet; will retry',
        )
        return
      }
    }
  }
}

/**
 * Only one worker per location sends the notices of an outage: the first to claim it in Redis.
 * Without Redis every worker sends (duplicates beat silence).
 */
export interface NoticeClaim {
  acquire(location: string): Promise<boolean>
  release(location: string): Promise<void>
}

const NOTICE_CLAIM_PREFIX = 'marmot:connectivity:notice:'
const NOTICE_CLAIM_TTL_SECONDS = 24 * 60 * 60

export function redisNoticeClaim(
  redis: Redis,
  worker: string,
  prefix = NOTICE_CLAIM_PREFIX,
): NoticeClaim {
  return {
    async acquire(location) {
      try {
        const key = `${prefix}${location}`
        const set = await redis.set(key, worker, 'EX', NOTICE_CLAIM_TTL_SECONDS, 'NX')
        return set === 'OK' || (await redis.get(key)) === worker
      } catch (err) {
        log.warn({ err }, 'cannot claim the checker notice; sending it anyway')
        return true
      }
    },
    async release(location) {
      try {
        const key = `${prefix}${location}`
        if ((await redis.get(key)) === worker) await redis.del(key)
      } catch {
        // The claim expires on its own.
      }
    },
  }
}

// ---- Startup ---------------------------------------------------------------------------------

export interface StartConnectivityCheckOptions {
  /** Defaults to `CONNECTIVITY_CHECK_*`; `null` (or the check disabled) starts nothing. */
  config?: ConnectivityConfig | null
  location?: string
  prober?: TargetProber
  deliver?: CheckerNoticeDeliverer
  /** Redis for the published state and the notice claim (a dedicated connection by default). */
  redis?: Redis
  /** Key prefix of the published state (tests). */
  statePrefix?: string
  /** Key prefix of the notice claim (tests). */
  claimPrefix?: string
  /** Queue the held monitors are re-checked on. */
  queue?: Pick<ChecksQueue, 'add'>
  /** Worker id in the published state; `hostname:pid` by default. */
  worker?: string
  /** Clock (tests). */
  now?: () => Date
}

export interface ConnectivityCheckHandle {
  monitor: ConnectivityMonitor
  outbox: CheckerNoticeOutbox
  stop(): Promise<void>
}

/** Start the check for this worker and install it for `guardAgainstOfflineChecker`. */
export async function startConnectivityCheck(
  payload: Payload,
  options: StartConnectivityCheckOptions = {},
): Promise<ConnectivityCheckHandle | null> {
  const config = options.config === undefined ? connectivityConfigFromEnv() : options.config
  if (!config) return null

  const location = options.location ?? DEFAULT_LOCATION
  const worker = options.worker ?? `${os.hostname()}:${process.pid}`
  const ownsRedis = !options.redis
  const redis = options.redis ?? createRedis({ maxRetriesPerRequest: 1, commandTimeout: 2_000 })
  const claim = redisNoticeClaim(redis, worker, options.claimPrefix)
  const deliver = options.deliver ?? deliverCheckerNotice
  const outbox = new CheckerNoticeOutbox((notice) => deliver(payload, notice))
  const ttlSeconds = Math.max(60, Math.ceil((config.intervalMs * 3) / 1000))
  const stateOptions = { redis, prefix: options.statePrefix }

  const publish = (snapshot: ConnectivitySnapshot) =>
    publishCheckerState(snapshot, worker, ttlSeconds, stateOptions).catch((err) =>
      log.warn({ err }, 'cannot publish the checker status'),
    )

  /** This worker announced the current outage and owes the "back online" notice. */
  let announced: { since: string | null } | null = null

  const monitor = new ConnectivityMonitor({
    location,
    config,
    prober: options.prober,
    now: options.now,
    onChange: async (snapshot, previous) => {
      await publish(snapshot)
      const summary = await getCheckerSummary(stateOptions)
      emitCheckerStatus({ status: summary.status, since: summary.since })

      if (snapshot.status === 'offline') {
        if (await claim.acquire(location)) {
          announced = { since: snapshot.since }
          outbox.push({
            kind: 'offline',
            location,
            at: snapshot.since ?? new Date().toISOString(),
            results: snapshot.results,
          })
        }
        return
      }
      if (snapshot.status === 'online' && previous === 'offline') {
        if (announced) {
          outbox.push({
            kind: 'online',
            location,
            at: snapshot.since ?? new Date().toISOString(),
            offlineSince: announced.since,
          })
          announced = null
          await claim.release(location)
        }
        // Re-judge the held monitors now instead of waiting for their next interval.
        const queue = options.queue ?? getChecksQueue()
        for (const monitorId of monitor.takeHeld()) {
          await queue
            .add(CHECK_JOB_NAME, { monitorId }, { removeOnComplete: 100, removeOnFail: 100 })
            .catch((err) => log.warn({ err, monitorId }, 'cannot enqueue the re-check'))
        }
      }
    },
    onProbe: async (snapshot) => {
      await publish(snapshot)
      // In the background: a mail server that is unreachable must not stall the checks.
      void outbox.flush()
    },
  })

  setConnectivityMonitor(monitor, location)
  const first = await monitor.start()
  log.info(
    {
      location,
      status: first.status,
      targets: config.targets.map((t) => t.label),
      mode: config.mode,
    },
    'connectivity check started',
  )

  return {
    monitor,
    outbox,
    async stop() {
      setConnectivityMonitor(null, location)
      if (ownsRedis) await redis.quit().catch(() => undefined)
    },
  }
}
