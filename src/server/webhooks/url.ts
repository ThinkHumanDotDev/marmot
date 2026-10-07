/**
 * Save-time checks of an outbound webhook URL. Delivery itself goes through `guardedFetch`, which
 * re-checks every resolved address at connect time; this only gives early feedback for URLs that
 * can never work (wrong scheme, literal private addresses while the outbound guard is on).
 */
import type { ErrorKey, ErrorValues } from '@/server/errors'
import { literalTargetDenial } from '@/server/security/outbound-guard'

export const WEBHOOK_URL_MAX_LENGTH = 2048

export function webhookUrlProblem(value: unknown): { key: ErrorKey; values?: ErrorValues } | null {
  if (typeof value !== 'string' || !value.trim() || value.length > WEBHOOK_URL_MAX_LENGTH) {
    return { key: 'webhookUrlInvalid' }
  }
  let url: URL
  try {
    url = new URL(value.trim())
  } catch {
    return { key: 'webhookUrlInvalid' }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { key: 'webhookUrlInvalid' }
  const denial = literalTargetDenial(url.hostname)
  if (denial) return { key: 'webhookUrlBlocked', values: { reason: denial } }
  return null
}

/** `https://user:pass@host/path?token=…` → `https://host/path` for logs and payloads. */
export function displayUrl(value: string | null | undefined): string | null {
  if (!value) return null
  try {
    const url = new URL(value)
    url.username = ''
    url.password = ''
    url.search = ''
    url.hash = ''
    return url.toString()
  } catch {
    return null
  }
}
