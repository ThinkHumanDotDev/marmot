/**
 * Inbound-parse webhook for ping-by-email (#135): `POST /api/inbound-email`. Lets a mail provider
 * deliver the messages for `<push token>@INBOUND_EMAIL_DOMAIN` over HTTPS instead of running the
 * SMTP listener. Enabled by `INBOUND_EMAIL_WEBHOOK_SECRET` (plus `INBOUND_EMAIL_DOMAIN`).
 *
 * Authentication: the secret as `?secret=`, as the password of HTTP Basic auth
 * (`https://marmot:<secret>@host/api/inbound-email`) or in an `X-Marmot-Secret` header; compared in
 * constant time. Payload formats, chosen by `Content-Type`:
 *
 * - `application/json`: Postmark inbound (`OriginalRecipient`, `ToFull`, `CcFull`, `Subject`,
 *   `TextBody`, `HtmlBody`), or a plain `{ to, subject, text }`;
 * - `multipart/form-data` / `application/x-www-form-urlencoded`: Mailgun routes (`recipient`,
 *   `subject`, `body-plain`, or `body-mime`) and SendGrid Inbound Parse (`envelope`, `to`, `subject`,
 *   `text`, or the raw `email` with "POST the raw, full MIME message");
 * - anything else (`message/rfc822`, `text/plain`, …): the raw message, e.g. from a Cloudflare Email
 *   Worker (`fetch(url, { method: 'POST', body: message.raw })`), with the envelope recipient in an
 *   optional `X-Marmot-Recipient` header.
 *
 * Answers `200 { ok: true, accepted }` (`accepted`: monitors the message reached; unknown addresses
 * are dropped silently, so providers do not retry them), 401 for a wrong secret, 404 while the
 * webhook is off, 413 over `INBOUND_EMAIL_MAX_BYTES`, 400 for a body that cannot be read.
 */
import { createHash, timingSafeEqual } from 'node:crypto'

import type { Payload } from 'payload'

import { env } from '@/env'
import { childLogger } from '@/lib/logger'
import { ingestPushEmail, parseRawEmail, type InboundEmail } from './email'
import { inboundEmailDomain } from './inbound-config'

const log = childLogger('push-email:webhook')

const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } })

const digest = (value: string) => createHash('sha256').update(value).digest()

/** Constant-time comparison of the presented secret with `INBOUND_EMAIL_WEBHOOK_SECRET`. */
function secretMatches(presented: string | null, expected: string): boolean {
  if (!presented) return false
  return timingSafeEqual(digest(presented), digest(expected))
}

function presentedSecret(request: Request): string | null {
  const header = request.headers.get('x-marmot-secret')
  if (header) return header
  const authorization = request.headers.get('authorization')
  if (authorization?.toLowerCase().startsWith('basic ')) {
    try {
      const decoded = Buffer.from(authorization.slice(6).trim(), 'base64').toString('utf8')
      const colon = decoded.indexOf(':')
      return colon === -1 ? decoded : decoded.slice(colon + 1)
    } catch {
      return null
    }
  }
  return new URL(request.url).searchParams.get('secret')
}

/** Read the body, or `null` once it exceeds `limit` bytes (without buffering the rest). */
export async function readBody(request: Request, limit: number): Promise<Uint8Array | null> {
  if (!request.body) return new Uint8Array()
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > limit) {
      await reader.cancel().catch(() => undefined)
      return null
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks)
}

const list = (value: unknown): string[] =>
  typeof value === 'string'
    ? value
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean)
    : Array.isArray(value)
      ? value.flatMap(list)
      : []

/** `Name <a@b>` → `a@b`. */
const bareAddress = (value: string) => value.match(/<([^>]+)>/)?.[1]?.trim() ?? value.trim()

const htmlToText = (html: string) =>
  html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .trim()

const str = (value: unknown): string | null => (typeof value === 'string' ? value : null)

