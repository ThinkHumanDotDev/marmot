/**
 * Magic links for `email-domain` status pages.
 *
 * 1. A visitor enters an address (`POST /api/status-pages/:slug/access` with `email`). The request is
 *    rate limited per client IP (or per page without a trusted address) and per page and address,
 *    then answered at once with the same "check your inbox" response whatever the address: whether
 *    its domain is allowed is never revealed, not even through timing, because the lookup and the
 *    email are sent in the background.
 * 2. For an allowed, non-revoked address a 256-bit random token is minted. Only its SHA-256 digest is
 *    stored, in Redis, for 15 minutes (`STATUS_PAGE_MAGIC_LINK_TTL_MINUTES`), with the page id and the
 *    address. The link points at the page's login screen (`…/login?token=…`) on the host the visitor
 *    used (custom domains included), so the cookie lands where the page is served.
 * 3. The login screen asks for a click that posts the token back (link scanners that prefetch GET
 *    URLs cannot burn it). `consumeMagicLink` reads and deletes the entry atomically (single use),
 *    re-checks the page and the domain, and records the visitor in `status-page-viewers`; the
 *    access cookie then names that row (see `access.ts`).
 */
import { createHash, randomBytes } from 'node:crypto'

import type { Redis } from 'ioredis'
import type { Payload } from 'payload'

import { resolveStatusPageLocale } from '@/i18n/resolve'
import type { Locale } from '@/i18n/locales'
import { childLogger } from '@/lib/logger'
import { escapeHtml } from '@/lib/markdown'
import {
  isEmailInDomains,
  normalizeEmail,
  STATUS_PAGE_MAGIC_LINK_TTL_MINUTES,
} from '@/lib/status-page-access'
import { serverTranslator } from '@/server/i18n'
import { createRedis } from '@/server/redis'
import { createRateLimiter, type RateLimiter } from '@/server/security/rate-limit'
import { requestMeta } from '@/server/security/request'
import { statusPageUrlFor } from '@/server/status-pages/urls'

import type { StatusPage, StatusPageViewer } from '@/payload-types'

const log = childLogger('status-page-magic-link')

export const MAGIC_LINK_TTL_SECONDS = STATUS_PAGE_MAGIC_LINK_TTL_MINUTES * 60

/** Query parameter (and form field) carrying the token. */
export const MAGIC_LINK_TOKEN_PARAM = 'token'

const KEY_PREFIX = 'marmot:sp-magic:'
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/

// ---------------------------------------------------------------------------------------------
// Rate limits

/** Links per page and address: three per quarter hour, then a quarter-hour block. */
export const MAGIC_LINK_EMAIL_RATE_LIMIT = { points: 3, duration: 15 * 60 }
/** Link requests per client IP, across pages and addresses. */
export const MAGIC_LINK_IP_RATE_LIMIT = { points: 10, duration: 15 * 60 }
/** Without a trusted client address (`trustProxy` off), all visitors of a page share this bucket. */
export const MAGIC_LINK_PAGE_RATE_LIMIT = { points: 30, duration: 15 * 60 }

export const magicLinkEmailLimiter: RateLimiter = createRateLimiter(
  'status-page-link-email',
  MAGIC_LINK_EMAIL_RATE_LIMIT,
)
export const magicLinkIpLimiter: RateLimiter = createRateLimiter(
  'status-page-link-ip',
  MAGIC_LINK_IP_RATE_LIMIT,
)
export const magicLinkPageLimiter: RateLimiter = createRateLimiter(
  'status-page-link-page',
  MAGIC_LINK_PAGE_RATE_LIMIT,
)

// ---------------------------------------------------------------------------------------------
// Token store

let store: Redis | undefined

const getStore = (): Redis => {
  store ??= createRedis({ maxRetriesPerRequest: 1, commandTimeout: 2_000 })
  return store
}

/** Closes the token store connection (tests, graceful shutdown). */
export async function closeMagicLinkStore(): Promise<void> {
  const client = store
  store = undefined
  if (client) await client.quit().catch(() => undefined)
}

const digest = (value: string) => createHash('sha256').update(value).digest('base64url')
const tokenKey = (token: string) => `${KEY_PREFIX}${digest(token)}`

interface StoredLink {
  /** Page id. */
  p: string
  /** Normalized address. */
  e: string
}

// ---------------------------------------------------------------------------------------------
// Background deliveries

