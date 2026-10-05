import { env } from '@/env'

/**
 * Origins that may call Payload's REST API with cookies (`cors`) and that the CSRF check accepts
 * (`csrf`): the public server URL plus `ADDITIONAL_ORIGINS` (comma-separated, e.g. a separate
 * realtime host or a second domain that fronts the same instance). Trailing slashes and blanks are
 * dropped so `https://x.test/` and `https://x.test` count once.
 */
export function allowedOrigins(): string[] {
  const raw = [env.NEXT_PUBLIC_SERVER_URL, ...env.ADDITIONAL_ORIGINS.split(',')]
  const origins = raw.map((value) => value.trim().replace(/\/+$/, '')).filter(Boolean)
  return Array.from(new Set(origins))
}
