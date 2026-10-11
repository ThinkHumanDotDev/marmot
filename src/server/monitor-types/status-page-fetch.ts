/**
 * Fetching and auto-detection for the third-party status page monitor (#125). Every request goes
 * through the outbound address guard; the vendor's cache headers are returned so the scheduler can
 * stretch the interval to the document's `max-age`.
 */
import { MARMOT_VERSION } from '@/lib/version'
import { guardedFetch } from '@/server/security/outbound-guard'

import {
  feedLinkFromHtml,
  isAtlassianSummary,
  isBetterStackIndex,
  isFeed,
  isIncidentIoWidget,
  isInstatusSummary,
  parseAtlassian,
  parseBetterStack,
  parseFeed,
  parseIncidentIo,
  parseInstatus,
  VendorFormatError,
  type VendorProvider,
  type VendorStatus,
} from '@/lib/vendor-status'

/** Bodies above this are not status documents; reading stops there. */
const MAX_BODY_BYTES = 2 * 1024 * 1024
/** A vendor's `max-age` never stretches the interval beyond an hour. */
export const MAX_CACHE_SECONDS = 3600

export interface FetchedDocument {
  url: string
  status: number
  contentType: string
  body: string
  /** `Cache-Control: max-age` (or `Expires` − `Date`) in seconds; `null` when absent. */
  cacheSeconds: number | null
}

export interface VendorFetchResult {
  status: VendorStatus
  /** The format that answered (what auto-detection found). */
  provider: VendorProvider
  /** Freshness lifetime of the main document, capped at `MAX_CACHE_SECONDS`. */
  cacheSeconds: number | null
}

/** Freshness lifetime from response headers: `max-age` wins over `Expires`. */
export function cacheLifetimeSeconds(headers: Headers, now: Date = new Date()): number | null {
  const cacheControl = headers.get('cache-control') ?? ''
  if (/\b(no-store|no-cache)\b/i.test(cacheControl)) return null
  const maxAge = /(?:^|[,\s])max-age\s*=\s*"?(\d+)"?/i.exec(cacheControl)
  if (maxAge) return Math.min(Number(maxAge[1]), MAX_CACHE_SECONDS)
  const expires = headers.get('expires')
  if (!expires) return null
  const expiresAt = Date.parse(expires)
  if (Number.isNaN(expiresAt)) return null
  const date = Date.parse(headers.get('date') ?? '')
  const from = Number.isNaN(date) ? now.getTime() : date
  const seconds = Math.floor((expiresAt - from) / 1000)
  return seconds > 0 ? Math.min(seconds, MAX_CACHE_SECONDS) : null
}

async function readCapped(res: Response): Promise<string> {
  const reader = res.body?.getReader()
  if (!reader) return ''
  const chunks: Uint8Array[] = []
  let size = 0
  while (size < MAX_BODY_BYTES) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    size += value.byteLength
  }
  await reader.cancel().catch(() => undefined)
  return Buffer.concat(chunks).subarray(0, MAX_BODY_BYTES).toString('utf8')
}

/** `fetch` wraps network errors as "fetch failed"; surface the cause (ECONNREFUSED, …). */
function fetchErrorMessage(err: unknown): string {
  const cause = (err as { cause?: unknown })?.cause
  if (cause instanceof Error && cause.message) return cause.message
  return err instanceof Error ? err.message : String(err)
}

export async function fetchDocument(
  url: string,
  signal: AbortSignal,
  accept = 'application/json',
): Promise<FetchedDocument> {
  let res: Response
  try {
    res = await guardedFetch(url, {
      method: 'GET',
      headers: {
        Accept: accept,
        'User-Agent': `Marmot/${MARMOT_VERSION} (+https://github.com/ThinkHumanDotDev/marmot)`,
      },
      redirect: 'follow',
      signal,
    })
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      throw err
    }
    throw new Error(fetchErrorMessage(err))
  }
  return {
    url: res.url || url,
    status: res.status,
    contentType: res.headers.get('content-type') ?? '',
    body: res.ok ? await readCapped(res) : (await res.body?.cancel().catch(() => undefined), ''),
    cacheSeconds: res.ok ? cacheLifetimeSeconds(res.headers) : null,
  }
}

const parseJson = (body: string): unknown => {
  try {
    return JSON.parse(body)
  } catch {
    return undefined
  }
}

/**
 * The page's base URL: the user may paste the page, a known API document or a feed. Trailing
 * slashes and known document paths are removed so `${base}/api/v2/summary.json` works for hosted
 * pages and for Marmot pages under `/status/<slug>`.
 */
export function statusPageBase(input: string): string {
  const url = new URL(input.trim())
  url.hash = ''
  url.search = ''
  url.pathname = url.pathname
    .replace(/\/api\/v2\/(summary|status|components|incidents)\.json$/i, '')
    .replace(/\/(summary|index)\.json$/i, '')
    .replace(/\/v2\/components\.json$/i, '')
    .replace(/\/proxy\/[^/]+$/i, '')
    .replace(/\/+$/, '')
  return url.toString().replace(/\/+$/, '')
}

