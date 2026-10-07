import 'server-only'

import { getPayload } from 'payload'
import { cache } from 'react'

import config from '@payload-config'
import { componentNames } from '@/server/status-pages/subscribers/content'
import { loadSubscription } from '@/server/status-pages/subscribers/http'
import type { PickerGroup } from '@/components/status-pages/public/component-picker'

/** Page + subscriber behind a link token (memoised per request), or null. */
export const loadLinkSubscription = cache(async (slug: string, token: string) =>
  loadSubscription(slug, token),
)

/** The page's components grouped as on the page, for the component picker. */
export async function subscriptionPickerGroups(
  page: NonNullable<Awaited<ReturnType<typeof loadSubscription>>>['page'],
): Promise<PickerGroup[]> {
  const payload = await getPayload({ config })
  const names = await componentNames(payload, page)
  return (page.groups ?? [])
    .map((group) => ({
      name: group.name,
      components: (group.monitors ?? []).flatMap((row) =>
        row.id ? [{ id: String(row.id), name: names.get(String(row.id)) ?? group.name }] : [],
      ),
    }))
    .filter((group) => group.components.length > 0)
}
