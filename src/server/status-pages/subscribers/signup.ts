/**
 * Public subscription flows (#104): sign-up from the page, SMS code verification, email
 * confirmation, component choice and unsubscribe through the signed links.
 *
 * Sign-ups never reveal whether an address is already subscribed: the response depends only on the
 * channel, and an address that is already confirmed receives a "manage your subscription" email
 * instead of a second confirmation. Sign-ups are rate limited per page and trusted client IP
 * (`trustProxy`), and messages to one target are capped separately so the form cannot be used to
 * flood someone's inbox or phone.
 */
import type { Payload } from 'payload'

import type { Locale } from '@/i18n/locales'
import { childLogger } from '@/lib/logger'
import {
  SMS_CODE_MAX_ATTEMPTS,
  SMS_CODE_TTL_MINUTES,
  isSubscriberChannel,
  normalizeComponentSelection,
  normalizeTarget,
  offeredChannels as offeredChannelsOf,
  type SubscriberChannel,
} from '@/lib/status-page-subscribers'
import type { StatusPage, StatusPageSubscriber } from '@/payload-types'
import {
  renderAlreadySubscribedEmail,
  renderSubscriptionConfirmEmail,
} from '@/server/email/subscriber-emails'
import { serverTranslator } from '@/server/i18n'
import { createRateLimiter, type RateLimiter } from '@/server/security/rate-limit'
import { requestMeta } from '@/server/security/request'
import { statusPageComponentIds } from '@/collections/StatusPageSubscribers'

import { loadPageContext } from './batches'
import { slackMessage, welcomeWebhookBody } from './content'
import { postSubscriberWebhook, sendSubscriberEmail, sendSubscriberSms } from './deliver'
import { publicPageUrl, subscriptionLinks } from './links'
import { generateSmsCode, hashSmsCode, smsCodeMatches, targetKey } from './tokens'

const log = childLogger('status-pages:subscribers:signup')

// ---------------------------------------------------------------------------------------------
// Rate limits

/** Sign-ups and code checks per page and client IP. */
export const SUBSCRIBE_RATE_LIMIT = { points: 10, duration: 10 * 60, blockDuration: 15 * 60 }
/** Without a trusted client address, all visitors of a page share this bucket. */
export const SUBSCRIBE_PAGE_RATE_LIMIT = { points: 60, duration: 10 * 60 }
/** Messages (confirmation emails, codes) one target receives from sign-ups. */
export const SUBSCRIBE_TARGET_RATE_LIMIT = { points: 3, duration: 60 * 60 }

export const subscribeLimiter: RateLimiter = createRateLimiter(
  'status-page-subscribe',
  SUBSCRIBE_RATE_LIMIT,
)
export const subscribePageLimiter: RateLimiter = createRateLimiter(
  'status-page-subscribe-page',
  SUBSCRIBE_PAGE_RATE_LIMIT,
)
export const subscribeTargetLimiter: RateLimiter = createRateLimiter(
  'status-page-subscribe-target',
  SUBSCRIBE_TARGET_RATE_LIMIT,
)

async function consumeClient(
  payload: Payload,
  page: Pick<StatusPage, 'id'>,
  request: { headers: Headers },
): Promise<{ allowed: true } | { allowed: false; retryAfterSeconds: number }> {
  const { ip } = await requestMeta(payload, request)
  const decision = ip
    ? await subscribeLimiter.consume(`${String(page.id)}:ip:${ip}`)
    : await subscribePageLimiter.consume(String(page.id))
  return decision.allowed
    ? { allowed: true }
    : { allowed: false, retryAfterSeconds: decision.retryAfterSeconds }
}

// ---------------------------------------------------------------------------------------------
// Sign-up

/** Channels the page offers to visitors (an SMS channel also needs a Twilio channel set). */
export const offeredChannels = (page: Pick<StatusPage, 'subscriptions'>): SubscriberChannel[] =>
  offeredChannelsOf(page.subscriptions)

