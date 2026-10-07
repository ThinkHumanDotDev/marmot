import { decodeJwt } from 'jose'
import { APIError, getPayload, type Payload } from 'payload'
import { generatePayloadCookie } from 'payload/shared'

import config from '@payload-config'
import {
  cookiesAreSecure,
  createPayloadSessionCookie,
  readCookie,
  revokePayloadSession,
} from '@/auth/session'
import { TWO_FACTOR_GATE_CONTEXT } from '@/collections/Users'
import { env } from '@/env'
import { childLogger } from '@/lib/logger'
import { loginLimiter } from '@/server/security/auth-hooks'
import { createRateLimiter, tooManyRequests, type RateLimiter } from '@/server/security/rate-limit'
import { requestMeta } from '@/server/security/request'
import { errorMessageFor, errorText } from '@/server/request-locale'
import type { User } from '@/payload-types'

import {
  challengeCookie,
  clearChallengeCookie,
  openChallenge,
  sealChallenge,
  TWO_FACTOR_CHALLENGE_COOKIE,
  TWO_FACTOR_MAX_ATTEMPTS,
} from './challenge'
import { verifyTwoFactorCode } from './service'

const log = childLogger('two-factor')

/**
 * Framework-agnostic handlers behind `POST /api/auth/login` and `POST /api/auth/2fa` (Fetch
 * `Request` → `Response`, so integration tests drive them without Next).
 *
 * Login flow (after Uptime Kuma's `login` socket handler, see `totp.ts`):
 *  1. `POST /api/auth/login { email, password }` verifies the password through `payload.login`.
 *     Without 2FA the session cookie is set right away, like `POST /api/users/login`. With 2FA the
 *     session Payload just created is revoked again and the response is
 *     `{ requiresTwoFactor: true, challenge }` plus the `marmot-2fa` challenge cookie.
 *  2. `POST /api/auth/2fa { code, challenge? }` verifies a TOTP or backup code against the user
 *     in the challenge and only then creates the session (`createPayloadSessionCookie`).
 */

const jsonError = (message: string, status: number, cookies: string[] = []) => {
  const headers = new Headers({ 'Cache-Control': 'no-store' })
  for (const cookie of cookies) headers.append('Set-Cookie', cookie)
  return Response.json({ errors: [{ message }] }, { status, headers })
}