const pending = new Set<Promise<void>>()

/** Test hook: waits for every link delivery started so far. */
export async function settleMagicLinkDeliveries(): Promise<void> {
  while (pending.size > 0) await Promise.allSettled([...pending])
}

const track = (work: Promise<void>) => {
  const promise = work.finally(() => pending.delete(promise))
  pending.add(promise)
}

// ---------------------------------------------------------------------------------------------
// Viewers

type AccessFields = Pick<StatusPage, 'id' | 'access' | 'allowedEmailDomains' | 'organization'>

const relId = (value: unknown): string | number | null => {
  if (typeof value === 'string' || typeof value === 'number') return value
  if (value && typeof value === 'object' && 'id' in value) {
    const id = (value as { id: unknown }).id
    if (typeof id === 'string' || typeof id === 'number') return id
  }
  return null
}

const allowedDomains = (page: Pick<StatusPage, 'allowedEmailDomains'>) =>
  (page.allowedEmailDomains ?? []).map((row) => row.domain)

/** True while `email` may be admitted to `page` (mode on, domain still listed). */
export const isEmailAllowed = (
  page: Pick<StatusPage, 'access' | 'allowedEmailDomains'>,
  email: string,
): boolean => page.access === 'email-domain' && isEmailInDomains(email, allowedDomains(page))

async function findViewer(
  payload: Payload,
  pageId: string | number,
  email: string,
): Promise<StatusPageViewer | null> {
  const { docs } = await payload.find({
    collection: 'status-page-viewers',
    where: { and: [{ page: { equals: pageId } }, { email: { equals: email } }] },
    depth: 0,
    limit: 1,
    pagination: false,
    overrideAccess: true,
  })
  return docs[0] ?? null
}

/** `lastSeenAt` is refreshed at most this often, so page views are not all writes. */
const TOUCH_INTERVAL_MS = 5 * 60 * 1000

/** Records a visit of a signed-in viewer (throttled; failures are only logged). */
export async function touchViewer(payload: Payload, viewer: StatusPageViewer): Promise<void> {
  const last = viewer.lastSeenAt ? new Date(viewer.lastSeenAt).getTime() : 0
  if (Date.now() - last < TOUCH_INTERVAL_MS) return
  await payload
    .update({
      collection: 'status-page-viewers',
      id: viewer.id,
      data: { lastSeenAt: new Date().toISOString() },
      depth: 0,
      overrideAccess: true,
    })
    .catch((err: unknown) => log.warn({ err, viewer: viewer.id }, 'cannot record viewer visit'))
}

// ---------------------------------------------------------------------------------------------
// Email

export function renderMagicLinkEmail({
  to,
  url,
  pageTitle,
  locale,
}: {
  to: string
  url: string
  pageTitle: string
  locale: Locale
}): { to: string; subject: string; text: string; html: string } {
  const t = serverTranslator(locale)
  const minutes = STATUS_PAGE_MAGIC_LINK_TTL_MINUTES
  const intro = (strong: (chunks: string) => string, page: string) =>
    t.markup('email.statusPageMagicLink.intro', { page, strong })
  const expires = t('email.statusPageMagicLink.expires', { minutes })
  const ignore = t('email.statusPageMagicLink.ignore')
  return {
    to,
    subject: t('email.statusPageMagicLink.subject', { page: pageTitle }),
    text: `${intro((chunks) => chunks, pageTitle)}\n\n${t('email.statusPageMagicLink.link', { url })}\n\n${expires}\n${ignore}`,
    html: `<p>${intro((chunks) => `<strong>${chunks}</strong>`, escapeHtml(pageTitle))}</p><p><a href="${escapeHtml(url)}">${escapeHtml(t('email.statusPageMagicLink.button'))}</a></p><p>${escapeHtml(expires)}<br>${escapeHtml(ignore)}</p>`,
  }
}

// ---------------------------------------------------------------------------------------------
// Request

export type MagicLinkRequest =
  | { ok: true }
  | { ok: false; reason: 'invalid-email' }
  | { ok: false; reason: 'rate-limited'; retryAfterSeconds?: number }

type LinkPage = AccessFields & Pick<StatusPage, 'slug' | 'title' | 'language' | 'domains'>

