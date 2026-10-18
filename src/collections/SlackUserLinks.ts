import type { CollectionConfig } from 'payload'

import { orgScoped, superadminOnly } from '@/access/org-scoped'
import { adminGroup } from '@/i18n/admin'

/**
 * Slack users linked to Marmot accounts (#129), one row per workspace and Slack user (unique). A
 * Slack user can only change something (subscribe a channel, post an incident update, acknowledge,
 * "Check now") once linked, and then only with the linked member's permissions in the installing
 * organization. Created when a signed-in member confirms `/marmot link` (`/slack/link/<token>`) or
 * installs the app; removed by `/marmot unlink`, by an admin in Settings → Integrations, or with the
 * installation.
 */
export const SlackUserLinks: CollectionConfig = {
  slug: 'slack-user-links',
  admin: {
    useAsTitle: 'slackUserId',
    group: adminGroup('monitoring'),
    defaultColumns: ['slackUserId', 'user', 'teamId', 'createdAt'],
  },
  access: {
    read: orgScoped('integration:read'),
    create: superadminOnly,
    update: superadminOnly,
    delete: superadminOnly,
  },
  indexes: [{ fields: ['teamId', 'slackUserId'], unique: true }],
  fields: [
    {
      name: 'organization',
      type: 'relationship',
      relationTo: 'organizations',
      required: true,
      index: true,
      admin: { position: 'sidebar', readOnly: true },
    },
    {
      name: 'installation',
      type: 'relationship',
      relationTo: 'slack-installations',
      required: true,
      index: true,
    },
    {
      type: 'row',
      fields: [
        { name: 'teamId', type: 'text', required: true },
        { name: 'slackUserId', type: 'text', required: true },
      ],
    },
    // Not required: a deleted account leaves the row unlinked (`null`) until it is cleaned up.
    { name: 'user', type: 'relationship', relationTo: 'users', index: true },
  ],
  timestamps: true,
}
