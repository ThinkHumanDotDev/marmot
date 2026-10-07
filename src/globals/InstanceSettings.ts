import type { FieldAccess, GlobalConfig } from 'payload'

import { authenticated, superadminOnly } from '@/access/org-scoped'
import { isSuperadmin } from '@/access/permissions'
import { env } from '@/env'
import { DEFAULT_EXPIRY_NOTIFY_DAYS, resetInstanceSettingsCache } from '@/server/settings'
import { adminGroup } from '@/i18n/admin'
import { adminT } from '@/i18n/admin'

const superadminField: FieldAccess = ({ req }) => isSuperadmin(req.user)

export const INSTANCE_SETTINGS_SLUG = 'instance-settings' as const

export const ENTRY_PAGES = ['dashboard', 'status-page'] as const
export type EntryPage = (typeof ENTRY_PAGES)[number]

/**
 * Instance-wide settings a superadmin edits at runtime. Environment variables provide the
 * defaults (`src/env.ts`); once a value is saved here it takes precedence. Read through
 * `getInstanceSettings()` in `src/server/settings.ts`, which caches the document for 60 seconds
 * and fills unset fields with the env defaults.
 */
export const InstanceSettings: GlobalConfig = {
  slug: INSTANCE_SETTINGS_SLUG,
  label: adminT('marmot:labels:instanceSettings'),
  admin: {
    group: adminGroup('system'),
  },
  access: {
    read: authenticated,
    update: superadminOnly,
  },
  hooks: {
    afterChange: [
      ({ doc }) => {
        resetInstanceSettingsCache()
        return doc
      },
    ],
  },
  fields: [
    {
      name: 'primaryBaseUrl',
      type: 'text',
      defaultValue: () => env.NEXT_PUBLIC_SERVER_URL,
      admin: {
        description:
          'Public URL of this instance, used in notifications and status page links. Defaults to NEXT_PUBLIC_SERVER_URL.',
      },
    },
    {
      name: 'allowSignup',
      type: 'checkbox',
      defaultValue: () => !env.DISABLE_SIGNUP,
      admin: {
        description:
          'Allow anyone to create an account. When off, only invited users can register. Defaults to the inverse of DISABLE_SIGNUP.',
      },
    },
    {
      name: 'entryPage',
      type: 'select',
      defaultValue: 'dashboard',
      options: [
        { label: adminT('marmot:labels:dashboard'), value: 'dashboard' },
        { label: adminT('marmot:labels:statusPage'), value: 'status-page' },
      ],
      admin: { description: 'What visitors of the root URL see.' },
    },
    {
      type: 'row',
      fields: [
        {
          name: 'tlsExpiryNotifyDays',
          type: 'number',
          hasMany: true,
          min: 1,
          defaultValue: [...DEFAULT_EXPIRY_NOTIFY_DAYS],
          admin: { description: 'Notify this many days before a TLS certificate expires.' },
        },
        {
          name: 'domainExpiryNotifyDays',
          type: 'number',
          hasMany: true,
          min: 1,
          defaultValue: [...DEFAULT_EXPIRY_NOTIFY_DAYS],
          admin: { description: 'Notify this many days before a domain registration expires.' },
        },
      ],
    },
    {
      name: 'keepDataPeriodDays',
      type: 'number',
      min: 0,
      defaultValue: () => env.KEEP_DATA_PERIOD_DAYS,
      admin: {
        description:
          'Retention of daily aggregates and important heartbeats, in days (0 disables pruning). Defaults to KEEP_DATA_PERIOD_DAYS.',
      },
    },
    {
      name: 'trustProxy',
      type: 'checkbox',
      defaultValue: false,
      admin: {
        description:
          'Trust X-Forwarded-* headers from the reverse proxy when determining client IPs.',
      },
    },
    {
      type: 'collapsible',
      label: adminT('marmot:labels:thirdPartyApiKeys'),
      fields: [
        {
          name: 'steamApiKey',
          type: 'text',
          access: { read: superadminField },
          admin: { description: 'Steam Web API key for Steam Game Server monitors.' },
        },
        {
          name: 'globalpingApiToken',
          type: 'text',
          access: { read: superadminField },
          admin: { description: 'Globalping API token for remote ping/HTTP checks.' },
        },
      ],
    },
  ],
}
