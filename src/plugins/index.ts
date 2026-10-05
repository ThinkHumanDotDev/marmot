import { multiTenantPlugin } from '@payloadcms/plugin-multi-tenant'
import { stripePlugin } from '@payloadcms/plugin-stripe'
import { s3Storage } from '@payloadcms/storage-s3'
import type { Plugin } from 'payload'

import { ROLES } from '@/access/permissions'
import { env } from '@/env'
import { stripeWebhookHandlers } from '@/server/billing/webhooks'

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

  // Billing (hosted offering only). The plugin verifies and dispatches Stripe webhooks at
  // `POST /api/stripe/webhooks`; the handlers in `src/server/billing/webhooks.ts` map subscriptions
  // to `organizations.plan`. The plugin's `sync` option is deliberately not used: it would add
  // columns to `organizations` only when the key is set, which the shared migrations cannot track.
  // Customers are created on demand instead (`src/server/billing/stripe.ts`).
  if (env.STRIPE_SECRET_KEY) {
    plugins.push(
      stripePlugin({
        stripeSecretKey: env.STRIPE_SECRET_KEY,
        stripeWebhooksEndpointSecret: env.STRIPE_WEBHOOK_SECRET,
        isTestKey: env.STRIPE_SECRET_KEY.startsWith('sk_test_'),
        webhooks: stripeWebhookHandlers,
        logs: env.NODE_ENV !== 'production',
      }),
    )
  }

  return plugins
}