async function deliver(
  payload: Payload,
  page: LinkPage,
  email: string,
  pageUrl: string,
  locale: Locale,
): Promise<void> {
  if (!isEmailAllowed(page, email)) return
  const viewer = await findViewer(payload, page.id, email)
  if (viewer?.status === 'revoked') return

  const token = randomBytes(32).toString('base64url')
  const entry: StoredLink = { p: String(page.id), e: email }
  await getStore().set(tokenKey(token), JSON.stringify(entry), 'EX', MAGIC_LINK_TTL_SECONDS)

  const url = `${pageUrl}/login?${MAGIC_LINK_TOKEN_PARAM}=${token}`
  await payload.sendEmail(renderMagicLinkEmail({ to: email, url, pageTitle: page.title, locale }))
}

/**
 * Handles "send me a link" for an `email-domain` page. Resolves before anything depends on the
 * address: the caller answers identically for allowed, unknown and revoked addresses.
 */
export async function requestMagicLink(
  payload: Payload,
  page: LinkPage,
  rawEmail: unknown,
  request: Request,
): Promise<MagicLinkRequest> {
  const email = normalizeEmail(rawEmail)
  if (!email) return { ok: false, reason: 'invalid-email' }

  const { ip } = await requestMeta(payload, request)
  const pageId = String(page.id)
  const byClient = ip
    ? await magicLinkIpLimiter.consume(`ip:${ip}`)
    : await magicLinkPageLimiter.consume(pageId)
  if (!byClient.allowed) {
    return { ok: false, reason: 'rate-limited', retryAfterSeconds: byClient.retryAfterSeconds }
  }
  const byEmail = await magicLinkEmailLimiter.consume(`${pageId}:${digest(email)}`)
  if (!byEmail.allowed) {
    return { ok: false, reason: 'rate-limited', retryAfterSeconds: byEmail.retryAfterSeconds }
  }

  const pageUrl = statusPageUrlFor(page, request)
  const locale = resolveStatusPageLocale(page, request.headers)
  track(
    deliver(payload, page, email, pageUrl, locale).catch((err: unknown) =>
      log.error({ err, page: page.id }, 'cannot send status page sign-in link'),
    ),
  )
  return { ok: true }
}

// ---------------------------------------------------------------------------------------------
// Consume

export type MagicLinkResult = { ok: true; viewer: StatusPageViewer } | { ok: false }

/**
 * Redeems a token for `page`: single use (read and deleted in one transaction), bound to the page it
 * was issued for, and only while the address is still admitted. Returns the viewer row the session
 * cookie will name.
 */
export async function consumeMagicLink(
  payload: Payload,
  page: AccessFields,
  token: unknown,
): Promise<MagicLinkResult> {
  if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) return { ok: false }

  let raw: string | null = null
  try {
    const result = await getStore().multi().get(tokenKey(token)).del(tokenKey(token)).exec()
    const value = result?.[0]?.[1]
    raw = typeof value === 'string' ? value : null
  } catch (err) {
    log.error({ err }, 'cannot read status page sign-in link')
    return { ok: false }
  }
  if (!raw) return { ok: false }

  let entry: StoredLink
  try {
    entry = JSON.parse(raw) as StoredLink
  } catch {
    return { ok: false }
  }
  if (entry.p !== String(page.id) || typeof entry.e !== 'string') return { ok: false }
  if (!isEmailAllowed(page, entry.e)) return { ok: false }

  const now = new Date().toISOString()
  const existing = await findViewer(payload, page.id, entry.e)
  if (existing) {
    if (existing.status === 'revoked') return { ok: false }
    const viewer = await payload.update({
      collection: 'status-page-viewers',
      id: existing.id,
      data: { lastSeenAt: now },
      depth: 0,
      overrideAccess: true,
    })
    return { ok: true, viewer }
  }

  const organization = relId(page.organization)
  if (organization === null) return { ok: false }
  try {
    const viewer = await payload.create({
      collection: 'status-page-viewers',
      data: {
        organization: organization as StatusPageViewer['organization'],
        page: page.id,
        email: entry.e,
        status: 'active',
        lastSeenAt: now,
      },
      depth: 0,
      overrideAccess: true,
    })
    return { ok: true, viewer }
  } catch (err) {
    // Two links redeemed at once for the same address: the unique index keeps one row.
    const raced = await findViewer(payload, page.id, entry.e)
    if (raced && raced.status !== 'revoked') return { ok: true, viewer: raced }
    log.error({ err, page: page.id }, 'cannot record status page viewer')
    return { ok: false }
  }
}
