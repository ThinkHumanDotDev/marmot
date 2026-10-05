import 'server-only'

import { getPayload } from 'payload'
import { cache } from 'react'

import config from '@payload-config'
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
