/**
 * Demo mode (#159): shared constants and the "is this allowed?" checks. Kept free of
 * `@payload-config` so collections, the outbound guard and the email adapter can import it.
 *
 * See docs/Demo-Mode.md for the behaviour and `./reset.ts` for the reset job.
 */
import type { PayloadRequest } from 'payload'

import { env } from '@/env'
import { apiError } from '@/server/errors'
import { errorText } from '@/server/request-locale'

/** Whether the instance runs as a self-resetting demo (`DEMO_MODE`). */
export const isDemoMode = (): boolean => env.DEMO_MODE

/** Slug of the seeded organization. */
export const DEMO_ORGANIZATION_SLUG = 'demo'

/**
 * The account visitors sign in with. Shown on the login page and in the banner, so it is public by
 * design: everything it can do is reset on schedule and the guard rails below keep it from
 * locking other visitors out (password, email, two-factor and account deletion are refused).
 */
export const DEMO_ACCOUNT = {
  email: 'demo@example.com',
  password: 'marmot-demo',
  name: 'Demo User',
} as const

/** Interval between two resets in milliseconds (`DEMO_RESET_INTERVAL_MINUTES`). */
export const demoResetIntervalMs = (): number => env.DEMO_RESET_INTERVAL_MINUTES * 60_000

/**
 * `req.context` flag of the writes made by the reset itself; the guard rails let them through.
 * Never set from request data.
 */
export const DEMO_SEED_CONTEXT = 'demoSeed'

export const isDemoSeedRequest = (req: Pick<PayloadRequest, 'context'> | null | undefined) =>
  req?.context?.[DEMO_SEED_CONTEXT] === true

/** Features demo mode switches off; reported as `data.feature` of the 403 so clients can tell. */
export type DemoFeature =
  | 'accountCredentials'
  | 'apiKeys'
  | 'billing'
  | 'customDomains'
  | 'dockerHosts'
  | 'imports'
  | 'instanceSettings'
  | 'setup'
  | 'smtp'
  | 'sso'
  | 'twoFactor'
  | 'uploads'
  | 'webhooks'

/** The 403 thrown for a feature that is switched off in demo mode. */
export const demoRestricted = (feature: DemoFeature) =>
  apiError('demoModeRestricted', 403, undefined, {
    data: { code: 'demo_mode', feature },
    isPublic: true,
  })

/**
 * Throw `demoRestricted(feature)` in demo mode, unless the write belongs to the reset itself.
 * A no-op otherwise, so callers can sprinkle it without checking the mode first.
 */
export function assertDemoAllows(
  feature: DemoFeature,
  req?: Pick<PayloadRequest, 'context'> | null,
): void {
  if (isDemoMode() && !isDemoSeedRequest(req)) throw demoRestricted(feature)
}

/**
 * For route handlers without a collection behind them: the 403 response (in the request's
 * language) when `feature` is switched off by demo mode, otherwise `null`.
 */
export function demoRefusal(request: Request, feature: DemoFeature): Response | null {
  if (!isDemoMode()) return null
  return Response.json(
    {
      errors: [
        { message: errorText(request, 'demoModeRestricted'), data: { code: 'demo_mode', feature } },
      ],
    },
    { status: 403 },
  )
}
