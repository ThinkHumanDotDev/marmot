/**
 * Batching OTLP/HTTP exporter (#99): one instance per collector and process, reused for every
 * check. Data points wait up to `OTLP_EXPORT_INTERVAL_MS` (or until `OTLP_EXPORT_MAX_BATCH` are
 * queued) and leave in one `POST <endpoint>` with the JSON encoding of `ExportMetricsServiceRequest`.
 *
 * Requests go through `guardedFetch`, so the outbound address guard (`MONITOR_DENY_PRIVATE_ADDRESSES`,
 * `MONITOR_DENY_CIDRS`) applies to every connection; redirects are not followed. Following the OTLP
 * specification, 408, 429, 502, 503, 504 and network errors are retried (three attempts with
 * backoff, honouring `Retry-After`), other answers drop the batch. Nothing here ever throws into
 * the check pipeline: failures are logged and reported through `onResult`.
 */
import { childLogger } from '@/lib/logger'
import { OTEL_SCOPE_NAME } from '@/lib/otel'
import { MARMOT_VERSION } from '@/lib/version'
import { describeNetworkError } from '@/server/notification-providers/http'
import { findBlockedMessage, guardedFetch } from '@/server/security/outbound-guard'

import { encodeMetricsRequest, type AttributeValue, type MetricPoint } from './encode'
import type { OtelHeaders } from './headers'

const log = childLogger('otel:exporter')

export const OTEL_USER_AGENT = `Marmot/${MARMOT_VERSION} (OTLP/HTTP JSON)`
const RETRYABLE_STATUS = new Set([408, 429, 502, 503, 504])
const ERROR_SNIPPET_LENGTH = 300

export interface ExportResult {
  ok: boolean
  /** HTTP status of the last attempt (`null` for network errors and blocked addresses). */
  status: number | null
  error: string | null
  retryable: boolean
  /** Data points the receiver reported as rejected (`partialSuccess`). */
  rejected?: number
  retryAfterMs?: number
}

export interface ExporterTarget {
  /** Collector id (for logs). */
  id: string
  /** Full metrics URL (`metricsUrl()`). */
  url: string
  headers: OtelHeaders
  resource: Record<string, AttributeValue>
}

export interface ExporterOptions {
  intervalMs: number
  maxBatch: number
  maxQueue: number
  timeoutMs: number
  /** Attempts per batch (default 3). */
  maxAttempts?: number
  /** Backoff before the second attempt, doubled each time (default 1 s). */
  retryDelayMs?: number
  /** Called after each batch's final attempt. */
  onResult?: (result: ExportResult, points: number) => void | Promise<void>
}

const parseRetryAfter = (value: string | null): number | undefined => {
  if (!value) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000)
  const date = Date.parse(value)
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined
}

/** One POST of an encoded request; never throws. */
export async function postMetrics(
  url: string,
  headers: OtelHeaders,
  body: string,
  timeoutMs: number,
): Promise<ExportResult> {
  let response: Response
  try {
    response = await guardedFetch(url, {
      method: 'POST',
      headers: {
        ...headers,
        'Content-Type': 'application/json',
        'User-Agent': OTEL_USER_AGENT,
      },
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    const blocked = findBlockedMessage(err)
    return {
      ok: false,
      status: null,
      error: blocked ?? describeNetworkError(err),
      retryable: !blocked,
    }
  }
  let text = ''
  try {
    text = await response.text()
  } catch {
    // an unreadable body changes nothing
  }
  if (response.status >= 200 && response.status < 300) {
    let rejected: number | undefined
    try {
      const parsed = text ? (JSON.parse(text) as { partialSuccess?: Record<string, unknown> }) : {}
      const count = Number(parsed.partialSuccess?.rejectedDataPoints ?? 0)
      if (count > 0) rejected = count
    } catch {
      // not JSON: a plain 2xx is a success
    }
    return { ok: true, status: response.status, error: null, retryable: false, rejected }
  }
  const snippet = text.trim().slice(0, ERROR_SNIPPET_LENGTH)
  return {
    ok: false,
    status: response.status,
    error: `HTTP ${response.status}${snippet ? `: ${snippet}` : ''}`,
    retryable: RETRYABLE_STATUS.has(response.status),
    retryAfterMs: parseRetryAfter(response.headers.get('retry-after')),
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export class OtelExporter {
  private queue: MetricPoint[] = []
  private timer: NodeJS.Timeout | null = null
  private sending: Promise<void> = Promise.resolve()
  private dropped = 0
  private closed = false

  constructor(
    readonly target: ExporterTarget,
    private readonly options: ExporterOptions,
  ) {}

  get pending(): number {
    return this.queue.length
  }

  enqueue(points: readonly MetricPoint[]): void {
    if (this.closed || points.length === 0) return
    this.queue.push(...points)
    const overflow = this.queue.length - this.options.maxQueue
    if (overflow > 0) {
      // A collector that is down must not grow the worker's memory: the oldest points go first.
      this.queue.splice(0, overflow)
      this.dropped += overflow
    }
    if (this.queue.length >= this.options.maxBatch) {
      void this.flush()
    } else if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null
        void this.flush()
      }, this.options.intervalMs)
      this.timer.unref?.()
    }
  }

  /** Sends everything queued so far; resolves when it has been sent (or given up on). */
  flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.sending = this.sending.then(() => this.drain())
    return this.sending
  }

  /** Flushes and stops accepting points. */
  async close(): Promise<void> {
    await this.flush()
    this.closed = true
  }

  private async drain(): Promise<void> {
    if (this.dropped > 0) {
      log.warn(
        { collector: this.target.id, dropped: this.dropped },
        'OTLP export queue full; oldest data points dropped',
      )
      this.dropped = 0
    }
    while (this.queue.length > 0) {
      const batch = this.queue.splice(0, this.options.maxBatch)
      await this.send(batch)
    }
  }

  private async send(batch: MetricPoint[]): Promise<void> {
    const body = JSON.stringify(
      encodeMetricsRequest(batch, this.target.resource, {
        name: OTEL_SCOPE_NAME,
        version: MARMOT_VERSION,
      }),
    )
    const attempts = Math.max(1, this.options.maxAttempts ?? 3)
    let delay = this.options.retryDelayMs ?? 1_000
    let result: ExportResult = { ok: false, status: null, error: null, retryable: false }
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      result = await postMetrics(this.target.url, this.target.headers, body, this.options.timeoutMs)
      if (result.ok || !result.retryable || attempt === attempts) break
      await sleep(Math.min(result.retryAfterMs ?? delay, 30_000))
      delay *= 2
    }
    if (result.ok && result.rejected) {
      log.warn(
        { collector: this.target.id, rejected: result.rejected },
        'OTLP collector rejected some data points',
      )
    } else if (!result.ok) {
      log.warn(
        { collector: this.target.id, status: result.status, error: result.error },
        'OTLP export failed; batch dropped',
      )
    }
    try {
      await this.options.onResult?.(result, batch.length)
    } catch (err) {
      log.error({ err, collector: this.target.id }, 'OTLP export bookkeeping failed')
    }
  }
}
