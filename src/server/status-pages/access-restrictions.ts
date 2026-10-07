import { ValidationError, type CollectionBeforeChangeHook } from 'payload'

import {
  isValidEmailDomain,
  normalizeEmailDomain,
  STATUS_PAGE_MAX_EMAIL_DOMAINS,
  STATUS_PAGE_MAX_IP_RANGES,
} from '@/lib/status-page-access'
import { normalizeCidr } from '@/server/status-pages/ip-allowlist'

import type { StatusPage } from '@/payload-types'

type DomainRow = NonNullable<StatusPage['allowedEmailDomains']>[number]
type RangeRow = NonNullable<StatusPage['allowedIpRanges']>[number]

const invalid = (path: string, message: string): never => {
  throw new ValidationError({ collection: 'status-pages', errors: [{ message, path }] })
}

/** Lower-case, `@`-less, de-duplicated domains; throws on anything that is not a domain name. */
export function normalizeDomainRows(rows: readonly DomainRow[]): DomainRow[] {
  const seen = new Set<string>()
  const out: DomainRow[] = []
  for (const row of rows) {
    const domain = normalizeEmailDomain(String(row?.domain ?? ''))
    if (!domain) continue
    if (!isValidEmailDomain(domain)) {
      invalid('allowedEmailDomains', `"${domain}" is not a domain name such as example.com.`)
    }
    if (seen.has(domain)) continue
    seen.add(domain)
    out.push({ ...row, domain })
  }
  return out
}

/** Canonical, de-duplicated CIDRs; throws on the first entry that is not an IP or a CIDR range. */
export function normalizeRangeRows(rows: readonly RangeRow[]): RangeRow[] {
  const seen = new Set<string>()
  const out: RangeRow[] = []
  for (const row of rows) {
    const raw = String(row?.cidr ?? '').trim()
    if (!raw) continue
    let cidr: string
    try {
      cidr = normalizeCidr(raw)
    } catch (error) {
      return invalid(
        'allowedIpRanges',
        error instanceof Error ? error.message : `"${raw}" is not a CIDR range.`,
      )
    }
    if (seen.has(cidr)) continue
    seen.add(cidr)
    const label = typeof row.label === 'string' ? row.label.trim().slice(0, 100) : row.label
    out.push({ ...row, cidr, label: label || null })
  }
  return out
}

/**
 * `beforeChange` of `status-pages`: normalizes the allow-lists of the `email-domain` and
 * `ip-allowlist` access modes and refuses to turn either mode on with an empty list (that would
 * lock everyone out, or, worse, look protected while nobody can be admitted). The lists are kept
 * when the page switches to another mode, so switching back restores them.
 */
export const applyAccessRestrictions: CollectionBeforeChangeHook<StatusPage> = ({
  data,
  originalDoc,
}) => {
  const access = data.access ?? originalDoc?.access ?? 'public'

  if (Array.isArray(data.allowedEmailDomains)) {
    data.allowedEmailDomains = normalizeDomainRows(data.allowedEmailDomains)
    if (data.allowedEmailDomains.length > STATUS_PAGE_MAX_EMAIL_DOMAINS) {
      invalid('allowedEmailDomains', `List at most ${STATUS_PAGE_MAX_EMAIL_DOMAINS} email domains.`)
    }
  }
  if (Array.isArray(data.allowedIpRanges)) {
    data.allowedIpRanges = normalizeRangeRows(data.allowedIpRanges)
    if (data.allowedIpRanges.length > STATUS_PAGE_MAX_IP_RANGES) {
      invalid('allowedIpRanges', `List at most ${STATUS_PAGE_MAX_IP_RANGES} IP ranges.`)
    }
  }

  if (access === 'email-domain') {
    const domains = data.allowedEmailDomains ?? originalDoc?.allowedEmailDomains ?? []
    if (domains.length === 0) {
      invalid('allowedEmailDomains', 'Add at least one email domain to restrict this page.')
    }
  }
  if (access === 'ip-allowlist') {
    const ranges = data.allowedIpRanges ?? originalDoc?.allowedIpRanges ?? []
    if (ranges.length === 0) {
      invalid('allowedIpRanges', 'Add at least one IP range to restrict this page.')
    }
  }
  return data
}