const json = (body: unknown, cookies: string[] = [], status = 200) => {
  const headers = new Headers({ 'Cache-Control': 'no-store' })
  for (const cookie of cookies) headers.append('Set-Cookie', cookie)
  return Response.json(body, { status, headers })
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const body = (await request.json()) as unknown
    return body && typeof body === 'object' ? (body as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** Public slice of the user, what the login response and `/api/users/me` expose. */
export const publicUser = (user: Pick<User, 'id' | 'email' | 'name'>) => ({
  id: user.id,
  email: user.email,
  name: user.name ?? null,
})

/** Issues the challenge cookie for `userId`: the browser now has to present a code. */
export async function issueTwoFactorChallenge(
  userId: User['id'],
): Promise<{ challenge: string; cookie: string }> {
  const challenge = await sealChallenge({ userId: String(userId), attempts: 0 }, env.PAYLOAD_SECRET)
  return { challenge, cookie: challengeCookie(challenge, { secure: cookiesAreSecure() }) }
}

/**
 * Brute-force protection for the login routes. They sign in through the Local API, which the
 * `users` `beforeOperation` limiter deliberately skips, so they consume limiter points themselves:
 * passwords share the REST login bucket (per client IP behind a trusted proxy, otherwise per
 * account); codes get a per-user bucket, because the challenge's own attempt counter travels with
 * the client and a replayed challenge would reset it.
 */
export const TWO_FACTOR_RATE_LIMIT = { points: 20, duration: 10 * 60, blockDuration: 15 * 60 }
export const twoFactorLimiter: RateLimiter = createRateLimiter('two-factor', TWO_FACTOR_RATE_LIMIT)

async function limitAttempt(
  limiter: RateLimiter,
  payload: Payload,
  request: Request,
  account: string,
): Promise<Response | null> {
  const { ip } = await requestMeta(payload, request)
  const decision = await limiter.consume(ip ? `ip:${ip}` : `account:${account}`)
  return decision.allowed ? null : tooManyRequests(decision, request)
}

/** `POST /api/auth/login` */
export async function handlePasswordLogin(request: Request): Promise<Response> {
  const { email, password } = await readBody(request)
  if (typeof email !== 'string' || !email.trim() || typeof password !== 'string' || !password) {
    return jsonError(errorText(request, 'enterEmailAndPassword'), 400)
  }

  const payload = await getPayload({ config })
  const limited = await limitAttempt(loginLimiter, payload, request, email.trim().toLowerCase())
  if (limited) return limited
  let token: string
  let exp: number | undefined
  let user: User
  try {
    const result = await payload.login({
      collection: 'users',
      data: { email: email.trim().toLowerCase(), password },
      depth: 0,
      context: { [TWO_FACTOR_GATE_CONTEXT]: true },
    })
    if (!result.token) throw new APIError('Login did not produce a token.', 500)
    token = result.token
    exp = result.exp
    user = result.user as User
  } catch (error) {
    const status = apiErrorStatus(error)
    if (status === 401 || status === 400) {
      return jsonError(errorText(request, 'invalidCredentials'), 401)
    }
    if (status === 403 && error instanceof Error) {
      // A policy refusal (for example single sign-on is enforced for the account's domain): the
      // message tells the user what to do instead and carries no credential information.
      return jsonError(errorMessageFor(request, error, 'forbidden'), 403)
    }
    log.error({ err: error instanceof Error ? error.message : String(error) }, 'login failed')
    return jsonError(errorText(request, 'signInFailed'), 500)
  }

  if (user.twoFactorEnabled === true) {
    // Payload already recorded a session for this login; take it back until the code is verified.
    const sid = decodeJwt(token).sid
    await revokePayloadSession({
      payload,
      userId: user.id,
      sid: typeof sid === 'string' ? sid : undefined,
    })
    const { challenge, cookie } = await issueTwoFactorChallenge(user.id)
    return json({ requiresTwoFactor: true, challenge }, [cookie])
  }

  const cookie = sessionCookieForToken(payload, token)
  return json({ user: publicUser(user), exp }, [cookie])
}

/**
 * HTTP status of an error thrown by a Payload operation. Not `instanceof APIError`: in the Next
 * production build the route bundle and the Payload instance that `getPayload` cached (whichever
 * route booted it first, e.g. the admin panel) can hold different copies of `payload`, so the
 * thrown `AuthenticationError` fails the class check and a wrong password would surface as a 500.
 */
function apiErrorStatus(error: unknown): number {
  if (error instanceof APIError) return error.status
  if (error instanceof Error && 'status' in error && typeof error.status === 'number') {
    return error.status
  }
  return 500
}

/** `Set-Cookie` for a token `payload.login` returned (same attributes as `POST /api/users/login`). */
export function sessionCookieForToken(payload: Payload, token: string): string {
  return generatePayloadCookie({
    collectionAuthConfig: payload.collections.users.config.auth,
    cookiePrefix: payload.config.cookiePrefix,
    token,
  })
}

/** `POST /api/auth/2fa` */
export async function handleTwoFactorLogin(request: Request): Promise<Response> {
  const secure = cookiesAreSecure()
  const clear = clearChallengeCookie({ secure })
  const body = await readBody(request)

  const sealed =
    readCookie(request.headers, TWO_FACTOR_CHALLENGE_COOKIE) ??
    (typeof body.challenge === 'string' ? body.challenge : undefined)
  const challenge = await openChallenge(sealed, env.PAYLOAD_SECRET)
  if (!challenge) {
    return jsonError(errorText(request, 'signInExpired'), 401, [clear])
  }

  const code = typeof body.code === 'string' ? body.code.trim() : ''
  if (!code) return jsonError(errorText(request, 'enterTotpCode'), 400)

  const payload = await getPayload({ config })
  const limited = await limitAttempt(twoFactorLimiter, payload, request, challenge.userId)
  if (limited) return limited
  const userId = (
    payload.db.defaultIDType === 'number' ? Number(challenge.userId) : challenge.userId
  ) as User['id']

  const method = await verifyTwoFactorCode(payload, userId, code)
  if (!method) {
    const attempts = challenge.attempts + 1
    if (attempts >= TWO_FACTOR_MAX_ATTEMPTS) {
      log.warn({ user: userId }, 'two-factor challenge exhausted')
      return jsonError(errorText(request, 'tooManyCodes'), 429, [clear])
    }
    const resealed = await sealChallenge({ userId: challenge.userId, attempts }, env.PAYLOAD_SECRET)
    return jsonError(errorText(request, 'invalidCode'), 401, [
      challengeCookie(resealed, { secure }),
    ])
  }

  let session
  try {
    session = await createPayloadSessionCookie({ payload, userId })
  } catch {
    return jsonError(errorText(request, 'signInExpired'), 401, [clear])
  }
  const user = await payload.findByID({
    collection: 'users',
    id: userId,
    depth: 0,
    overrideAccess: true,
  })
  log.info({ user: userId, method }, 'two-factor login succeeded')
  return json({ user: publicUser(user), exp: session.exp, method }, [session.cookie, clear])
}