export interface SubscribeInput {
  channel: unknown
  target: unknown
  components?: unknown
}

export type SubscribeResult =
  | { ok: true; next: 'confirm-email' | 'enter-code' | 'done' }
  | { ok: false; error: 'unavailable' | 'invalid-target' | 'invalid-components' }
  | { ok: false; error: 'rate-limited'; retryAfterSeconds: number }

const isUniqueViolation = (err: unknown): boolean =>
  /unique|duplicate|E11000|already subscribed/i.test(
    err instanceof Error
      ? `${err.message} ${JSON.stringify((err as { data?: unknown }).data ?? '')}`
      : String(err),
  )

/**
 * `POST /api/status-pages/:slug/subscribe`. `page` must be published and visible to the visitor
 * (the route checks page access first).
 */
export async function subscribe(
  payload: Payload,
  page: StatusPage,
  input: SubscribeInput,
  request: { headers: Headers },
  locale: Locale,
): Promise<SubscribeResult> {
  const channel = input.channel
  if (!isSubscriberChannel(channel) || !offeredChannels(page).includes(channel)) {
    return { ok: false, error: 'unavailable' }
  }
  const check = normalizeTarget(channel, input.target)
  if (!check.ok) return { ok: false, error: 'invalid-target' }
  const target = check.target
  const known = statusPageComponentIds(page)
  const components = normalizeComponentSelection(input.components, known)
  if (Array.isArray(input.components) && components.length !== new Set(input.components).size) {
    return { ok: false, error: 'invalid-components' }
  }

  const client = await consumeClient(payload, page, request)
  if (!client.allowed) {
    return { ok: false, error: 'rate-limited', retryAfterSeconds: client.retryAfterSeconds }
  }

  const next = channel === 'email' ? 'confirm-email' : channel === 'sms' ? 'enter-code' : 'done'
  // Over the per-target cap: answer as usual, send nothing.
  const targetAllowed = (await subscribeTargetLimiter.consume(targetKey(page.id, channel, target)))
    .allowed

  const { docs } = await payload.find({
    collection: 'status-page-subscribers',
    where: {
      and: [
        { statusPage: { equals: page.id } },
        { channel: { equals: channel } },
        { target: { equals: target } },
      ],
    },
    depth: 0,
    limit: 1,
    overrideAccess: true,
  })
  let subscriber = (docs[0] as StatusPageSubscriber | undefined) ?? null
  const alreadyConfirmed = Boolean(subscriber?.confirmedAt)

  if (!subscriber) {
    try {
      subscriber = (await payload.create({
        collection: 'status-page-subscribers',
        data: {
          statusPage: page.id,
          organization: page.organization,
          channel,
          target,
          components,
          source: 'self_signup',
          locale,
          // Webhook and Slack URLs need no opt-in: their first message carries the links.
          confirmedAt:
            channel === 'webhook' || channel === 'slack' ? new Date().toISOString() : null,
        },
        depth: 0,
        overrideAccess: true,
      })) as StatusPageSubscriber
    } catch (err) {
      if (!isUniqueViolation(err)) throw err
      return { ok: true, next }
    }
  } else if (!alreadyConfirmed) {
    // A repeated, still unconfirmed sign-up takes the new component choice.
    subscriber = (await payload.update({
      collection: 'status-page-subscribers',
      id: subscriber.id,
      data: { components, locale },
      depth: 0,
      overrideAccess: true,
    })) as StatusPageSubscriber
  }

  if (!targetAllowed) return { ok: true, next }
  try {
    await sendSignupMessage(payload, page, subscriber, alreadyConfirmed)
  } catch (err) {
    log.warn({ err, pageId: page.id, channel }, 'cannot send the sign-up message')
  }
  return { ok: true, next }
}

