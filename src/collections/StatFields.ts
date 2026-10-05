import type { Access, CollectionConfig } from 'payload'

/**
 * Shared definition of the three time-series aggregate collections
 * (`stat-minutely`, `stat-hourly`, `stat-daily`). One row per `(monitor, bucket timestamp)`.
 *
 * Rows are written exclusively by the worker through the Local API
 * (`src/server/stats/uptime-calculator.ts`), so REST/GraphQL writes are disabled. Reads are
 * allowed for any authenticated user until organization RBAC lands.
 */
const authenticatedRead: Access = ({ req }) => Boolean(req.user)
const localApiOnly: Access = () => false

export type StatCollectionSlug = 'stat-minutely' | 'stat-hourly' | 'stat-daily'

export type StatCollectionOptions = {
  slug: StatCollectionSlug
  label: string
  bucket: string
}

export function buildStatCollection({
  slug,
  label,
  bucket,
}: StatCollectionOptions): CollectionConfig {
  return {
    slug,
    labels: { singular: label, plural: label },
    admin: {
      group: 'Statistics',
      description: `Per-monitor heartbeat aggregates, one row per ${bucket}.`,
      defaultColumns: ['monitor', 'timestamp', 'up', 'down', 'ping'],
      hideAPIURL: true,
    },
    access: {
      read: authenticatedRead,
      create: localApiOnly,
      update: localApiOnly,
      delete: localApiOnly,
    },
    timestamps: false,
    indexes: [{ fields: ['monitor', 'timestamp'], unique: true }],
    fields: [
      {
        name: 'monitor',
        type: 'relationship',
        relationTo: 'monitors',
        required: true,
        index: true,
        maxDepth: 0,
      },
      {
        name: 'organization',
        type: 'relationship',
        relationTo: 'organizations',
        required: true,
        index: true,
        maxDepth: 0,
      },
      {
        name: 'timestamp',
        type: 'number',
        required: true,
        index: true,
        admin: { description: `Unix seconds, truncated to the start of the ${bucket} (UTC).` },
      },
      { name: 'up', type: 'number', required: true, defaultValue: 0 },
      { name: 'down', type: 'number', required: true, defaultValue: 0 },
      { name: 'ping', type: 'number', admin: { description: 'Average ping (ms) of UP beats.' } },
      { name: 'pingMin', type: 'number' },
      { name: 'pingMax', type: 'number' },
      {
        name: 'extras',
        type: 'json',
        admin: { description: 'Additional counters, e.g. { maintenance, pingCount }.' },
      },
    ],
  }
}
