import {
  ValidationError,
  type CollectionBeforeDeleteHook,
  type CollectionBeforeValidateHook,
  type CollectionConfig,
  type FieldAccess,
  type Where,
} from 'payload'

import { orgScoped } from '@/access/org-scoped'
import { adminGroup, adminT } from '@/i18n/admin'
import {
  LOCAL_LOCATION,
  LOCATION_SLUG_PATTERN,
  LOCATION_STATUSES,
  MAX_LOCATION_LABELS,
  locationSlug,
  monitorLocationIds,
} from '@/lib/probe-locations'
import type { Location, Monitor } from '@/payload-types'
import { userErrorText } from '@/server/request-locale'

import { relId } from './shared'

/** Written by the server only (`overrideAccess: true` bypasses field access). */
const serverOnly: FieldAccess = () => false

/**
 * Trims the name, derives the slug from it when none was given and keeps slugs unique per
 * organization (`local` is the implicit location of the worker pool and cannot be taken).
 */
const normalize: CollectionBeforeValidateHook<Location> = async ({ data, originalDoc, req }) => {
  if (!data) return data
  if (typeof data.name === 'string') data.name = data.name.trim()
  const fail = (path: string, message: string): never => {
    throw new ValidationError({ collection: 'locations', errors: [{ message, path }] })
  }

  let slug = typeof data.slug === 'string' ? data.slug.trim().toLowerCase() : undefined
  if (!slug && !originalDoc?.slug) slug = locationSlug(data.name ?? '')
  if (slug !== undefined) {
    if (!LOCATION_SLUG_PATTERN.test(slug)) fail('slug', userErrorText(req, 'locationSlugInvalid'))
    if (slug === LOCAL_LOCATION) fail('slug', userErrorText(req, 'locationSlugReserved'))
    data.slug = slug
  }

  const effectiveSlug = data.slug ?? originalDoc?.slug
  const organization = relId(data.organization ?? originalDoc?.organization)
  if (effectiveSlug && organization !== null && effectiveSlug !== originalDoc?.slug) {
    const and: Where[] = [
      { organization: { equals: organization } },
      { slug: { equals: effectiveSlug } },
    ]
    if (originalDoc?.id !== undefined) and.push({ id: { not_equals: originalDoc.id } })
    const { totalDocs } = await req.payload.count({
      collection: 'locations',
      where: { and },
      req,
      overrideAccess: true,
    })
    if (totalDocs > 0) fail('slug', userErrorText(req, 'locationSlugTaken'))
  }

  if (Array.isArray(data.labels)) {
    const keys = data.labels.map((row) => String(row?.key ?? '').trim())
    if (new Set(keys).size !== keys.length)
      fail('labels', userErrorText(req, 'locationLabelDuplicate'))
  }
  return data
}

/**
 * Monitors of a deleted location fall back to the local worker pool. The update runs the monitors'
 * hooks (no `skipEngineSync`), so their scheduler is registered on the workers again.
 */
const detachFromMonitors: CollectionBeforeDeleteHook = async ({ id, req }) => {
  const { docs } = await req.payload.find({
    collection: 'monitors',
    where: { locations: { in: [id] } },
    select: { locations: true },
    depth: 0,
    limit: 0,
    pagination: false,
    req,
    overrideAccess: true,
  })
  for (const monitor of docs as Pick<Monitor, 'id' | 'locations'>[]) {
    await req.payload.update({
      collection: 'monitors',
      id: monitor.id,
      data: {
        locations: monitorLocationIds(monitor).filter(
          (locationId) => String(locationId) !== String(id),
        ) as Monitor['locations'],
      },
      depth: 0,
      req,
      overrideAccess: true,
    })
  }
}

/**
 * Probe locations (#91): self-hosted check locations whose agents (`MARMOT_ROLE=probe`) pull the
 * monitors assigned to them over HTTPS, run them in their own network and push the results back.
 * Only the SHA-256 of the location's token is stored (`src/server/probes/tokens.ts`); `status` and
 * `lastSeenAt` are maintained by the server (`src/server/probes`).
 */
