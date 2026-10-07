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
import { adminGroup, adminT } from '@/i18n/admin'
import { defaultLocale, localeNames, locales } from '@/i18n/locales'
import {
  DEFAULT_MAINTENANCE_VISIBILITY_HOURS,
  MAX_MAINTENANCE_VISIBILITY_HOURS,
} from '@/lib/maintenance-announcements'
import { validateOrganizationSlug } from '@/lib/reserved-slugs'
import { STATUS_PAGE_ACCESS_MODES } from '@/lib/status-page-access'
import { COMPONENT_TYPES, isContactUrl, isHttpUrl } from '@/lib/status-page-components'
import { enforceEntitlementOnCreate } from '@/server/billing/entitlements'
import { applyAccessPassword } from '@/server/status-pages/access-password'

import { statusPageThemeFields } from './status-page-theme'
import { detachTemplatesFromStatusPage } from './Templates'

import type { StatusPage } from '@/payload-types'
import type { ErrorKey } from '@/server/errors'
import { userErrorText } from '@/server/request-locale'

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

  // Password-protected pages are only served through the public endpoints, which check access.
  const published: Where = {
    and: [
      { published: { equals: true } },
      { or: [{ access: { not_equals: 'password' } }, { access: { exists: false } }] },
    ],
  }
  if (!user) return published

  const orgIds = getOrgIdsWithPermission(user, 'status-page:read')
  if (orgIds.length === 0) return published
  return { or: [{ organization: { in: orgIds } }, published] }
}

const optionalUrl =
  (check: (value: string) => boolean, message: ErrorKey) =>
  (value: unknown, { req }: { req: { user?: unknown } }): true | string =>
    value == null || value === '' || (typeof value === 'string' && check(value.trim()))
      ? true
      : userErrorText(req, message)

/**
 * Lowercase the slug and hostnames so lookups by `Host` header and URL are exact matches; static
 * components never keep a monitor reference.
 */
