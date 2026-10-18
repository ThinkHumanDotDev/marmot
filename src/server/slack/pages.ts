/**
 * Finding the status page a `/marmot` command names (#129): a URL on this instance
 * (`<server>/status/<slug>…`), a URL on one of a page's custom domains, or a bare slug. Only
 * published pages are found; pages of other organizations only when they are public.
 */
import type { Payload } from 'payload'

import { env } from '@/env'
import { HOSTNAME_PATTERN, normalizeHostname } from '@/lib/status-page-hostnames'
import type { StatusPage } from '@/payload-types'
import { orgAllowsCustomDomains, relationId } from '@/server/billing/entitlements'
import { isProtectedPage } from '@/server/status-pages/access'

/** Slack wraps links as `<https://x|label>` or `<https://x>`; returns the bare text. */
export function unwrapSlackLink(raw: string): string {
  const value = raw.trim()
  const match = /^<([^|>]+)(\|[^>]*)?>$/.exec(value)
  return (match ? match[1]! : value).trim()
}

const SLUG = /^[a-z0-9][a-z0-9-]{0,99}$/

const serverHost = (): string => {
  try {
    return new URL(env.NEXT_PUBLIC_SERVER_URL).host.toLowerCase()
  } catch {
    return ''
  }
}

async function bySlug(payload: Payload, slug: string): Promise<StatusPage | null> {
  const { docs } = await payload.find({
    collection: 'status-pages',
    where: { and: [{ slug: { equals: slug } }, { published: { equals: true } }] },
    depth: 0,
    limit: 1,
    overrideAccess: true,
  })
  return (docs[0] as StatusPage | undefined) ?? null
}

async function byDomain(payload: Payload, hostname: string): Promise<StatusPage | null> {
  if (!HOSTNAME_PATTERN.test(hostname)) return null
  const { docs } = await payload.find({
    collection: 'status-pages',
    where: { and: [{ 'domains.hostname': { equals: hostname } }, { published: { equals: true } }] },
    depth: 0,
    limit: 1,
    overrideAccess: true,
  })
  const page = (docs[0] as StatusPage | undefined) ?? null
  // Same rule as the custom-domain proxy: a plan without custom domains stops serving them.
  if (page && !(await orgAllowsCustomDomains(payload, relationId(page.organization)))) return null
  return page
}

/** The published status page `input` names, or `null`. */
export async function resolveStatusPage(
  payload: Payload,
  input: string,
): Promise<StatusPage | null> {
  const text = unwrapSlackLink(input)
  if (!text) return null
  if (SLUG.test(text.toLowerCase()) && !text.includes('.'))
    return bySlug(payload, text.toLowerCase())
  let url: URL
  try {
    url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
  const segments = url.pathname.split('/').filter(Boolean)
  if (url.host.toLowerCase() === serverHost()) {
    if (segments[0] !== 'status' || !segments[1]) return null
    const slug = decodeURIComponent(segments[1]).toLowerCase()
    return SLUG.test(slug) ? bySlug(payload, slug) : null
  }
  return byDomain(payload, normalizeHostname(url.hostname))
}

/** May a workspace of organization `orgId` see `page` without signing in? */
export const pageVisibleTo = (page: StatusPage, orgId: string | number | null): boolean =>
  (orgId !== null && String(relationId(page.organization)) === String(orgId)) ||
  !isProtectedPage(page)
