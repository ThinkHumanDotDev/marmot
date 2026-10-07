import type { CollectionBeforeDeleteHook, CollectionConfig } from 'payload'

import { orgScoped } from '@/access/org-scoped'
import { TAG_COLOR_PATTERN, TAG_COLORS } from '@/lib/monitor-resources'
import type { Monitor } from '@/payload-types'

import { relId } from './shared'
import { adminT } from '@/i18n/admin'

/**
 * `monitors.tags[].tag` is required, so a deleted tag must first be removed from every monitor that
 * carries it (Uptime Kuma deletes the `monitor_tag` rows with the tag).
 */
const detachFromMonitors: CollectionBeforeDeleteHook = async ({ id, req }) => {
  const { docs } = await req.payload.find({
    collection: 'monitors',
    where: { 'tags.tag': { equals: id } },
    select: { tags: true },
    depth: 0,
    limit: 0,
    pagination: false,
    req,
    overrideAccess: true,
  })
  for (const monitor of docs as Pick<Monitor, 'id' | 'tags'>[]) {
    await req.payload.update({
      collection: 'monitors',
      id: monitor.id,
      data: {
        tags: (monitor.tags ?? [])
          .filter((row) => String(relId(row.tag)) !== String(id))
          .map((row) => ({ tag: relId(row.tag), value: row.value ?? null })) as Monitor['tags'],
      },
      depth: 0,
      req,
      overrideAccess: true,
      context: { skipEngineSync: true },
    })
  }
}

export const Tags: CollectionConfig = {
  slug: 'tags',
  admin: {
    useAsTitle: 'name',
    group: 'Monitoring',
    defaultColumns: ['name', 'color', 'organization'],
  },
  // Viewers read (tags show up wherever monitors do), members write.
  access: {
    read: orgScoped('tag:read'),
    create: orgScoped('tag:create'),
    update: orgScoped('tag:update'),
    delete: orgScoped('tag:delete'),
  },
  indexes: [{ fields: ['organization', 'name'], unique: true }],
  hooks: {
    beforeValidate: [
      ({ data }) => {
        if (data && typeof data.name === 'string') data.name = data.name.trim()
        return data
      },
    ],
    beforeDelete: [detachFromMonitors],
  },
  fields: [
    {
      name: 'organization',
      type: 'relationship',
      relationTo: 'organizations',
      required: true,
      index: true,
      admin: { position: 'sidebar' },
    },
    {
      type: 'row',
      fields: [
        { name: 'name', type: 'text', required: true, maxLength: 100 },
        {
          name: 'color',
          type: 'text',
          required: true,
          defaultValue: TAG_COLORS[0].value,
          validate: (value: unknown) =>
            typeof value === 'string' && TAG_COLOR_PATTERN.test(value)
              ? true
              : 'Use a hex colour such as #2563EB.',
          admin: { description: adminT('marmot:tags:colorDescription') },
        },
      ],
    },
  ],
  timestamps: true,
}
