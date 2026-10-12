import 'server-only'

import { headers } from 'next/headers'
import { notFound, redirect } from 'next/navigation'
import { getPayload } from 'payload'
import { cache } from 'react'

import config from '@payload-config'
import {
  checkStatusPageAccess,
  isProtectedPage,
  type StatusPageAccessDecision,
} from '@/server/status-pages/access'
import {
  buildPublicStatusPageData,
  findPublishedStatusPage,
  type PublicStatusPageData,
} from '@/server/status-pages/public'
import { isAudiencePage, scopePageForVisitor } from '@/server/status-pages/audiences'
import { statusPageBasePath } from '@/server/status-pages/urls'

import type { StatusPage } from '@/payload-types'

/** The published page for `slug`, memoised per request so layout and page share one lookup. */
export const loadPublishedPage = cache(async (slug: string): Promise<StatusPage | null> => {
  const payload = await getPayload({ config })
  return findPublishedStatusPage(payload, slug)
})

/**
 * The published page as the current visitor may see it: on `audience` pages (#151) narrowed to the
 * components of the visitor's audiences (none without access); every other page unchanged. Use it
 * for anything that shows components, incidents or maintenance.
 */
export const loadVisiblePage = cache(async (slug: string): Promise<StatusPage | null> => {
  const page = await loadPublishedPage(slug)
  if (!page || !isAudiencePage(page)) return page
  const access = await loadPageAccess(slug)
  return scopePageForVisitor(page, access ?? { allowed: false })
})

export const loadPublicData = cache(async (slug: string): Promise<PublicStatusPageData | null> => {
  const page = await loadVisiblePage(slug)
  if (!page) return null
  const payload = await getPayload({ config })
  return buildPublicStatusPageData(payload, page)
})

/**
 * May the current visitor view the published page `slug`? `null` when there is no such page.
 * The HTML page only honours the access cookie; `?pw=` is for machine endpoints.
 */
export const loadPageAccess = cache(
  async (slug: string): Promise<StatusPageAccessDecision | null> => {
    const page = await loadPublishedPage(slug)
    if (!page) return null
    const payload = await getPayload({ config })
    return checkStatusPageAccess(
      payload,
      page,
      { headers: await headers() },
      { acceptPasswordParam: false },
    )
  },
)

/**
 * The published page a visitor may see, for the history and permalink pages: 404 for unknown or
 * unpublished slugs; visitors without access to a protected page are sent to its login form, which
 * brings them back to `returnPath` (a path below the page, see `isEventsReturnPath`).
 */
export async function requireVisiblePage(
  slug: string,
  returnPath: string,
): Promise<{ page: StatusPage; basePath: string; restricted: boolean }> {
  const published = await loadPublishedPage(slug)
  if (!published) notFound()
  const basePath = statusPageBasePath(published, await headers())
  const restricted = isProtectedPage(published)
  if (restricted && !(await loadPageAccess(slug))?.allowed) {
    redirect(`${basePath}/login?next=${encodeURIComponent(returnPath)}`)
  }
  const page = (await loadVisiblePage(slug)) ?? published
  return { page, basePath, restricted }
}
