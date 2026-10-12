/**
 * Builder API helpers for status page audiences (#151): the writable fields and the lookup of one
 * audience of a page with the request user's access.
 */
import type { StatusPage, StatusPageAudience } from '@/payload-types'

import { coerceId, loadOrgStatusPage, type Authenticated } from './http'

const strings = (value: unknown): string[] | undefined =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : undefined

/** The fields a client may set on an audience (the hook validates and normalizes them). */
export function audienceData(
  body: Record<string, unknown>,
): Partial<Pick<StatusPageAudience, 'name' | 'components' | 'emails' | 'emailDomains'>> {
  const out: Partial<Pick<StatusPageAudience, 'name' | 'components' | 'emails' | 'emailDomains'>> =
    {}
  if (typeof body.name === 'string') out.name = body.name
  const components = strings(body.components)
  if (components) out.components = components
  const emails = strings(body.emails)
  if (emails) out.emails = emails
  const emailDomains = strings(body.emailDomains)
  if (emailDomains) out.emailDomains = emailDomains
  return out
}

/** The page (depth `depth`) and its audience `audienceId`, both read with the user's access. */
export async function loadOrgAudience(
  ctx: Authenticated,
  orgId: string,
  pageId: string,
  audienceId: string,
  depth = 0,
): Promise<{ page: StatusPage; audience: StatusPageAudience } | null> {
  const page = await loadOrgStatusPage(ctx, orgId, pageId, depth)
  if (!page) return null
  const { docs } = await ctx.payload.find({
    collection: 'status-page-audiences',
    where: {
      and: [
        { id: { equals: coerceId(ctx.payload, audienceId) } },
        { statusPage: { equals: page.id } },
      ],
    },
    limit: 1,
    depth: 0,
    user: ctx.user,
    overrideAccess: false,
  })
  return docs[0] ? { page, audience: docs[0] } : null
}