/** Confirmation email, SMS code, "already subscribed" email or the welcome webhook message. */
async function sendSignupMessage(
  payload: Payload,
  page: StatusPage,
  subscriber: StatusPageSubscriber,
  alreadyConfirmed: boolean,
): Promise<void> {
  const links = subscriptionLinks(page, subscriber)
  const ctx = await loadPageContext(payload, page.id)
  const locale = (subscriber.locale as Locale | null) ?? ctx?.i18n.locale ?? 'en'
  switch (subscriber.channel) {
    case 'email': {
      const email = alreadyConfirmed
        ? renderAlreadySubscribedEmail({ siteName: page.title, links, locale })
        : renderSubscriptionConfirmEmail({ siteName: page.title, links, locale })
      await sendSubscriberEmail(payload, subscriber.target, email, alreadyConfirmed ? links : null)
      return
    }
    case 'sms': {
      if (alreadyConfirmed) return
      const code = generateSmsCode()
      const now = Date.now()
      await payload.update({
        collection: 'status-page-subscribers',
        id: subscriber.id,
        data: {
          verification: {
            codeHash: hashSmsCode(subscriber.id, code),
            expiresAt: new Date(now + SMS_CODE_TTL_MINUTES * 60_000).toISOString(),
            attempts: 0,
            sentAt: new Date(now).toISOString(),
          },
        },
        depth: 0,
        overrideAccess: true,
      })
      const text = serverTranslator(locale)('subscriberMessages.sms.code', {
        code,
        siteName: page.title,
        minutes: SMS_CODE_TTL_MINUTES,
      })
      await sendSubscriberSms(payload, page, subscriber.target, text)
      return
    }
    case 'slack':
    case 'webhook': {
      const render = { locale, i18n: ctx?.i18n ?? { locale, timeZone: 'UTC' } }
      const pageInfo = { title: page.title, url: publicPageUrl(page) }
      await postSubscriberWebhook({
        url: subscriber.target,
        body:
          subscriber.channel === 'slack'
            ? slackMessage(null, links, render, pageInfo)
            : welcomeWebhookBody(page, links, locale, alreadyConfirmed ? null : subscriber.secret),
        secret: subscriber.channel === 'webhook' ? subscriber.secret : null,
        headers: subscriber.headers,
        event: 'subscription_created',
        deliveryId: `welcome-${String(subscriber.id)}`,
      })
      return
    }
  }
}

/**
 * Welcome message for subscribers an owner added on a webhook or Slack channel, so the receiver
 * learns its manage link (and, for webhooks, the signing secret). Errors are logged.
 */
export async function sendWelcome(
  payload: Payload,
  page: StatusPage,
  subscriber: StatusPageSubscriber,
): Promise<void> {
  if (subscriber.channel !== 'webhook' && subscriber.channel !== 'slack') return
  try {
    await sendSignupMessage(payload, page, subscriber, false)
  } catch (err) {
    log.warn({ err, subscriberId: subscriber.id }, 'cannot send the welcome message')
  }
}

// ---------------------------------------------------------------------------------------------
// SMS code

export type VerifyResult =
  | { ok: true; subscriber: StatusPageSubscriber }
  | { ok: false; error: 'invalid-code' }
  | { ok: false; error: 'rate-limited'; retryAfterSeconds: number }

