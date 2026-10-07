/**
 * Twilio request validation for the inbound SMS webhook (STOP handling): `X-Twilio-Signature` is
 * base64(HMAC-SHA1(auth token, URL + every POST parameter name and value, sorted by name)). See
 * https://www.twilio.com/docs/usage/security#validating-requests.
 */
import { createHmac, timingSafeEqual } from 'node:crypto'

export function twilioSignature(
  authToken: string,
  url: string,
  params: Record<string, string>,
): string {
  const data = Object.keys(params)
    .sort()
    .reduce((acc, key) => acc + key + params[key], url)
  return createHmac('sha1', authToken).update(data, 'utf8').digest('base64')
}

export function verifyTwilioSignature(
  authToken: string,
  url: string,
  params: Record<string, string>,
  header: string | null | undefined,
): boolean {
  if (!header || !authToken) return false
  const expected = Buffer.from(twilioSignature(authToken, url, params))
  const given = Buffer.from(header)
  return expected.length === given.length && timingSafeEqual(expected, given)
}
