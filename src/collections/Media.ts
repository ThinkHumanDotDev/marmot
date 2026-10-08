import type { CollectionConfig } from 'payload'

import { superadminOnly } from '@/access/org-scoped'
import { adminGroup } from '@/i18n/admin'

export const Media: CollectionConfig = {
  slug: 'media',
  admin: {
    group: adminGroup('content'),
  },
  access: {
    // Public on purpose: status page logos and favicons are served to anonymous visitors.
    read: () => true,
    // Media rows belong to no organization, so the REST/GraphQL API must not write them: any
    // signed-in user could otherwise replace or delete another organization's logo. The app's
    // upload routes check the caller's permission, validate the file and store it with
    // `overrideAccess` (`src/server/media/store.ts`); superadmins keep the admin panel.
    create: superadminOnly,
    update: superadminOnly,
    delete: superadminOnly,
  },
  fields: [
    {
      name: 'alt',
      type: 'text',
    },
  ],
  upload: {
    staticDir: process.env.UPLOADS_DIR || 'uploads',
    mimeTypes: ['image/*'],
  },
}