/** `POST /api/status-pages/:slug/subscribe/verify` `{ target, code }`. */
export async function verifySmsCode(
  payload: Payload,
  page: StatusPage,
  input: { target: unknown; code: unknown },
  request: { headers: Headers },
): Promise<VerifyResult> {
  const client = await consumeClient(payload, page, request)
  if (!client.allowed) {
    return { ok: false, error: 'rate-limited', retryAfterSeconds: client.retryAfterSeconds }
  }
  const check = normalizeTarget('sms', input.target)
  const code = typeof input.code === 'string' ? input.code.replace(/\s/g, '') : ''
  if (!check.ok || !/^\d{4,10}$/.test(code)) return { ok: false, error: 'invalid-code' }

  const { docs } = await payload.find({
    collection: 'status-page-subscribers',
    where: {
      and: [
        { statusPage: { equals: page.id } },
        { channel: { equals: 'sms' } },
        { target: { equals: check.target } },
      ],
    },
    depth: 0,
    limit: 1,
    overrideAccess: true,
  })
  const subscriber = docs[0] as StatusPageSubscriber | undefined
  const verification = subscriber?.verification
  if (!subscriber || subscriber.confirmedAt || !verification?.codeHash) {
    return { ok: false, error: 'invalid-code' }
  }
  const attempts = verification.attempts ?? 0
  const expired = !verification.expiresAt || new Date(verification.expiresAt).getTime() < Date.now()
  if (expired || attempts >= SMS_CODE_MAX_ATTEMPTS) return { ok: false, error: 'invalid-code' }

  if (!smsCodeMatches(subscriber.id, code, verification.codeHash)) {
    await payload.update({
      collection: 'status-page-subscribers',
      id: subscriber.id,
      data: { verification: { ...verification, attempts: attempts + 1 } },
      depth: 0,
      overrideAccess: true,
    })
    return { ok: false, error: 'invalid-code' }
  }

  const confirmed = (await payload.update({
    collection: 'status-page-subscribers',
    id: subscriber.id,
    data: {
      confirmedAt: new Date().toISOString(),
      verification: { codeHash: null, expiresAt: null, attempts: 0, sentAt: verification.sentAt },
    },
    depth: 0,
    overrideAccess: true,
  })) as StatusPageSubscriber
  return { ok: true, subscriber: confirmed }
}

// ---------------------------------------------------------------------------------------------
// Link actions

/** Confirms an email subscription (idempotent). */
export async function confirmSubscription(
  payload: Payload,
  subscriber: StatusPageSubscriber,
): Promise<StatusPageSubscriber> {
  if (subscriber.confirmedAt) return subscriber
  return (await payload.update({
    collection: 'status-page-subscribers',
    id: subscriber.id,
    data: { confirmedAt: new Date().toISOString() },
    depth: 0,
    overrideAccess: true,
  })) as StatusPageSubscriber
}

/** Changes the followed components (empty = all); unknown ids are refused. */
export async function updateSubscriptionComponents(
  payload: Payload,
  page: StatusPage,
  subscriber: StatusPageSubscriber,
  components: unknown,
): Promise<StatusPageSubscriber | null> {
  if (!Array.isArray(components)) return null
  const known = statusPageComponentIds(page)
  const kept = normalizeComponentSelection(components, known)
  if (kept.length !== new Set(components.map(String)).size) return null
  return (await payload.update({
    collection: 'status-page-subscribers',
    id: subscriber.id,
    data: { components: kept },
    depth: 0,
    overrideAccess: true,
  })) as StatusPageSubscriber
}

/** Ends the subscription: the row and its delivery log are deleted. */
export async function unsubscribe(
  payload: Payload,
  subscriber: Pick<StatusPageSubscriber, 'id'>,
): Promise<void> {
  await payload.delete({
    collection: 'status-page-subscribers',
    id: subscriber.id,
    overrideAccess: true,
  })
}

/** Inbound SMS `STOP` (Twilio webhook): unsubscribes the number from every page using the channel. */
export async function unsubscribePhoneFromPage(
  payload: Payload,
  pageId: string | number,
  phone: string,
): Promise<number> {
  const check = normalizeTarget('sms', phone)
  if (!check.ok) return 0
  const { docs } = await payload.delete({
    collection: 'status-page-subscribers',
    where: {
      and: [
        { statusPage: { equals: pageId } },
        { channel: { equals: 'sms' } },
        { target: { equals: check.target } },
      ],
    },
    overrideAccess: true,
  })
  return docs.length
}
