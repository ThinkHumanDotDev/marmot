import type { CollectionConfig } from 'payload'

/**
 * PLACEHOLDER — the real `monitors` collection is delivered by the polling-engine issue (#2).
 * This minimal stub only exists so the `stat-*` collections' `monitor` relationship resolves.
 * On merge conflict the engine's version wins.
 */
export const Monitors: CollectionConfig = {
  slug: 'monitors',
  admin: { useAsTitle: 'name', group: 'Monitoring' },
  fields: [{ name: 'name', type: 'text', required: true }],
}
