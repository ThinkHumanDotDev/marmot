import type { Payload } from 'payload'

import { getInstanceSettings } from '@/server/settings'

import { clientIp } from './rate-limit'

export interface RequestMeta {
  ip: string | null
  userAgent: string | null
}

/**
 * Client address and user agent of a request, honouring `X-Forwarded-For` only when the instance
 * setting `trustProxy` is on. Shared by the rate limiters and the audit log so both agree on who
 * "the client" is.
 */
export async function requestMeta(
  payload: Payload,
  request: { headers: Headers },
): Promise<RequestMeta> {
  const { trustProxy } = await getInstanceSettings(payload)
  return {
    ip: clientIp(request, { trustProxy }),
    userAgent: request.headers.get('user-agent')?.slice(0, 512) ?? null,
  }
}

/** `keyFrom` for `withRateLimit`: per client IP, or skip (null) when no trusted address exists. */
export const ipKey =
  (payload: () => Promise<Payload>) =>
  async (request: Request): Promise<string | null> => {
    const { ip } = await requestMeta(await payload(), request)
    return ip ? `ip:${ip}` : null
  }
