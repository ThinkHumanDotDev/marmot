/**
 * Custom-domain hostnames of status pages. Shared by the collection and the builder UI (a client
 * component), so it lives outside the collection module, whose hooks pull in server-only code.
 */

/** RFC 1123 hostname: labels of letters, digits and hyphens joined by dots; no scheme, no port. */
export const HOSTNAME_PATTERN =
  /^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?<!-)(?:\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/

export const normalizeHostname = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/[/:].*$/, '')

export function validateHostname(value: unknown): true | string {
  if (typeof value !== 'string' || value.length === 0) return 'Hostname is required.'
  if (!HOSTNAME_PATTERN.test(value)) {
    return 'Enter a bare hostname such as status.example.com (no scheme, path or port).'
  }
  return true
}
