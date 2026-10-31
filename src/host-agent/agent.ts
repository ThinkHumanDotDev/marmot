/**
 * The host agent (#136, `MARMOT_ROLE=host-agent`): collects a sample every interval
 * (`./collect.ts`, `./docker.ts`) and posts it to `POST /api/agent/v1/metrics` with the host
 * monitor's token. Outbound only; nothing listens. The server answers with the monitor's interval,
 * which the agent follows from then on. Failed posts are not queued: the next sample is newer, and
 * a missing one is what the monitor's grace period is for.
 */
import http from 'node:http'
import https from 'node:https'

import type { HostSample } from '@/lib/host-metrics'
import { childLogger } from '@/lib/logger'

import type { HostCollector } from './collect'
import { collectContainers } from './docker'

const log = childLogger('host-agent')

export const HOST_METRICS_PATH = '/api/agent/v1/metrics'
export const HOST_AGENT_USER_AGENT_PREFIX = 'marmot-host-agent/'
const REQUEST_TIMEOUT_MS = 30_000
const MIN_INTERVAL_SECONDS = 10

export interface PostResult {
  status: number
  body: unknown
}

export type Poster = (url: URL, token: string, body: string, version: string) => Promise<PostResult>

/** POST with `node:http(s)`: lighter than `fetch`, which loads undici. */
export const postSample: Poster = (url, token, body, version) =>
  new Promise((resolve, reject) => {
    const client = url.protocol === 'https:' ? https : http
    const req = client.request(
      url,
      {
        method: 'POST',
        timeout: REQUEST_TIMEOUT_MS,
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
          'user-agent': `${HOST_AGENT_USER_AGENT_PREFIX}${version}`,
        },
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => {
          let parsed: unknown = null
          try {
            parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
          } catch {
            // Not JSON (a proxy's error page): the status says enough.
          }
          resolve({ status: res.statusCode ?? 0, body: parsed })
        })
        res.on('error', reject)
      },
    )
    req.on('timeout', () => req.destroy(new Error('request timed out')))
    req.on('error', reject)
    req.end(body)
  })

export interface HostAgentOptions {
  url: string
  token: string
  version: string
  collector: Pick<HostCollector, 'collect'>
  /** Seconds between samples until the server names the monitor's interval. */
  interval: number
  /** Docker daemon socket, or `null` to skip container stats. */
  dockerSocket?: string | null
  post?: Poster
}

export class HostAgent {
  private interval: number
  private timer: ReturnType<typeof setTimeout> | null = null
  private running: Promise<unknown> | null = null
  private stopped = false
  private readonly endpoint: URL
  private dockerWarned = false

  constructor(private readonly options: HostAgentOptions) {
    this.interval = Math.max(MIN_INTERVAL_SECONDS, options.interval)
    // Relative to the base URL, so Marmot behind a path prefix works too.
    this.endpoint = new URL(HOST_METRICS_PATH.slice(1), options.url.replace(/\/?$/, '/'))
  }

  get intervalSeconds(): number {
    return this.interval
  }

  async start(): Promise<void> {
    this.stopped = false
    // The first CPU and network figures need two readings: send the first sample shortly after
    // start rather than a full interval later.
    this.schedule(5_000)
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    await this.running
  }

  private schedule(ms: number) {
    if (this.stopped) return
    this.timer = setTimeout(() => {
      const startedAt = Date.now()
      this.running = this.tick().finally(() => {
        this.running = null
        // A fixed rate: the time spent collecting (Docker stats take a second or two) does not
        // push the next sample later, so samples stay within the monitor's grace period.
        this.schedule(Math.max(1_000, this.interval * 1000 - (Date.now() - startedAt)))
      })
    }, ms)
    this.timer.unref?.()
  }

  /** Collect and send one sample. Never throws. */
  async tick(): Promise<PostResult | null> {
    let sample: HostSample
    try {
      sample = await this.options.collector.collect()
      if (this.options.dockerSocket) sample.containers = await this.containers()
    } catch (err) {
      log.error({ err }, 'failed to collect host metrics')
      return null
    }
    try {
      const post = this.options.post ?? postSample
      const result = await post(
        this.endpoint,
        this.options.token,
        JSON.stringify(sample),
        this.options.version,
      )
      this.handle(result)
      return result
    } catch (err) {
      log.warn({ err: (err as Error).message, url: this.endpoint.origin }, 'Marmot is unreachable')
      return null
    }
  }

  private async containers(): Promise<HostSample['containers']> {
    try {
      const containers = await collectContainers(this.options.dockerSocket!)
      this.dockerWarned = false
      return containers
    } catch (err) {
      if (!this.dockerWarned) {
        log.warn({ err: (err as Error).message }, 'cannot read container stats from Docker')
        this.dockerWarned = true
      }
      return null
    }
  }

  private handle(result: PostResult) {
    const body = (result.body ?? {}) as { interval?: unknown; error?: unknown }
    if (typeof body.interval === 'number' && body.interval >= MIN_INTERVAL_SECONDS) {
      if (body.interval !== this.interval) {
        log.info({ interval: body.interval }, 'following the monitor interval')
      }
      this.interval = body.interval
    }
    if (result.status === 200) {
      log.debug('sample delivered')
      return
    }
    const error = typeof body.error === 'string' ? body.error : `HTTP ${result.status}`
    if (result.status === 401) log.error('the host token was refused: check MARMOT_HOST_TOKEN')
    else if (result.status === 409) log.info('the host monitor is paused')
    else log.warn({ status: result.status, error }, 'sample refused')
  }
}
