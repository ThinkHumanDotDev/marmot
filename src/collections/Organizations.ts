import type { CollectionConfig } from 'payload'

/**
 * PLACEHOLDER — the real `organizations` tenant collection is delivered by the RBAC issue.
 * This minimal stub only exists so the `stat-*` collections' `organization` relationship
 * resolves. On merge conflict the RBAC version wins.
 */
export const Organizations: CollectionConfig = {
  slug: 'organizations',
  admin: { useAsTitle: 'name', group: 'Access' },
  fields: [{ name: 'name', type: 'text', required: true }],
}
