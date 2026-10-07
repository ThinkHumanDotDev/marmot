import {
  ValidationError,
  type Access,
  type CollectionBeforeChangeHook,
  type CollectionBeforeValidateHook,
  type CollectionConfig,
  type Where,
} from 'payload'

import { orgScoped } from '@/access/org-scoped'
import { getOrgIdsWithPermission, isSuperadmin, type UserLike } from '@/access/permissions'
import { adminT } from '@/i18n/admin'
import { defaultLocale, localeNames, locales } from '@/i18n/locales'
import { validateOrganizationSlug } from '@/lib/reserved-slugs'
import { enforceEntitlementOnCreate } from '@/server/billing/entitlements'

import { statusPageThemeFields } from './status-page-theme'

import type { StatusPage } from '@/payload-types'

export const STATUS_PAGE_THEMES = ['auto', 'light', 'dark'] as const
export type StatusPageTheme = (typeof STATUS_PAGE_THEMES)[number]

/** `auto` follows the visitor's browser language; otherwise a fixed locale from `src/i18n/locales.ts`. */
export const STATUS_PAGE_LANGUAGE_AUTO = 'auto' as const
export type StatusPageLanguage = typeof STATUS_PAGE_LANGUAGE_AUTO | (typeof locales)[number]

/** RFC 1123 hostname: labels of letters, digits and hyphens joined by dots; no scheme, no port. */
export const HOSTNAME_PATTERN =
  /^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?<!-)(?:\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/

export const normalizeHostname = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/[/:].*$/, '')

export function validateHostname(value: unknown): true | string {
  if (typeof value !== 'string' || value.length === 0) return 'Hostname is required.'
  if (!HOSTNAME_PATTERN.test(value)) {
    return 'Enter a bare hostname such as status.example.com (no scheme, path or port).'
  }
  return true
}

/**
 * Members (and anyone with `status-page:read` in one of their organizations) see every page of
 * their organizations, drafts included. Everyone else — including anonymous visitors — only sees
 * pages with `published: true`. Superadmins see everything.
 */
export const readStatusPages: Access = ({ req }) => {
  const user = req.user as UserLike | null | undefined
  if (user && isSuperadmin(user)) return true

  const published: Where = { published: { equals: true } }
  if (!user) return published

  const orgIds = getOrgIdsWithPermission(user, 'status-page:read')
  if (orgIds.length === 0) return published
  return { or: [{ organization: { in: orgIds } }, published] }
}

/** Lowercase the slug and hostnames so lookups by `Host` header and URL are exact matches. */
const normalize: CollectionBeforeValidateHook<StatusPage> = ({ data }) => {
  if (!data) return data
  if (typeof data.slug === 'string') data.slug = data.slug.trim().toLowerCase()
  if (Array.isArray(data.domains)) {
    data.domains = data.domains
      .map((row) => ({ ...row, hostname: normalizeHostname(String(row?.hostname ?? '')) }))
      .filter((row) => row.hostname.length > 0)
  }
  return data
}

const relId = (value: unknown): string | number | null => {
  if (typeof value === 'string' || typeof value === 'number') return value
  if (value && typeof value === 'object' && 'id' in value) {
    const id = (value as { id: unknown }).id
    if (typeof id === 'string' || typeof id === 'number') return id
  }
  return null
}

/**
 * Every monitor referenced by `groups[].monitors[].monitor` must belong to the page's organization.
 * `filterOptions` only guards the admin UI; this hook guards the API so a member cannot publish
 * another organization's monitors on their page. Hostnames must be unique across all pages because
 * the proxy maps `Host` → slug.
 */
const validateReferences: CollectionBeforeChangeHook<StatusPage> = async ({
  data,
  originalDoc,
  req,
}) => {
  const organization = relId(data.organization ?? originalDoc?.organization)

  const monitorIds = new Set<string>()
  for (const group of data.groups ?? []) {
    for (const row of group.monitors ?? []) {
      const id = relId(row.monitor)
      if (id !== null) monitorIds.add(String(id))
    }
  }

  if (monitorIds.size > 0) {
    const { docs } = await req.payload.find({
      collection: 'monitors',
      where: { id: { in: [...monitorIds] } },
      depth: 0,
      limit: monitorIds.size,
      pagination: false,
      req,
      overrideAccess: true,
    })
    const foreign = docs.filter((m) => String(relId(m.organization)) !== String(organization))
    if (foreign.length > 0 || docs.length !== monitorIds.size) {
      throw new ValidationError({
        collection: 'status-pages',
        errors: [
          {
            message: 'Every monitor on a status page must belong to the same organization.',
            path: 'groups',
          },
        ],
      })
    }
  }

  const hostnames = (data.domains ?? []).map((row) => row.hostname).filter(Boolean)
  if (hostnames.length > 0) {
    if (new Set(hostnames).size !== hostnames.length) {
      throw new ValidationError({
        collection: 'status-pages',
        errors: [{ message: 'Each hostname may only be listed once.', path: 'domains' }],
      })
    }
    const where: Where[] = [{ 'domains.hostname': { in: hostnames } }]
    if (originalDoc?.id !== undefined) where.push({ id: { not_equals: originalDoc.id } })
    const taken = await req.payload.find({
      collection: 'status-pages',
      where: { and: where },
      depth: 0,
      limit: 1,
      req,
      overrideAccess: true,
    })
    if (taken.totalDocs > 0) {
      throw new ValidationError({
        collection: 'status-pages',
        errors: [
          {
            message: 'One of these hostnames is already used by another status page.',
            path: 'domains',
          },
        ],
      })
    }
  }

  return data
}