const normalize: CollectionBeforeValidateHook<StatusPage> = ({ data }) => {
  if (!data) return data
  if (typeof data.slug === 'string') data.slug = data.slug.trim().toLowerCase()
  for (const key of ['homepageUrl', 'contactUrl'] as const) {
    if (typeof data[key] === 'string') data[key] = data[key].trim() || null
  }
  if (Array.isArray(data.groups)) {
    for (const group of data.groups) {
      for (const row of group?.monitors ?? []) {
        if (row?.type === 'static') row.monitor = null
        if (typeof row?.name === 'string') row.name = row.name.trim() || null
      }
    }
  }
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
            message: userErrorText(req, 'statusPageForeignMonitors'),
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
        errors: [{ message: userErrorText(req, 'hostnameDuplicate'), path: 'domains' }],
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
            message: userErrorText(req, 'hostnameTaken'),
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
    group: adminGroup('statusPages'),
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
    beforeChange: [
      validateReferences,
      applyAccessPassword,
      enforceEntitlementOnCreate('statusPages'),
    ],
    beforeDelete: [detachTemplatesFromStatusPage],
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
      type: 'row',
      fields: [
        {
          name: 'homepageUrl',
          type: 'text',
          validate: optionalUrl(isHttpUrl, 'httpUrlRequired'),
          admin: { description: adminT('marmot:statusPages:homepageUrlDescription') },
        },
        {
          name: 'contactUrl',
          type: 'text',
          validate: optionalUrl(isContactUrl, 'contactUrlInvalid'),
          admin: { description: adminT('marmot:statusPages:contactUrlDescription') },
        },
      ],
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
      name: 'access',
      type: 'select',
      defaultValue: 'public',
      options: STATUS_PAGE_ACCESS_MODES.map((mode) => ({ label: mode, value: mode })),
      admin: {
        position: 'sidebar',
        description: adminT('marmot:statusPages:accessDescription'),
      },
    },
    {
      // Write-only: hashed into `passwordHash` by `applyAccessPassword`, never stored or returned.
      name: 'password',
      type: 'text',
      virtual: true,
      access: { read: () => false },
      admin: {
        position: 'sidebar',
        condition: (data) => data?.access === 'password',
        description: adminT('marmot:statusPages:passwordDescription'),
      },
    },
    {
      // scrypt hash of the page password. Only server code reading with `overrideAccess` sees it.
      name: 'passwordHash',
      type: 'text',
      access: { read: () => false, create: () => false, update: () => false },
      admin: { hidden: true },
    },
    {
      type: 'row',
      fields: [
        { name: 'searchEngineIndex', type: 'checkbox', defaultValue: false },
        { name: 'showTags', type: 'checkbox', defaultValue: false },
        { name: 'showCertificateExpiry', type: 'checkbox', defaultValue: false },
        { name: 'showPoweredBy', type: 'checkbox', defaultValue: true },
        {
          name: 'showValues',
          type: 'checkbox',
          defaultValue: true,
          admin: { description: adminT('marmot:statusPages:showValuesDescription') },
        },
      ],
    },
    {
      name: 'autoRefreshInterval',
      type: 'number',
      defaultValue: 300,
      min: 0,
      admin: { description: adminT('marmot:statusPages:autoRefreshIntervalDescription') },
    },
    {
      name: 'maintenanceVisibilityHours',
      type: 'number',
      defaultValue: DEFAULT_MAINTENANCE_VISIBILITY_HOURS,
      min: 0,
      max: MAX_MAINTENANCE_VISIBILITY_HOURS,
      admin: {
        description: adminT('marmot:statusPages:maintenanceVisibilityHoursDescription'),
      },
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
          name: 'defaultOpen',
          type: 'checkbox',
          defaultValue: true,
          admin: { description: adminT('marmot:statusPages:defaultOpenDescription') },
        },
        {
          // Each row is a component (see src/lib/status-page-components.ts); the array keeps its
          // original name so existing pages migrate unchanged.
          name: 'monitors',
          type: 'array',
          admin: { description: adminT('marmot:statusPages:componentsDescription') },
          fields: [
            {
              name: 'type',
              type: 'select',
              defaultValue: 'monitor',
              options: COMPONENT_TYPES.map((type) => ({ label: type, value: type })),
              admin: { description: adminT('marmot:statusPages:componentTypeDescription') },
            },
            {
              name: 'monitor',
              type: 'relationship',
              relationTo: 'monitors',
              validate: (
                value: unknown,
                { req, siblingData }: { req: { user?: unknown }; siblingData: unknown },
              ) =>
                (siblingData as { type?: string } | undefined)?.type === 'static' ||
                (value !== null && value !== undefined && value !== '')
                  ? true
                  : userErrorText(req, 'componentMonitorRequired'),
              filterOptions: ({ data }): Where | true => {
                const organization = relId((data as { organization?: unknown })?.organization)
                return organization === null ? true : { organization: { equals: organization } }
              },
              admin: {
                condition: (_data, siblingData) =>
                  (siblingData as { type?: string } | undefined)?.type !== 'static',
              },
            },
            {
              name: 'name',
              type: 'text',
              validate: (value: unknown, { siblingData }: { siblingData: unknown }) =>
                (siblingData as { type?: string } | undefined)?.type !== 'static' ||
                (typeof value === 'string' && value.trim().length > 0)
                  ? true
                  : 'A static component needs a name.',
              admin: { description: adminT('marmot:statusPages:componentNameDescription') },
            },
            {
              name: 'description',
              type: 'textarea',
              admin: { description: adminT('marmot:statusPages:componentDescriptionDescription') },
            },
            {
              name: 'showValues',
              type: 'checkbox',
              defaultValue: true,
              admin: { description: adminT('marmot:statusPages:componentShowValuesDescription') },
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
