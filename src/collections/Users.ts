import type { CollectionConfig } from 'payload'

export const Users: CollectionConfig = {
  slug: 'users',
  admin: {
    useAsTitle: 'email',
    group: 'Access',
  },
  auth: true,
  fields: [
    // email + password are added by `auth: true`
    {
      name: 'name',
      type: 'text',
    },
    {
      name: 'superadmin',
      type: 'checkbox',
      defaultValue: false,
      admin: {
        description:
          'Instance administrator: can access the Payload admin panel and every organization.',
      },
    },
  ],
}
