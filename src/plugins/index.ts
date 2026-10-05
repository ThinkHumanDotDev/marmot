import { s3Storage } from '@payloadcms/storage-s3'
import type { Plugin } from 'payload'

import { env } from '@/env'

/**
 * Registry of Payload plugins. Plugins that depend on configuration are added conditionally
 * so a bare self-hosted install needs nothing but a database and Redis.
 */
export function getPlugins(): Plugin[] {
  const plugins: Plugin[] = []

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
