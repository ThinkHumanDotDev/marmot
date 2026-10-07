import 'server-only'

import { headers } from 'next/headers'
import { getPayload } from 'payload'
import { cache } from 'react'

import config from '@payload-config'
import { checkStatusPageAccess, type StatusPageAccessDecision } from '@/server/status-pages/access'
import {
  buildPublicStatusPageData,
  findPublishedStatusPage,
  type PublicStatusPageData,
} from '@/server/status-pages/public'

import type { StatusPage } from '@/payload-types'

/** The published page for `slug`, memoised per request so layout and page share one lookup. */
export const loadPublishedPage = cache(async (slug: string): Promise<StatusPage | null> => {
  const payload = await getPayload({ config })
  return findPublishedStatusPage(payload, slug)
})

export const loadPublicData = cache(async (slug: string): Promise<PublicStatusPageData | null> => {
  const page = await loadPublishedPage(slug)
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
