import type { CollectionConfig } from 'payload'
import { adminGroup } from '@/i18n/admin'

export const Media: CollectionConfig = {
  slug: 'media',
  admin: {
    group: adminGroup('content'),
  },
  access: {
    read: () => true,
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
