import path from 'node:path'

import type { CollectionConfig } from 'payload'

import { orgScoped } from '@/access/org-scoped'
import { env } from '@/env'
import { adminGroup, adminT } from '@/i18n/admin'
import { CHECK_ARTIFACT_KINDS } from '@/lib/browser-script'

/**
 * Screenshots and Playwright traces of scripted browser checks (#139). Stored like `media` (the
 * upload directory, or the S3 bucket when one is configured) but, unlike media, never public: a
 * journey's screenshot can show account data. Files are served by Payload's upload route, which
 * applies `read` (members with `monitor:read` in the organization).
 *
 * Written exclusively by the worker (`src/server/browser-script/artifacts.ts`) and removed by the
 * retention job after `KEEP_DATA_PERIOD_DAYS` (the important-heartbeat period) and with the monitor.
 */
export const CheckArtifacts: CollectionConfig = {
  slug: 'check-artifacts',
  admin: {
    group: adminGroup('monitoring'),
    description: adminT('marmot:checkArtifacts:description'),
    defaultColumns: ['filename', 'kind', 'monitor', 'createdAt'],
  },
  access: {
    read: orgScoped('monitor:read'),
    create: () => false,
    update: () => false,
    delete: () => false,
  },
  indexes: [{ fields: ['monitor', 'createdAt'] }],
  fields: [
    {
      name: 'organization',
      type: 'relationship',
      relationTo: 'organizations',
      required: true,
      index: true,
    },
    {
      name: 'monitor',
      type: 'relationship',
      relationTo: 'monitors',
      required: true,
      index: true,
    },
    {
      name: 'heartbeat',
      type: 'relationship',
      relationTo: 'heartbeats',
      index: true,
      admin: { description: adminT('marmot:checkArtifacts:heartbeatDescription') },
    },
    {
      name: 'kind',
      type: 'select',
      required: true,
      options: CHECK_ARTIFACT_KINDS.map((value) => ({
        label: adminT(`marmot:labels:${value}`),
        value,
      })),
    },
  ],
  upload: {
    staticDir: path.join(env.UPLOADS_DIR, 'check-artifacts'),
    mimeTypes: ['image/jpeg', 'image/png', 'application/zip'],
    // Traces are opened in the Playwright trace viewer, screenshots inline; neither is resized.
    crop: false,
    focalPoint: false,
  },
}
