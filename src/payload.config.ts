import path from 'path'
import { fileURLToPath } from 'url'
import { lexicalEditor } from '@payloadcms/richtext-lexical'
import { buildConfig } from 'payload'
import sharp from 'sharp'

import { collections } from './collections'
import { getDatabaseAdapter } from './db/adapter'
import { env, runsRole } from './env'
import { getPlugins } from './plugins'
import { getEmailAdapter } from './server/email/adapter'

const filename = fileURLToPath(import.meta.url)
const dirname = path.dirname(filename)

export default buildConfig({
  serverURL: env.NEXT_PUBLIC_SERVER_URL,
  admin: {
    user: 'users',
    importMap: {
      baseDir: path.resolve(dirname),
    },
    meta: {
      titleSuffix: ' · Marmot',
    },
  },
  collections,
  editor: lexicalEditor(),
  email: getEmailAdapter(),
  secret: env.PAYLOAD_SECRET,
  typescript: {
    outputFile: path.resolve(dirname, 'payload-types.ts'),
  },
  db: getDatabaseAdapter(),
  // Payload Jobs: low-frequency background work (emails, cleanup). High-frequency monitor checks use
  // BullMQ (src/server/engine). Register tasks here; Payload only creates the jobs collection and
  // starts the cron once at least one task or workflow exists. Jobs run in the worker process only.
  jobs: {
    tasks: [],
    autoRun: [{ cron: '* * * * *', queue: 'default', limit: 10 }],
    shouldAutoRun: async () => runsRole('worker'),
  },
  sharp,
  plugins: getPlugins(),
  telemetry: false,
})
