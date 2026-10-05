/**
 * Worker-side glue for the expiry warnings: a heartbeat listener that, after each check,
 *
 * - resets the certificate history when the server presented a new certificate, then runs the
 *   TLS thresholds when `expiryNotification` is on (`cert-expiry.ts`);
 * - refreshes the cached RDAP lookup when it is stale and runs the domain thresholds when
 *   `domainExpiryNotification` is on (`domain-expiry.ts`).
 *
 * Messages go straight through `sendNotification` to the monitor's active channels, like Uptime
 * Kuma, because the heartbeat queue renders status messages only.
 */
import type { Payload } from 'payload'

import { childLogger } from '@/lib/logger'
import type { Monitor, Notification } from '@/payload-types'
import { registerHeartbeatListener, type HeartbeatEvent } from '@/server/engine/hooks'
import { getMonitorNotifications, sendNotification } from '@/server/notifications'
import { getInstanceSettings } from '@/server/settings'
import { notifyCertExpiry, type CertExpiryNotice, type ExpirySender } from './cert-expiry'
import {
  domainRenewed,
  extractDomain,
  isDomainExpiryInfo,
  isDomainExpiryStale,
  lookupDomainExpiry,
  notifyDomainExpiry,
  type DomainExpiryInfo,
  type DomainExpiryNotice,
  type LookupOptions,
} from './domain-expiry'
import { createPayloadSentHistory, type SentHistoryStore } from './expiry-history'

const log = childLogger('expiry')

type ExpiryEvent = Pick<HeartbeatEvent, 'monitor' | 'heartbeat' | 'organizationId'> &
  Partial<Pick<HeartbeatEvent, 'tlsInfo' | 'certChanged'>>

/** Sender that fans one message out to the given channels; `true` when any delivery succeeded. */
export function createChannelSender(
  payload: Payload,
  monitor: Monitor,
  channels: Notification[],
): ExpirySender {
  return async (message) => {
    let sent = false
    for (const channel of channels) {
      try {
        await sendNotification(payload, channel, { message, monitor, heartbeat: null })
        sent = true
      } catch (err) {
        log.error(
          { err, notificationId: channel.id, type: channel.type, monitorId: monitor.id },
          'cannot send expiry warning',
        )
      }
    }
    return sent
  }
}

export interface ProcessExpiryOptions {
  history?: SentHistoryStore
  lookup?: LookupOptions
  now?: Date
}

/**
 * Certificate side of a heartbeat: reset the history on a new certificate, then check thresholds.
 * Mirrors Uptime Kuma's `handleTlsInfo` (skipped with `ignoreTls`, like Kuma).
 */
export async function processCertExpiry(
  payload: Payload,
  event: ExpiryEvent,
  options: ProcessExpiryOptions = {},
): Promise<CertExpiryNotice[]> {
  const { monitor, tlsInfo } = event
  if (!tlsInfo?.certInfo) return []
  const history = options.history ?? createPayloadSentHistory(payload, event.organizationId)

  if (event.certChanged) {
    log.debug({ monitorId: monitor.id }, 'new certificate; resetting sent history')
    await history.clear('certificate', monitor.id)
  }
  if (!monitor.expiryNotification || monitor.ignoreTls) return []

  const channels = await getMonitorNotifications(payload, monitor)
  if (channels.length === 0) return []
  const { tlsExpiryNotifyDays } = await getInstanceSettings(payload)
  return notifyCertExpiry({
    monitor,
    tlsInfo,
    notifyDays: tlsExpiryNotifyDays,
    history,
    send: createChannelSender(payload, monitor, channels),
  })
}

/** Monitors whose RDAP lookup is in flight (checks of one monitor can overlap at high concurrency). */
const inflight = new Set<string>()

/**
 * Domain side of a heartbeat: refresh `monitors.domainExpiry` when stale (at most daily), then
 * check thresholds. Returns the cached/refreshed info plus the notice that was sent, if any.
 */
export async function processDomainExpiry(
  payload: Payload,
  event: ExpiryEvent,
  options: ProcessExpiryOptions = {},
): Promise<{ info: DomainExpiryInfo | null; notice: DomainExpiryNotice | null }> {
  const { monitor } = event
  if (!monitor.domainExpiryNotification || event.heartbeat.status === 'maintenance') {
    return { info: null, notice: null }
  }
  const host = extractDomain(monitor)
  if (!host) return { info: null, notice: null }

  const now = options.now ?? new Date()
  const history = options.history ?? createPayloadSentHistory(payload, event.organizationId)
  const key = String(monitor.id)
  let info: DomainExpiryInfo | null = isDomainExpiryInfo(monitor.domainExpiry)
    ? monitor.domainExpiry
    : null

  if (!info || info.host !== host || isDomainExpiryStale(info, now)) {
    if (inflight.has(key)) return { info, notice: null }
    inflight.add(key)
    try {
      const next = await lookupDomainExpiry(host, { ...options.lookup, now })
      if (next.error) {
        log.warn({ monitorId: monitor.id, host, error: next.error }, 'domain expiry lookup failed')
      } else if (info && info.host === host && domainRenewed(info, next)) {
        log.info(
          { monitorId: monitor.id, domain: next.domain },
          'domain renewed; resetting history',
        )
        await history.clear('domain', monitor.id)
      } else if (info && info.host !== host) {
        // The monitor now points at another name: earlier warnings were about a different domain.
        await history.clear('domain', monitor.id)
      }
      await payload.update({
        collection: 'monitors',
        id: monitor.id,
        depth: 0,
        overrideAccess: true,
        context: { skipEngineSync: true },
        data: { domainExpiry: next as unknown as Monitor['domainExpiry'] },
      })
      info = next
    } finally {
      inflight.delete(key)
    }
  }

  if (!info?.expiresAt) return { info, notice: null }
  const channels = await getMonitorNotifications(payload, monitor)
  if (channels.length === 0) return { info, notice: null }
  const { domainExpiryNotifyDays } = await getInstanceSettings(payload)
  const notice = await notifyDomainExpiry({
    monitor,
    info,
    notifyDays: domainExpiryNotifyDays,
    history,
    send: createChannelSender(payload, monitor, channels),
    now,
  })
  return { info, notice }
}

/**
 * Hook both expiry checks into the engine's heartbeat fan-out (worker process only). Failures are
 * logged and never reach the check pipeline. Returns the unsubscribe function.
 */
export function registerExpiryNotificationListener(
  payload: Payload,
  options: ProcessExpiryOptions = {},
): () => void {
  const unsubscribe = registerHeartbeatListener(async (event) => {
    try {
      await processCertExpiry(payload, event, options)
    } catch (err) {
      log.error({ err, monitorId: event.monitor.id }, 'certificate expiry check failed')
    }
    try {
      await processDomainExpiry(payload, event, options)
    } catch (err) {
      log.error({ err, monitorId: event.monitor.id }, 'domain expiry check failed')
    }
  })
  log.info('expiry notification heartbeat listener registered')
  return unsubscribe
}
