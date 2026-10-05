import path from 'path'
import { fileURLToPath } from 'url'
import { lexicalEditor } from '@payloadcms/richtext-lexical'
import { buildConfig } from 'payload'
import sharp from 'sharp'

import { collections } from './collections'
import { getDatabaseAdapter } from './db/adapter'
import { env } from './env'
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
  sharp,
  plugins: getPlugins(),
  telemetry: false,
})
