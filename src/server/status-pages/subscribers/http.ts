/**
 * Plumbing shared by the public subscription routes (`/api/status-pages/:slug/subscribe…` and
 * `/api/status-pages/:slug/subscriptions/:token…`). Responses are never cached and never indexed.
 */
import { getPayload, type Payload } from 'payload'

import config from '@payload-config'
import type { StatusPage, StatusPageSubscriber } from '@/payload-types'
import type { ErrorKey, ErrorValues } from '@/server/errors'
import { errorText } from '@/server/request-locale'
import { findPublishedStatusPage } from '@/server/status-pages/public'

import { findSubscriberByLinkToken } from './tokens'

export const NO_STORE = { 'Cache-Control': 'private, no-store', 'X-Robots-Tag': 'noindex' }

export const errorJson = (
  request: Request,
  key: ErrorKey,
  status: number,
  extra: Record<string, string> = {},
  values?: ErrorValues,
) =>
  Response.json(
    { error: errorText(request, key, values) },
    { status, headers: { ...NO_STORE, ...extra } },
  )

/** JSON or form body as a plain object (`components` may repeat in forms). */
export async function readBody(request: Request): Promise<Record<string, unknown> | null> {
  const type = request.headers.get('content-type') ?? ''
  if (type.includes('application/json')) {
    const json = (await request.json().catch(() => null)) as unknown
    return json && typeof json === 'object' && !Array.isArray(json)
      ? (json as Record<string, unknown>)
      : null
  }
  const form = await request.formData().catch(() => null)
  if (!form) return {}
  const out: Record<string, unknown> = {}
  for (const key of new Set(form.keys())) {
    const values = form.getAll(key).filter((v): v is string => typeof v === 'string')
    out[key] = key === 'components' ? values : values[0]
  }
  return out
}

export const isFormRequest = (request: Request): boolean =>
  !(request.headers.get('content-type') ?? '').includes('application/json')

export interface SubscriptionContext {
  payload: Payload
  page: StatusPage
  subscriber: StatusPageSubscriber
}

/**
 * The published page `slug` and the subscriber of `token`, or `null` when either is unknown or the
 * token belongs to another page. Unknown and foreign tokens look the same to the caller.
 */
export async function loadSubscription(
  slug: string,
  token: string,
): Promise<SubscriptionContext | null> {
  const payload = await getPayload({ config })
  const page = await findPublishedStatusPage(payload, slug)
  if (!page) return null
  const subscriber = await findSubscriberByLinkToken(payload, decodeURIComponent(token))
  if (!subscriber) return null
  const pageId =
    subscriber.statusPage && typeof subscriber.statusPage === 'object'
      ? subscriber.statusPage.id
      : subscriber.statusPage
  if (String(pageId) !== String(page.id)) return null
  return { payload, page, subscriber }
}

/** What the manage page and `GET …/subscriptions/:token` show: never the secret or the headers. */
export const publicSubscription = (subscriber: StatusPageSubscriber) => ({
  channel: subscriber.channel,
  target: subscriber.target,
  components: subscriber.components ?? [],
  confirmed: Boolean(subscriber.confirmedAt),
})
