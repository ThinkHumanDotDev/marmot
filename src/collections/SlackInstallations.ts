import type { CollectionBeforeDeleteHook, CollectionConfig, FieldAccess } from 'payload'

import { orgScoped, superadminOnly } from '@/access/org-scoped'
import { adminGroup } from '@/i18n/admin'
import { removeAppSubscriptions } from '@/server/slack/installations'

/** Written by the server only (`overrideAccess: true` bypasses field access). */
const serverOnly: FieldAccess = () => false

/**
 * The linked Slack users of a workspace and the channel subscriptions made with `/marmot subscribe`
 * (on any organization's pages) go with its installation.
 */
const removeLinks: CollectionBeforeDeleteHook = async ({ id, req }) => {
  const installation = await req.payload.findByID({
    collection: 'slack-installations',
    id,
    depth: 0,
    req,
    overrideAccess: true,
    disableErrors: true,
  })
  if (installation?.teamId) await removeAppSubscriptions(req.payload, installation.teamId, req)
  await req.payload.delete({
    collection: 'slack-user-links',
    where: { installation: { equals: id } },
    depth: 0,
    req,
    overrideAccess: true,
  })
}

/**
 * Slack app installations (#129): one Slack workspace per organization and one organization per
 * workspace (both unique), created by the OAuth callback (`src/server/slack/oauth.ts`). The bot
 * token is sealed with a key derived from `PAYLOAD_SECRET` (`src/server/slack/tokens.ts`) and never
 * readable through the API. Members see the installation (`integration:read`); admins install and
 * remove it through `/api/orgs/:orgId/slack` (`integration:manage`), so collection writes are
 * superadmin-only.
 */
export const SlackInstallations: CollectionConfig = {
  slug: 'slack-installations',
  admin: {
    useAsTitle: 'teamName',
    group: adminGroup('monitoring'),
    defaultColumns: ['teamName', 'teamId', 'organization', 'createdAt'],
  },
  access: {
    read: orgScoped('integration:read'),
    create: superadminOnly,
    update: superadminOnly,
    delete: superadminOnly,
  },
  hooks: {
    beforeDelete: [removeLinks],
  },
  fields: [
    {
      name: 'organization',
      type: 'relationship',
      relationTo: 'organizations',
      required: true,
      unique: true,
      index: true,
      admin: { position: 'sidebar', readOnly: true },
    },
    {
      type: 'row',
      fields: [
        { name: 'teamId', type: 'text', required: true, unique: true, index: true },
        { name: 'teamName', type: 'text' },
      ],
    },
    {
      type: 'row',
      fields: [
        { name: 'enterpriseId', type: 'text' },
        { name: 'appId', type: 'text' },
        { name: 'botUserId', type: 'text' },
      ],
    },
    {
      // AES-256-GCM sealed `xoxb-` token (`sealBotToken`).
      name: 'botToken',
      type: 'text',
      required: true,
      access: { read: serverOnly, create: serverOnly, update: serverOnly },
      admin: { hidden: true },
    },
    { name: 'scopes', type: 'text', hasMany: true, admin: { readOnly: true } },
    {
      name: 'installedBy',
      type: 'relationship',
      relationTo: 'users',
      admin: { readOnly: true },
    },
  ],
  timestamps: true,
}
