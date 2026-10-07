/**
 * Organization slugs that would collide with application routes or that we never want a tenant
 * to claim. Keep this list in sync with the top-level routes under `src/app`.
 */
export const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  'ack',
  'admin',
  'api',
  'app',
  'assets',
  'auth',
  'badge',
  'billing',
  'dashboard',
  'docs',
  'graphql',
  'health',
  'help',
  'invite',
  'invitations',
  'login',
  'logout',
  'maintenance',
  'marmot',
  'me',
  'metrics',
  'monitors',
  'new',
  'notifications',
  'onboarding',
  'organizations',
  'ph',
  'public',
  'push',
  'register',
  'reset-password',
  'settings',
  'setup',
  'signin',
  'signout',
  'signup',
  'sso',
  'socket.io',
  'static',
  'status',
  'status-pages',
  'support',
  'system',
  'uploads',
  'users',
  'verify',
  'www',
])

/** Lowercase letters, digits and single hyphens; 2–63 chars; no leading/trailing hyphen. */
export const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/

export const isReservedSlug = (slug: string): boolean => RESERVED_SLUGS.has(slug.toLowerCase())

/** Why a slug is refused. */
export type SlugProblem = 'required' | 'tooShort' | 'pattern' | 'reserved'

/** `null` when `value` is a valid organization slug, otherwise what is wrong with it. */
export function organizationSlugProblem(value: unknown): SlugProblem | null {
  if (typeof value !== 'string' || value.length === 0) return 'required'
  if (value.length < 2) return 'tooShort'
  if (!SLUG_PATTERN.test(value)) return 'pattern'
  if (isReservedSlug(value)) return 'reserved'
  return null
}

/**
 * Renders a slug problem. The English default is what the API answers; the UI passes its
 * translator (`errors.slugRequired`, `errors.slugTooShort`, … in `src/i18n/messages/en.json`, which
 * carry the same text), server code `slugMessageIn(locale)` from `src/server/request-locale.ts`.
 */
export type SlugMessage = (problem: SlugProblem, slug: string) => string

export const englishSlugMessage: SlugMessage = (problem, slug) => {
  switch (problem) {
    case 'required':
      return 'Slug is required.'
    case 'tooShort':
      return 'Slug must be at least 2 characters.'
    case 'pattern':
      return 'Slug may only contain lowercase letters, numbers and hyphens, and cannot start or end with a hyphen.'
    case 'reserved':
      return `"${slug}" is reserved. Please choose another slug.`
  }
}

/** Returns `true` when valid, otherwise a human-readable error message (Payload `validate` shape). */
export function validateOrganizationSlug(
  value: unknown,
  message: SlugMessage = englishSlugMessage,
): true | string {
  const problem = organizationSlugProblem(value)
  return problem ? message(problem, typeof value === 'string' ? value : '') : true
}

/** `errors.*` key of each slug problem. */
export const SLUG_ERROR_KEYS = {
  required: 'slugRequired',
  tooShort: 'slugTooShort',
  pattern: 'slugPattern',
  reserved: 'slugReserved',
} as const satisfies Record<SlugProblem, string>
