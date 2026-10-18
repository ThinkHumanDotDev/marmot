import {
  ValidationError,
  type CollectionAfterChangeHook,
  type CollectionAfterDeleteHook,
  type CollectionBeforeChangeHook,
  type CollectionConfig,
  type PayloadRequest,
} from 'payload'

import { orgScoped } from '@/access/org-scoped'
import { adminGroup, adminT } from '@/i18n/admin'
import { isValidEmailDomain, normalizeEmail, normalizeEmailDomain } from '@/lib/status-page-access'
import {
  MAX_AUDIENCE_DOMAINS,
  MAX_AUDIENCE_EMAILS,
  MAX_AUDIENCE_NAME_LENGTH,
  MAX_AUDIENCES_PER_PAGE,
} from '@/lib/status-page-audiences'
import type { StatusPage, StatusPageAudience } from '@/payload-types'
import type { ErrorKey, ErrorValues } from '@/server/errors'
import { userErrorText } from '@/server/request-locale'
import { reconcileViewerSubscriptions } from '@/server/status-pages/subscribers/audience-membership'

import { relId } from './shared'
import { statusPageComponentIds } from './StatusPageSubscribers'

const invalid = (req: PayloadRequest, key: ErrorKey, path: string, values?: ErrorValues): never => {
  throw new ValidationError({
    collection: 'status-page-audiences',
    errors: [{ message: userErrorText(req, key, values), path }],
  })
}

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []

/**
 * Derives the organization from the page, keeps the page fixed, and normalizes the lists: the
 * components must be rows of the page, addresses and domains are lower-cased and de-duplicated, and
 * each list is bounded.
 */
const prepare: CollectionBeforeChangeHook<StatusPageAudience> = async ({
  data,
  originalDoc,
  operation,
  req,
}) => {
  const pageId = relId(data.statusPage ?? originalDoc?.statusPage)
  if (pageId === null) return invalid(req, 'statusPageAudiencePageRequired', 'statusPage')
  if (
    operation === 'update' &&
    data.statusPage !== undefined &&
    String(relId(data.statusPage)) !== String(relId(originalDoc?.statusPage))
  ) {
    return invalid(req, 'statusPageAudiencePageRequired', 'statusPage')
  }
  const page = (await req.payload.findByID({
    collection: 'status-pages',
    id: pageId,
    depth: 0,
    req,
    overrideAccess: true,
    select: { organization: true, groups: true },
  })) as Pick<StatusPage, 'organization' | 'groups'>
  data.organization = relId(page.organization) as StatusPageAudience['organization']

  if (data.name !== undefined || operation === 'create') {
    const name = String(data.name ?? '').trim()
    if (!name) return invalid(req, 'statusPageAudienceNameRequired', 'name')
    data.name = name.slice(0, MAX_AUDIENCE_NAME_LENGTH)
    const { totalDocs } = await req.payload.count({
      collection: 'status-page-audiences',
      where: {
        and: [
          { statusPage: { equals: pageId } },
          { name: { equals: data.name } },
          ...(originalDoc?.id !== undefined ? [{ id: { not_equals: originalDoc.id } }] : []),
        ],
      },
      req,
      overrideAccess: true,
    })
    if (totalDocs > 0) return invalid(req, 'statusPageAudienceNameTaken', 'name')
  }

  if (data.components !== undefined) {
    const known = statusPageComponentIds(page)
    const requested = [...new Set(strings(data.components).map(String))]
    if (requested.some((id) => !known.has(id))) {
      return invalid(req, 'statusPageAudienceComponentsInvalid', 'components')
    }
    data.components = requested
  }

  if (data.emails !== undefined) {
    const out = new Set<string>()
    for (const raw of strings(data.emails)) {
      if (!raw.trim()) continue
      const email = normalizeEmail(raw)
      if (!email) return invalid(req, 'statusPageAudienceEmailInvalid', 'emails', { email: raw })
      out.add(email)
    }
    if (out.size > MAX_AUDIENCE_EMAILS) {
      return invalid(req, 'statusPageAudienceEmailsTooMany', 'emails', {
        max: MAX_AUDIENCE_EMAILS,
      })
    }
    data.emails = [...out]
  }

  if (data.emailDomains !== undefined) {
    const out = new Set<string>()
    for (const raw of strings(data.emailDomains)) {
      const domain = normalizeEmailDomain(raw)
      if (!domain) continue
      if (!isValidEmailDomain(domain)) {
        return invalid(req, 'statusPageEmailDomainInvalid', 'emailDomains', { domain })
      }
      out.add(domain)
    }
    if (out.size > MAX_AUDIENCE_DOMAINS) {
      return invalid(req, 'statusPageEmailDomainsTooMany', 'emailDomains', {
        max: MAX_AUDIENCE_DOMAINS,
      })
    }
    data.emailDomains = [...out]
  }

  if (operation === 'create') {
    const { totalDocs } = await req.payload.count({
      collection: 'status-page-audiences',
      where: { statusPage: { equals: pageId } },
      req,
      overrideAccess: true,
    })
    if (totalDocs >= MAX_AUDIENCES_PER_PAGE) {
      return invalid(req, 'statusPageAudiencesTooMany', 'statusPage', {
        max: MAX_AUDIENCES_PER_PAGE,
      })
    }
  }
  return data
}

