/**
 * RabbitMQ monitor: calls the management API `GET /api/health/checks/alarms/` of each node in
 * `rabbitmqNodes` with `rabbitmqUsername`/`rabbitmqPassword`; UP as soon as one node answers 200
 * (no alarms in the cluster). Uses the global `fetch`, no driver.
 *
 * Ported from Uptime Kuma 2.5.5 `server/monitor-types/rabbitmq.js` — Copyright (c) 2021 Louis Lam,
 * MIT License. See THIRD_PARTY_NOTICES.md.
 */
import type { Monitor } from '@/payload-types'

import { registerMonitorType } from './registry'
import { checkTimeoutMs, errorMessage } from './util'

/** Non-empty node base URLs, or a readable error. */
export function rabbitmqNodes(monitor: Pick<Monitor, 'rabbitmqNodes'>): string[] {
  const nodes = (monitor.rabbitmqNodes ?? []).map((n) => n.trim()).filter(Boolean)
  if (nodes.length === 0) throw new Error('No RabbitMQ nodes configured')
  for (const node of nodes) {
    if (!/^https?:\/\//i.test(node)) throw new Error(`Invalid RabbitMQ node URL: ${node}`)
  }
  return nodes
}

/** `<baseUrl>/api/health/checks/alarms/`, keeping any path prefix of the base URL. */
export function alarmsUrl(baseUrl: string): string {
  // Without a trailing slash the last path segment of baseUrl would be dropped by `new URL`.
  const normalized = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`
  return new URL('api/health/checks/alarms/', normalized).href
}

/** `fetch` wraps network errors as "fetch failed"; surface the cause (ECONNREFUSED, …). */
function fetchErrorMessage(err: unknown): string {
  const cause = (err as { cause?: unknown })?.cause
  if (cause instanceof Error && cause.message) return cause.message
  return errorMessage(err)
}

async function checkSingleNode(
  monitor: Pick<Monitor, 'rabbitmqUsername' | 'rabbitmqPassword'>,
  baseUrl: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<void> {
  const credentials = Buffer.from(
    `${monitor.rabbitmqUsername ?? ''}:${monitor.rabbitmqPassword ?? ''}`,
  ).toString('base64')
  let res: Response
  try {
    res = await fetch(alarmsUrl(baseUrl), {
      method: 'GET',
      headers: { Accept: 'application/json', Authorization: `Basic ${credentials}` },
      signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
      redirect: 'follow',
    })
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      throw new Error('Request timed out')
    }
    throw new Error(fetchErrorMessage(err))
  }
  if (res.status === 200) return
  if (res.status === 503) {
    // The management API reports the alarm reason in the body.
    const body = (await res.json().catch(() => null)) as { reason?: string } | null
    throw new Error(body?.reason || '503 - Service Unavailable')
  }
  throw new Error(`${res.status} - ${res.statusText}`)
}

registerMonitorType({
  name: 'rabbitmq',
  label: 'RabbitMQ',
  group: 'specific',
  async check(ctx) {
    const nodes = rabbitmqNodes(ctx.monitor)
    const timeout = checkTimeoutMs(ctx.monitor)
    const errors: string[] = []
    const startTime = Date.now()

    for (let i = 0; i < nodes.length; i++) {
      try {
        await checkSingleNode(ctx.monitor, nodes[i], timeout, ctx.signal)
        ctx.heartbeat.ping = Date.now() - startTime
        ctx.heartbeat.status = 'up'
        ctx.heartbeat.msg =
          nodes.length === 1
            ? 'Node is reachable and there are no alerts in the cluster'
            : `One of the ${nodes.length} nodes is reachable and there are no alerts in the cluster`
        return
      } catch (err) {
        errors.push(`Node ${i + 1}: ${errorMessage(err)}`)
      }
    }
    throw new Error(`All ${errors.length} nodes failed because ${errors.join('; ')}`)
  },
})
