import { getPayload } from 'payload'

import config from '@payload-config'
import { validateOrganizationSlug } from '@/lib/reserved-slugs'
import { errorText, requestLocale, slugMessageIn } from '@/server/request-locale'

export const dynamic = 'force-dynamic'

/**
 * GET /api/orgs/slug-available?slug=acme
 *
 * `{ available: true }` or `{ available: false, reason }`. Reserved words and malformed slugs are
 * reported as unavailable with the validation message; existing organizations are looked up with
 * `overrideAccess: true` because the check must work before the user belongs to anything.
 */
export async function GET(request: Request) {
  const raw = new URL(request.url).searchParams.get('slug') ?? ''
  const slug = raw.trim().toLowerCase()

  const valid = validateOrganizationSlug(slug, slugMessageIn(requestLocale(request)))
  if (valid !== true) return Response.json({ available: false, slug, reason: valid })

  const payload = await getPayload({ config })
  const { totalDocs } = await payload.count({
    collection: 'organizations',
    where: { slug: { equals: slug } },
    overrideAccess: true,
  })
  return Response.json(
    totalDocs > 0
      ? { available: false, slug, reason: errorText(request, 'slugTaken') }
      : { available: true, slug },
  )
}
