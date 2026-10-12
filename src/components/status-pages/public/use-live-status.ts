'use client'

import * as React from 'react'

import type { PublicStatusPageData } from '@/server/status-pages/public'

/**
 * The page's public data, server-rendered as `initial` and — when the page's `autoRefreshInterval`
 * is non-zero — re-fetched from the public API on that interval while the tab is visible. Shared by
 * the status page and its embed mode.
 */
export function useLiveStatus(
  slug: string,
  initial: PublicStatusPageData,
): { data: PublicStatusPageData; refreshing: boolean } {
  const [data, setData] = React.useState(initial)
  const [refreshing, setRefreshing] = React.useState(false)
  const interval = data.config.autoRefreshInterval

  React.useEffect(() => {
    if (!interval || interval <= 0) return
    let cancelled = false
    const tick = async () => {
      if (document.visibilityState === 'hidden') return
      setRefreshing(true)
      try {
        const res = await fetch(`/api/status-pages/${encodeURIComponent(slug)}/public`, {
          cache: 'no-store',
          headers: { Accept: 'application/json' },
        })
        // Access ended (password changed, viewer revoked, cookie expired, network left): the
        // server sends the sign-in or restricted screen.
        if (res.status === 401 || res.status === 403) return window.location.reload()
        if (res.ok && !cancelled) setData((await res.json()) as PublicStatusPageData)
      } catch {
        // keep showing the last good payload
      } finally {
        if (!cancelled) setRefreshing(false)
      }
    }
    const id = window.setInterval(tick, Math.max(5, interval) * 1000)
    return () => {
      cancelled = true
      window.clearInterval(id)
    }
  }, [slug, interval])

  return { data, refreshing }
}