/**
 * Membership can shrink (#278): when an audience's members change or it is deleted, the
 * subscriptions of signed-in viewers it no longer lists are narrowed or ended.
 */
const reconcileAfterChange: CollectionAfterChangeHook<StatusPageAudience> = async ({
  doc,
  previousDoc,
  operation,
  req,
}) => {
  if (operation !== 'update') return doc
  const same = (a?: readonly unknown[] | null, b?: readonly unknown[] | null) =>
    JSON.stringify(a ?? []) === JSON.stringify(b ?? [])
  if (same(doc.emails, previousDoc?.emails) && same(doc.emailDomains, previousDoc?.emailDomains)) {
    return doc
  }
  const pageId = relId(doc.statusPage)
  if (pageId !== null) await reconcileViewerSubscriptions(req.payload, pageId, { req })
  return doc
}

const reconcileAfterDelete: CollectionAfterDeleteHook<StatusPageAudience> = async ({
  doc,
  req,
}) => {
  const pageId = relId(doc?.statusPage)
  if (pageId !== null) await reconcileViewerSubscriptions(req.payload, pageId, { req })
  return doc
}

/**
 * Audiences of a status page (#151): who, among the visitors of an `audience` page, sees which of
 * its components. Viewers sign in with a magic link (`status-page-viewers`) and are admitted when
 * an audience lists their address or its domain; every request re-reads the audiences, so editing
 * one applies at once. The filtering itself lives in `src/server/status-pages/audiences.ts`.
 *
 * Members with `status-page:read` list them; `status-page:update` creates, edits and deletes.
 */
export const StatusPageAudiences: CollectionConfig = {
  slug: 'status-page-audiences',
  admin: {
    useAsTitle: 'name',
    group: adminGroup('statusPages'),
    defaultColumns: ['name', 'statusPage', 'updatedAt'],
  },
  access: {
    read: orgScoped('status-page:read'),
    create: orgScoped('status-page:update'),
    update: orgScoped('status-page:update'),
    delete: orgScoped('status-page:update'),
  },
  hooks: {
    beforeChange: [prepare],
    afterChange: [reconcileAfterChange],
    afterDelete: [reconcileAfterDelete],
  },
  indexes: [{ fields: ['statusPage', 'name'], unique: true }],
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
      name: 'statusPage',
      type: 'relationship',
      relationTo: 'status-pages',
      required: true,
      index: true,
      admin: { position: 'sidebar' },
    },
    { name: 'name', type: 'text', required: true, maxLength: MAX_AUDIENCE_NAME_LENGTH },
    {
      // Component ids (group row ids of the page) the audience sees.
      name: 'components',
      type: 'text',
      hasMany: true,
      admin: { description: adminT('marmot:statusPageAudiences:componentsDescription') },
    },
    {
      name: 'emails',
      type: 'text',
      hasMany: true,
      admin: { description: adminT('marmot:statusPageAudiences:emailsDescription') },
    },
    {
      name: 'emailDomains',
      type: 'text',
      hasMany: true,
      admin: { description: adminT('marmot:statusPageAudiences:emailDomainsDescription') },
    },
  ],
  timestamps: true,
}