const looksLikeFeedUrl = (input: string): boolean =>
  /\.(rss|atom|xml)$/i.test(new URL(input).pathname) || /\/feed\/?$/i.test(new URL(input).pathname)

type Attempt = (base: string, signal: AbortSignal) => Promise<VendorFetchResult | null>

/** A JSON document at `url` that `accepts`, or `null` (404, HTML, other shape). */
async function jsonAt(
  url: string,
  signal: AbortSignal,
  accepts: (doc: unknown) => boolean,
): Promise<{ doc: unknown; cacheSeconds: number | null } | null> {
  const res = await fetchDocument(url, signal)
  if (res.status < 200 || res.status >= 300) return null
  const doc = parseJson(res.body)
  return doc !== undefined && accepts(doc) ? { doc, cacheSeconds: res.cacheSeconds } : null
}

const ATTEMPTS: Record<VendorProvider, Attempt> = {
  async atlassian(base, signal) {
    const found = await jsonAt(`${base}/api/v2/summary.json`, signal, isAtlassianSummary)
    return found
      ? {
          status: parseAtlassian(found.doc),
          provider: 'atlassian',
          cacheSeconds: found.cacheSeconds,
        }
      : null
  },
  async instatus(base, signal) {
    const found = await jsonAt(`${base}/summary.json`, signal, isInstatusSummary)
    if (!found) return null
    // Components are a second document; without it the page-level verdict still works.
    const components = await jsonAt(`${base}/v2/components.json`, signal, () => true).catch(
      () => null,
    )
    return {
      status: parseInstatus(found.doc, components?.doc),
      provider: 'instatus',
      cacheSeconds: found.cacheSeconds,
    }
  },
  async betterstack(base, signal) {
    const found = await jsonAt(`${base}/index.json`, signal, isBetterStackIndex)
    return found
      ? {
          status: parseBetterStack(found.doc, base),
          provider: 'betterstack',
          cacheSeconds: found.cacheSeconds,
        }
      : null
  },
  async incidentio(base, signal) {
    const { origin, host } = new URL(base)
    const found = await jsonAt(`${origin}/proxy/${host}`, signal, isIncidentIoWidget)
    return found
      ? {
          status: parseIncidentIo(found.doc),
          provider: 'incidentio',
          cacheSeconds: found.cacheSeconds,
        }
      : null
  },
  async feed(base, signal) {
    const candidates: string[] = []
    if (looksLikeFeedUrl(base)) candidates.push(base)
    else {
      const page = await fetchDocument(base, signal, 'text/html, application/xhtml+xml')
      if (page.status >= 200 && page.status < 300) {
        if (isFeed(page.body)) {
          return {
            status: parseFeed(page.body),
            provider: 'feed',
            cacheSeconds: page.cacheSeconds,
          }
        }
        const advertised = feedLinkFromHtml(page.body, page.url)
        if (advertised) candidates.push(advertised)
      }
      candidates.push(`${base}/history.rss`, `${base}/history.atom`, `${base}/feed.rss`)
    }
    for (const url of candidates) {
      const res = await fetchDocument(
        url,
        signal,
        'application/rss+xml, application/atom+xml, text/xml',
      )
      if (res.status >= 200 && res.status < 300 && isFeed(res.body)) {
        return { status: parseFeed(res.body), provider: 'feed', cacheSeconds: res.cacheSeconds }
      }
    }
    return null
  },
}

/** Detection order: the JSON APIs first (cheap and precise), the feed fallback last. */
export const DETECTION_ORDER: readonly VendorProvider[] = [
  'atlassian',
  'instatus',
  'betterstack',
  'incidentio',
  'feed',
]

/**
 * Fetches and parses the vendor's status. With `provider: 'auto'` the formats are tried in
 * `DETECTION_ORDER`, starting with `hint` (the format found last time) when given.
 */
export async function fetchVendorStatus(
  pageUrl: string,
  provider: VendorProvider | 'auto',
  signal: AbortSignal,
  hint?: VendorProvider | null,
): Promise<VendorFetchResult> {
  const raw = pageUrl.trim()
  const base = looksLikeFeedUrl(raw) ? raw : statusPageBase(raw)
  const order: VendorProvider[] =
    provider !== 'auto'
      ? [provider]
      : looksLikeFeedUrl(raw)
        ? ['feed']
        : hint
          ? [hint, ...DETECTION_ORDER.filter((p) => p !== hint)]
          : [...DETECTION_ORDER]
  const errors: string[] = []
  for (const candidate of order) {
    try {
      const result = await ATTEMPTS[candidate](base, signal)
      if (result) return result
    } catch (err) {
      if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
        throw err
      }
      errors.push(err instanceof VendorFormatError ? err.message : fetchErrorMessage(err))
    }
  }
  const detail = errors.length > 0 ? ` (${errors[errors.length - 1]})` : ''
  throw new Error(
    provider === 'auto'
      ? `No supported status page found at ${base}${detail}`
      : `${base} is not a ${provider} status page${detail}`,
  )
}
