/**
 * Organization slugs that would collide with application routes or that we never want a tenant
 * to claim. Keep this list in sync with the top-level routes under `src/app`.
 */
export const RESERVED_SLUGS: ReadonlySet<string> = new Set([
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

/** Returns `true` when valid, otherwise a human-readable error message (Payload `validate` shape). */
export function validateOrganizationSlug(value: unknown): true | string {
  if (typeof value !== 'string' || value.length === 0) {
    return 'Slug is required.'
  }
  if (value.length < 2) {
    return 'Slug must be at least 2 characters.'
  }
  if (!SLUG_PATTERN.test(value)) {
    return 'Slug may only contain lowercase letters, numbers and hyphens, and cannot start or end with a hyphen.'
  }
  if (isReservedSlug(value)) {
    return `"${value}" is reserved. Please choose another slug.`
  }
  return true
}
