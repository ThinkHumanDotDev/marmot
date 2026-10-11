/**
 * Settings of the third-party status page monitor (#125), shared by the collection, the form schema
 * and the worker. Client-safe: no server imports.
 */
import { VENDOR_PROVIDERS, type ComponentFilter } from '@/lib/vendor-status'

/** `auto` tries every supported format; the others pin one. */
export const STATUS_PAGE_PROVIDERS = ['auto', ...VENDOR_PROVIDERS] as const
export type StatusPageProviderSetting = (typeof STATUS_PAGE_PROVIDERS)[number]

/**
 * Checks never run more often than this, to be polite to vendors. A longer `Cache-Control:
 * max-age` on the vendor's document raises the interval further.
 */
export const STATUS_PAGE_MIN_INTERVAL_SECONDS = 120

/** At most this many components per monitor. */
export const STATUS_PAGE_MAX_COMPONENTS = 50

/**
 * The stored component filter (`monitors.statusPageComponents`, JSON `[{ id, name }]`) as a clean
 * list; anything malformed is dropped. The id is what matches, the name is only a label.
 */
export function parseStatusPageComponents(value: unknown): ComponentFilter[] {
  if (!Array.isArray(value)) return []
  const out: ComponentFilter[] = []
  const seen = new Set<string>()
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue
    const raw = (entry as { id?: unknown }).id
    const id = typeof raw === 'string' || typeof raw === 'number' ? String(raw).trim() : ''
    if (!id || seen.has(id)) continue
    seen.add(id)
    const name = (entry as { name?: unknown }).name
    out.push({ id, name: typeof name === 'string' && name.trim() ? name.trim() : null })
  }
  return out.slice(0, STATUS_PAGE_MAX_COMPONENTS)
}
