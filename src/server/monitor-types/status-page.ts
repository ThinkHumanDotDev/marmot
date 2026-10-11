/**
 * Third-party status page monitor (#125): follows a vendor's hosted status page (Atlassian
 * Statuspage, Instatus, Better Stack, incident.io, Marmot, or an RSS / Atom incident feed) and maps
 * its indicator, optionally narrowed to some of its components, to the monitor's status.
 */
import type { Monitor } from '@/payload-types'
import {
  parseStatusPageComponents,
  STATUS_PAGE_PROVIDERS,
  type StatusPageProviderSetting,
} from '@/lib/validation/status-page-monitor'
import { vendorVerdict, type VendorProvider } from '@/lib/vendor-status'

import { fetchVendorStatus } from './status-page-fetch'
import { registerMonitorType } from './registry'
import { requireField } from './util'

/**
 * The format auto-detection found for a monitor's URL, so later checks start with it instead of
 * probing every format again. Per worker process; a miss simply detects again.
 */
const detected = new Map<string, VendorProvider>()

const detectionKey = (monitor: Pick<Monitor, 'id' | 'url'>) => `${monitor.id}:${monitor.url ?? ''}`

/** Forgets the detected formats (tests). */
export function resetDetectedProviders(): void {
  detected.clear()
}

const providerSetting = (value: unknown): StatusPageProviderSetting =>
  (STATUS_PAGE_PROVIDERS as readonly string[]).includes(String(value))
    ? (value as StatusPageProviderSetting)
    : 'auto'

registerMonitorType({
  name: 'status-page',
  label: 'Third-party status page',
  group: 'specific',
  allowCustomStatus: true,
  async check(ctx) {
    const { monitor } = ctx
    const url = requireField(monitor.url, 'Status page URL')
    const setting = providerSetting(monitor.statusPageProvider)
    const key = detectionKey(monitor)
    const startedAt = Date.now()

    let result
    try {
      result = await fetchVendorStatus(url, setting, ctx.signal, detected.get(key))
    } catch (err) {
      detected.delete(key)
      throw err
    }
    if (setting === 'auto') detected.set(key, result.provider)

    // The vendor's cache lifetime stretches the interval (see `effectiveIntervalMs`).
    ctx.cacheSeconds = result.cacheSeconds
    ctx.heartbeat.ping = Date.now() - startedAt

    const filter = parseStatusPageComponents(monitor.statusPageComponents)
    const verdict = vendorVerdict(result.status, filter)
    if (filter.length > 0 && verdict.missing.length === filter.length) {
      // Every filtered component is gone: nothing left to judge, which is never "up".
      throw new Error(verdict.msg)
    }
    if (verdict.status === 'down') throw new Error(verdict.msg)
    ctx.heartbeat.status = verdict.status
    ctx.heartbeat.msg = verdict.msg
  },
})