export const Locations: CollectionConfig = {
  slug: 'locations',
  admin: {
    useAsTitle: 'name',
    group: adminGroup('monitoring'),
    defaultColumns: ['name', 'slug', 'status', 'lastSeenAt', 'organization'],
    description: adminT('marmot:locations:description'),
  },
  // Everyone sees where monitors are checked from; admins manage locations and their tokens.
  access: {
    read: orgScoped('location:read'),
    create: orgScoped('location:create'),
    update: orgScoped('location:update'),
    delete: orgScoped('location:delete'),
  },
  indexes: [{ fields: ['organization', 'slug'], unique: true }],
  hooks: {
    beforeValidate: [normalize],
    beforeDelete: [detachFromMonitors],
  },
  fields: [
    {
      name: 'organization',
      type: 'relationship',
      relationTo: 'organizations',
      required: true,
      index: true,
      admin: { position: 'sidebar' },
    },
    { name: 'name', type: 'text', required: true, maxLength: 100 },
    {
      name: 'slug',
      type: 'text',
      required: true,
      maxLength: 60,
      index: true,
      admin: { description: adminT('marmot:locations:slugDescription') },
    },
    {
      name: 'labels',
      type: 'array',
      maxRows: MAX_LOCATION_LABELS,
      admin: { description: adminT('marmot:locations:labelsDescription') },
      fields: [
        {
          type: 'row',
          fields: [
            { name: 'key', type: 'text', required: true, maxLength: 64 },
            { name: 'value', type: 'text', maxLength: 200 },
          ],
        },
      ],
    },
    {
      name: 'tokenHash',
      type: 'text',
      required: true,
      unique: true,
      index: true,
      access: { read: serverOnly, create: serverOnly, update: serverOnly },
      admin: { hidden: true },
    },
    {
      name: 'tokenPrefix',
      type: 'text',
      required: true,
      access: { create: serverOnly, update: serverOnly },
      admin: { readOnly: true, description: adminT('marmot:locations:tokenPrefixDescription') },
    },
    {
      name: 'tokenRotatedAt',
      type: 'date',
      access: { create: serverOnly, update: serverOnly },
      admin: { readOnly: true, position: 'sidebar', date: { pickerAppearance: 'dayAndTime' } },
    },
    {
      name: 'status',
      type: 'select',
      required: true,
      defaultValue: 'unknown',
      index: true,
      options: LOCATION_STATUSES.map((value) => ({ label: value, value })),
      access: { create: serverOnly, update: serverOnly },
      admin: {
        readOnly: true,
        position: 'sidebar',
        description: adminT('marmot:locations:statusDescription'),
      },
    },
    {
      name: 'statusChangedAt',
      type: 'date',
      access: { create: serverOnly, update: serverOnly },
      admin: { readOnly: true, position: 'sidebar', date: { pickerAppearance: 'dayAndTime' } },
    },
    {
      name: 'lastSeenAt',
      type: 'date',
      index: true,
      access: { create: serverOnly, update: serverOnly },
      admin: { readOnly: true, position: 'sidebar', date: { pickerAppearance: 'dayAndTime' } },
    },
    {
      name: 'agent',
      type: 'group',
      access: { create: serverOnly, update: serverOnly },
      admin: { readOnly: true, description: adminT('marmot:locations:agentDescription') },
      fields: [
        { name: 'version', type: 'text', maxLength: 64 },
        { name: 'hostname', type: 'text', maxLength: 255 },
        { name: 'platform', type: 'text', maxLength: 64 },
      ],
    },
    {
      name: 'createdBy',
      type: 'relationship',
      relationTo: 'users',
      access: { create: serverOnly, update: serverOnly },
      admin: { readOnly: true, position: 'sidebar' },
    },
  ],
  timestamps: true,
}
