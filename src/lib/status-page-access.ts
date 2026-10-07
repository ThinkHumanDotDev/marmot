/**
 * Who may view a published status page:
 *
 * - `public`: everyone;
 * - `password`: visitors who know the page password;
 * - `email-domain`: visitors who prove, through a one-time link sent by email, that they own an
 *   address at one of the page's allowed domains;
 * - `ip-allowlist`: requests whose client address is in one of the page's CIDR ranges.
 *
 * Shared by the collection, the server-side check (`src/server/status-pages/access.ts`) and the
 * builder UI, so it lives outside the collection module.
 */
export const STATUS_PAGE_ACCESS_MODES = [
  'public',
  'password',
  'email-domain',
  'ip-allowlist',
] as const
export type StatusPageAccessMode = (typeof STATUS_PAGE_ACCESS_MODES)[number]

/** Minimum length of a status page password (enforced by the collection hook). */
export const STATUS_PAGE_PASSWORD_MIN_LENGTH = 8
export const STATUS_PAGE_PASSWORD_MAX_LENGTH = 256

/** Lifetime of a magic link sent to an `email-domain` page visitor. */
export const STATUS_PAGE_MAGIC_LINK_TTL_MINUTES = 15

/** Upper bounds on the lists a page may carry (validated by the collection hook). */
export const STATUS_PAGE_MAX_EMAIL_DOMAINS = 50
export const STATUS_PAGE_MAX_IP_RANGES = 100

/** Domain name (at least two labels), lower case: `acme.com`, `eng.acme.co.uk`. */
const DOMAIN_PATTERN = /^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?<!-)(?:\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/

/** `@Acme.COM ` → `acme.com`. Does not validate; see `isValidEmailDomain`. */
export const normalizeEmailDomain = (value: string): string =>
  value.trim().toLowerCase().replace(/^@+/, '').replace(/\.$/, '')

export const isValidEmailDomain = (value: string): boolean => DOMAIN_PATTERN.test(value)

/**
 * A plausible single email address (no display name, no list), at most 254 characters. Returns the
 * address lower-cased, or `null`. Deliberately simple: delivery is the real test.
 */
export function normalizeEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const email = value.trim().toLowerCase()
  if (email.length > 254) return null
  const at = email.lastIndexOf('@')
  if (at < 1 || at !== email.indexOf('@')) return null
  const local = email.slice(0, at)
  const domain = email.slice(at + 1)
  if (local.length > 64 || !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(local)) return null
  return isValidEmailDomain(domain) ? email : null
}

/** Domain part of a normalized address. */
export const emailDomainOf = (email: string): string => email.slice(email.lastIndexOf('@') + 1)

/**
 * True when the address belongs to one of `domains` (exact match: `acme.com` does not admit
 * `eng.acme.com`; list that domain too).
 */
export function isEmailInDomains(
  email: string,
  domains: readonly (string | null | undefined)[],
): boolean {
  const domain = emailDomainOf(email)
  return domains.some((d) => typeof d === 'string' && normalizeEmailDomain(d) === domain)
}
