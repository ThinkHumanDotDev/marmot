/**
 * Default notification text and a tiny, safe template renderer.
 *
 * The default text mirrors Uptime Kuma 2.5.5 `Monitor.sendNotification`
 * (`server/model/monitor.js`, MIT, Louis Lam): `[monitor.name] [✅ Up] msg`. Templates support
 * `{{ path }}` placeholders resolved against an allow-listed context — no expressions, no eval.
 */
import { extractAddress } from '@/server/notification-providers/http'
import type { Heartbeat, Monitor } from '@/payload-types'

export type NotificationStatus = Heartbeat['status']

export const STATUS_LABELS: Record<NotificationStatus, string> = {
  up: '✅ Up',
  down: '🔴 Down',
  pending: '⚠️ Pending',
  maintenance: '🔧 Maintenance',
}

export const TEST_STATUS_LABEL = '⚠️ Test'

export function statusLabel(status: NotificationStatus | null | undefined): string {
  return status ? STATUS_LABELS[status] : TEST_STATUS_LABEL
}

/** `[name] [🔴 Down] msg` — what every provider sends unless it formats richer content. */
export function buildDefaultMessage(monitor: Monitor | null, heartbeat: Heartbeat | null): string {
  const name = monitor?.name ?? 'Marmot'
  const label = statusLabel(heartbeat?.status)
  const msg = heartbeat?.msg?.trim() || (heartbeat ? 'N/A' : 'Test notification')
  return `[${name}] [${label}] ${msg}`
}

/** Message used by the "Test" button. */
export function buildTestMessage(channelName?: string): string {
  return `[Marmot] [${TEST_STATUS_LABEL}] ${channelName ? `"${channelName}" is configured correctly.` : 'Testing'}`
}

/** Variables available to `{{ }}` templates. Keep this list in `docs/notifications.md`. */
export interface TemplateContext {
  msg: string
  status: string
  name: string
  hostnameOrURL: string
  monitor: {
    id: string
    name: string
    type: string
    url: string
    hostname: string
    port: string
    description: string
  } | null
  heartbeat: {
    status: string
    msg: string
    ping: string
    time: string
    duration: string
    retries: string
    downCount: string
  } | null
}

const str = (value: unknown): string =>
  value === null || value === undefined ? '' : typeof value === 'string' ? value : String(value)

export function buildTemplateContext(
  message: string,
  monitor: Monitor | null,
  heartbeat: Heartbeat | null,
): TemplateContext {
  return {
    msg: message,
    status: statusLabel(heartbeat?.status),
    name: monitor?.name ?? 'Monitor Name not available',
    hostnameOrURL: monitor ? extractAddress(monitor) : 'testing.hostname',
    monitor: monitor
      ? {
          id: str(monitor.id),
          name: str(monitor.name),
          type: str(monitor.type),
          url: str(monitor.url),
          hostname: str(monitor.hostname),
          port: str(monitor.port),
          description: str(monitor.description),
        }
      : null,
    heartbeat: heartbeat
      ? {
          status: str(heartbeat.status),
          msg: str(heartbeat.msg),
          ping: str(heartbeat.ping),
          time: str(heartbeat.time),
          duration: str(heartbeat.duration),
          retries: str(heartbeat.retries),
          downCount: str(heartbeat.downCount),
        }
      : null,
  }
}

const PLACEHOLDER = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)\s*\}\}/g

/** Resolve `a.b.c` against a plain-data context; unknown paths resolve to ''. */
function lookup(context: TemplateContext, path: string): string {
  let current: unknown = context
  for (const segment of path.split('.')) {
    if (current === null || typeof current !== 'object') return ''
    if (!Object.prototype.hasOwnProperty.call(current, segment)) return ''
    current = (current as Record<string, unknown>)[segment]
  }
  if (current === null || current === undefined) return ''
  return typeof current === 'object' ? JSON.stringify(current) : String(current)
}

/**
 * Replace `{{ monitor.name }}`-style placeholders. Anything that is not a plain dotted path is left
 * untouched, so templates can never execute code or reach outside the context object.
 */
export function renderTemplate(template: string, context: TemplateContext): string {
  return template.replace(PLACEHOLDER, (_match, path: string) => lookup(context, path))
}

/** Convenience: render against monitor/heartbeat/message in one call. */
export function renderMessageTemplate(
  template: string,
  message: string,
  monitor: Monitor | null,
  heartbeat: Heartbeat | null,
): string {
  return renderTemplate(template, buildTemplateContext(message, monitor, heartbeat))
}

/** `2026-03-10 10:30:00 (UTC)` style timestamp for messages. */
export function formatHeartbeatTime(heartbeat: Heartbeat | null): string {
  if (!heartbeat?.time) return ''
  const date = new Date(heartbeat.time)
  if (Number.isNaN(date.getTime())) return heartbeat.time
  return `${date.toISOString().replace('T', ' ').slice(0, 19)} (UTC)`
}