export const StatusPages: CollectionConfig = {
  slug: 'status-pages',
  admin: {
    useAsTitle: 'title',
    group: 'Status pages',
    defaultColumns: ['title', 'slug', 'published', 'organization', 'updatedAt'],
  },
  access: {
    read: readStatusPages,
    create: orgScoped('status-page:create'),
    update: orgScoped('status-page:update'),
    delete: orgScoped('status-page:delete'),
  },
  hooks: {
    beforeValidate: [normalize],
    // Plan limits (no-op unless BILLING_ENABLED).
    beforeChange: [validateReferences, enforceEntitlementOnCreate('statusPages')],
  },
  indexes: [{ fields: ['organization', 'published'] }],
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
        { name: 'title', type: 'text', required: true },
        {
          name: 'slug',
          type: 'text',
          required: true,
          unique: true,
          index: true,
          validate: (value: unknown) => validateOrganizationSlug(value),
          admin: {
            description: adminT('marmot:statusPages:slugDescription'),
          },
        },
      ],
    },
    { name: 'description', type: 'textarea' },
    {
      name: 'logo',
      type: 'upload',
      relationTo: 'media',
      admin: { description: adminT('marmot:statusPages:logoDescription') },
    },
    {
      name: 'theme',
      type: 'select',
      defaultValue: 'auto',
      options: STATUS_PAGE_THEMES.map((theme) => ({ label: theme, value: theme })),
      admin: { description: adminT('marmot:statusPages:themeDescription') },
    },
    ...statusPageThemeFields,
    {
      name: 'language',
      type: 'select',
      label: adminT('marmot:language'),
      defaultValue: defaultLocale,
      options: [
        { label: adminT('marmot:followVisitor'), value: STATUS_PAGE_LANGUAGE_AUTO },
        ...locales.map((locale) => ({ label: localeNames[locale], value: locale })),
      ],
      admin: { description: adminT('marmot:statusPageLanguageDescription') },
    },
    {
      name: 'published',
      type: 'checkbox',
      defaultValue: false,
      index: true,
      admin: {
        position: 'sidebar',
        description: adminT('marmot:statusPages:publishedDescription'),
      },
    },
    {
      type: 'row',
      fields: [
        { name: 'searchEngineIndex', type: 'checkbox', defaultValue: false },
        { name: 'showTags', type: 'checkbox', defaultValue: false },
        { name: 'showCertificateExpiry', type: 'checkbox', defaultValue: false },
        { name: 'showPoweredBy', type: 'checkbox', defaultValue: true },
      ],
    },
    {
      name: 'autoRefreshInterval',
      type: 'number',
      defaultValue: 300,
      min: 0,
      admin: { description: adminT('marmot:statusPages:autoRefreshIntervalDescription') },
    },
    { name: 'footerText', type: 'textarea' },
    {
      name: 'customCSS',
      type: 'code',
      admin: { language: 'css', description: adminT('marmot:statusPages:customCSSDescription') },
    },
    {
      name: 'googleAnalyticsId',
      type: 'text',
      validate: (value: unknown) =>
        value == null || value === '' || /^(G|UA|AW|DC)-[A-Z0-9-]+$/i.test(String(value))
          ? true
          : 'Enter a Google Analytics measurement ID such as G-XXXXXXX.',
    },
    {
      name: 'domains',
      type: 'array',
      admin: {
        description: adminT('marmot:statusPages:domainsDescription'),
      },
      fields: [
        {
          name: 'hostname',
          type: 'text',
          required: true,
          index: true,
          validate: (value: unknown) => validateHostname(value),
        },
      ],
    },
    {
      name: 'groups',
      type: 'array',
      admin: { description: adminT('marmot:statusPages:groupsDescription') },
      fields: [
        { name: 'name', type: 'text', required: true },
        {
          name: 'monitors',
          type: 'array',
          fields: [
            {
              name: 'monitor',
              type: 'relationship',
              relationTo: 'monitors',
              required: true,
              filterOptions: ({ data }): Where | true => {
                const organization = relId((data as { organization?: unknown })?.organization)
                return organization === null ? true : { organization: { equals: organization } }
              },
            },
            {
              type: 'row',
              fields: [
                {
                  name: 'sendUrl',
                  type: 'checkbox',
                  defaultValue: false,
                  admin: { description: adminT('marmot:statusPages:sendUrlDescription') },
                },
                {
                  name: 'customUrl',
                  type: 'text',
                  admin: { description: adminT('marmot:statusPages:customUrlDescription') },
                },
              ],
            },
          ],
        },
      ],
    },
  ],
  timestamps: true,
}