/** Postmark inbound JSON, or a generic `{ to, subject, text }`. */
function fromJson(body: Record<string, unknown>): InboundEmail {
  const full = (key: string) =>
    Array.isArray(body[key])
      ? (body[key] as { Email?: unknown }[]).flatMap((entry) =>
          typeof entry?.Email === 'string' ? [entry.Email] : [],
        )
      : []
  const recipients = [
    ...list(body.OriginalRecipient),
    ...full('ToFull'),
    ...full('CcFull'),
    ...full('BccFull'),
    ...list(body.To),
    ...list(body.to),
    ...list(body.recipient),
  ].map(bareAddress)
  const html = str(body.HtmlBody) ?? str(body.html)
  return {
    recipients,
    subject: str(body.Subject) ?? str(body.subject),
    text: str(body.TextBody) ?? str(body.text) ?? (html ? htmlToText(html) : null),
    from: str(body.From) ?? str(body.from),
  }
}

/** Mailgun and SendGrid form posts (parsed or raw MIME). */
async function fromForm(form: FormData): Promise<InboundEmail> {
  const field = (name: string) => {
    const value = form.get(name)
    return typeof value === 'string' ? value : null
  }
  let envelope: string[] = list(field('recipient'))
  const sendgridEnvelope = field('envelope')
  if (sendgridEnvelope) {
    try {
      envelope = [...envelope, ...list((JSON.parse(sendgridEnvelope) as { to?: unknown }).to)]
    } catch {
      // Not JSON: fall back to the headers.
    }
  }
  envelope = envelope.map(bareAddress)
  const raw = field('body-mime') ?? field('email')
  if (raw) return parseRawEmail(raw, envelope)
  const html = field('body-html') ?? field('html')
  return {
    recipients: envelope.length > 0 ? envelope : list(field('to')).map(bareAddress),
    subject: field('subject'),
    text: field('body-plain') ?? field('text') ?? (html ? htmlToText(html) : null),
    from: field('from') ?? field('sender'),
  }
}

/** Handle one webhook delivery. */
export async function handleInboundEmailWebhook(
  payload: Payload,
  request: Request,
): Promise<Response> {
  const secret = env.INBOUND_EMAIL_WEBHOOK_SECRET
  if (!secret || !inboundEmailDomain()) {
    return json({ ok: false, error: 'Inbound email is not enabled.' }, 404)
  }
  if (!secretMatches(presentedSecret(request), secret)) {
    return json({ ok: false, error: 'Invalid secret.' }, 401)
  }

  const limit = env.INBOUND_EMAIL_MAX_BYTES
  const declared = Number(request.headers.get('content-length') ?? 0)
  const body = declared > limit ? null : await readBody(request, limit)
  if (!body) {
    log.info({ limit }, 'inbound webhook message over the size limit refused')
    return json({ ok: false, error: `Message exceeds the ${limit} byte limit.` }, 413)
  }

  const contentType = request.headers.get('content-type')?.toLowerCase() ?? ''
  let mail: InboundEmail
  try {
    if (contentType.includes('application/json')) {
      const parsed = JSON.parse(Buffer.from(body).toString('utf8')) as unknown
      if (!parsed || typeof parsed !== 'object') throw new Error('not an object')
      mail = fromJson(parsed as Record<string, unknown>)
    } else if (
      contentType.includes('multipart/form-data') ||
      contentType.includes('application/x-www-form-urlencoded')
    ) {
      const form = await new Response(body, { headers: { 'content-type': contentType } }).formData()
      mail = await fromForm(form)
    } else {
      const envelope = list(request.headers.get('x-marmot-recipient')).map(bareAddress)
      mail = await parseRawEmail(Buffer.from(body), envelope)
    }
  } catch (err) {
    log.info({ err, contentType }, 'unreadable inbound webhook body')
    return json({ ok: false, error: 'Unreadable message.' }, 400)
  }

  const outcomes = await ingestPushEmail(payload, mail)
  const accepted = outcomes.filter((outcome) => outcome.status !== 'unknown').length
  log.debug({ outcomes }, 'inbound webhook message applied')
  return json({ ok: true, accepted })
}
