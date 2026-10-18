/**
 * Twilio request signatures (`X-Twilio-Signature`), as documented at
 * https://www.twilio.com/docs/usage/security#validating-requests: the base64 HMAC-SHA1, keyed with
 * the account's auth token, of the full URL Twilio requested followed by every POST parameter
 * sorted by name, each as `name + value` (repeated names: one pair per value, values sorted).
 */
import { createHmac, timingSafeEqual } from 'node:crypto'

export const TWILIO_SIGNATURE_HEADER = 'x-twilio-signature'

type Params = URLSearchParams | Record<string, string | string[]>

const entries = (params: Params): [string, string[]][] => {
  const map = new Map<string, string[]>()
  const add = (key: string, value: string) => map.set(key, [...(map.get(key) ?? []), value])
  if (params instanceof URLSearchParams) {
    for (const [key, value] of params) add(key, value)
  } else {
    for (const [key, value] of Object.entries(params)) {
      for (const item of Array.isArray(value) ? value : [value]) add(key, item)
    }
  }
  return [...map.entries()]
}

/** The signature Twilio sends for a POST of `params` to `url`. */
export function twilioSignature(authToken: string, url: string, params: Params): string {
  const data = entries(params)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .reduce(
      (acc, [key, values]) =>
        acc +
        [...values]
          .sort()
          .map((value) => key + value)
          .join(''),
      url,
    )
  return createHmac('sha1', authToken).update(Buffer.from(data, 'utf8')).digest('base64')
}

/**
 * `url` with and without the scheme's default port: Twilio signs HTTPS URLs either way depending on
 * how the URL was configured, so its own libraries accept both.
 */
function urlVariants(url: string): string[] {
  const variants = new Set([url])
  const match = /^(https?):\/\/([^/?#:]+)(:\d+)?(.*)$/i.exec(url)
  if (match) {
    const [, scheme, host, port, rest] = match
    const defaultPort = scheme.toLowerCase() === 'https' ? ':443' : ':80'
    if (!port) variants.add(`${scheme}://${host}${defaultPort}${rest}`)
    else if (port === defaultPort) variants.add(`${scheme}://${host}${rest}`)
  }
  return [...variants]
}

/** `true` when `signature` is Twilio's signature of `params` posted to `url` (constant time). */
export function validateTwilioSignature(
  authToken: string,
  signature: string | null | undefined,
  url: string,
  params: Params,
): boolean {
  if (!authToken || typeof signature !== 'string' || !signature || signature.length > 256) {
    return false
  }
  const given = Buffer.from(signature)
  let ok = false
  for (const candidate of urlVariants(url)) {
    const expected = Buffer.from(twilioSignature(authToken, candidate, params))
    if (expected.length === given.length && timingSafeEqual(expected, given)) ok = true
  }
  return ok
}
