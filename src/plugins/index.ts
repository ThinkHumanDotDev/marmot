import { multiTenantPlugin } from '@payloadcms/plugin-multi-tenant'
import { s3Storage } from '@payloadcms/storage-s3'
import type { Plugin } from 'payload'

import { ROLES } from '@/access/permissions'
import { env } from '@/env'

import type { Config } from '@/payload-types'

/**
 * Registry of Payload plugins. Plugins that depend on configuration are added conditionally
 * so a bare self-hosted install needs nothing but a database and Redis.
 */
export function getPlugins(): Plugin[] {
  const plugins: Plugin[] = []

  // Organizations are tenants. The plugin adds `users.organizations[] { organization, role }` and,
  // for every collection listed in `collections`, an `organization` relationship plus tenant-aware
  // access and admin filters. Collections opt in here as they are added.
  plugins.push(
    multiTenantPlugin<Config>({
      collections: {},
      tenantsSlug: 'organizations',
      tenantField: { name: 'organization' },
      tenantsArrayField: {
        includeDefaultField: true,
        arrayFieldName: 'organizations',
        arrayTenantFieldName: 'organization',
        rowFields: [
          {
            name: 'role',
            type: 'select',
            required: true,
            defaultValue: 'member',
            saveToJWT: true,
            options: ROLES.map((role) => ({ label: role, value: role })),
          },
        ],
      },
      userHasAccessToAllTenants: (user) => user.superadmin === true,
      // `src/collections/Organizations.ts` implements tenant access itself so that users without
      // an organization can still create their first one.
      useTenantsCollectionAccess: false,
    }),
  )

  if (env.S3_BUCKET) {
    plugins.push(
      s3Storage({
        collections: { media: true },
        bucket: env.S3_BUCKET,
        config: {
          region: env.S3_REGION,
          endpoint: env.S3_ENDPOINT,
          forcePathStyle: env.S3_FORCE_PATH_STYLE,
          credentials:
            env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY
              ? { accessKeyId: env.S3_ACCESS_KEY_ID, secretAccessKey: env.S3_SECRET_ACCESS_KEY }
              : undefined,
        },
      }),
    )
  }

  return plugins
}
