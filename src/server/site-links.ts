/**
 * Operator links shown in footers and next to sign-up / checkout (#178): the terms of service and
 * privacy policy of a hosted instance, and the source of the running build (AGPL-3.0 §13).
 */
import { env } from '@/env'
import { MARMOT_VERSION } from '@/lib/version'

export const REPOSITORY_URL = 'https://github.com/ThinkHumanDotDev/marmot'

export interface SiteLinks {
  /** `TERMS_URL`, or `null` when the operator has not set one. */
  termsUrl: string | null
  /** `PRIVACY_URL`, or `null` when the operator has not set one. */
  privacyUrl: string | null
  /** `SOURCE_URL`, or this repository at the running version's tag. */
  sourceUrl: string
}

/** Where the "Source" link points: the operator's fork when set, else the tag of this release. */
export function sourceUrl(): string {
  return env.SOURCE_URL ?? `${REPOSITORY_URL}/tree/v${MARMOT_VERSION}`
}

export function getSiteLinks(): SiteLinks {
  return {
    termsUrl: env.TERMS_URL ?? null,
    privacyUrl: env.PRIVACY_URL ?? null,
    sourceUrl: sourceUrl(),
  }
}
