import { withPayload } from '@payloadcms/next/withPayload'
import type { NextConfig } from 'next'
import createNextIntlPlugin from 'next-intl/plugin'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const dirname = path.dirname(__filename)

const posthogHost = process.env.NEXT_PUBLIC_POSTHOG_HOST || 'https://us.i.posthog.com'
const posthogAssetsHost = posthogHost.replace('.i.posthog.com', '-assets.i.posthog.com')

// Security headers applied to every response. CSP is deliberately not set yet (the Payload admin and
// status pages with custom CSS need an allowlist first). See docs/Security.md.
//
// HSTS is sent when the public URL is https. The Docker image is built without NEXT_PUBLIC_SERVER_URL
// (headers are fixed at build time), so a production build with no URL keeps the header too: browsers
// ignore HSTS received over plain HTTP, while an https deployment behind Caddy gets it. Plain-HTTP dev
// builds never send it, so a localhost https experiment cannot poison the browser.
const serverUrl = process.env.NEXT_PUBLIC_SERVER_URL ?? ''
const sendHsts =
  serverUrl.startsWith('https://') || (process.env.NODE_ENV === 'production' && serverUrl === '')

const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  {
    key: 'Permissions-Policy',
    value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()',
  },
  ...(sendHsts
    ? [{ key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' }]
    : []),
]

// Optional monitor drivers (`optionalDependencies`) are imported lazily by `src/server/monitor-types/*`
// and resolved from node_modules at runtime; bundling them (native bindings, protocol fixtures) is
// neither needed nor wanted in the web server bundle.
const monitorDriverPackages = [
  '@grpc/grpc-js',
  'gamedig',
  'kafkajs',
  'mongodb',
  'mqtt',
  'mssql',
  'mysql2',
  'net-snmp',
  'pg',
  'lighthouse',
  'playwright-core',
  'puppeteer-core',
  'protobufjs',
  'radius',
  'ssh2',
  'ssh2-sftp-client',
  'ws',
  // SSH tunnels (#160): a regular dependency, but with optional native bindings.
  'ssh2',
]

// Nothing outside `/status/` may be framed. Below it, `src/proxy.ts` sends the frame headers: a page
// opted into embedding (#109) gets its `frame-ancestors`, everything else `'none'`.
const frameHeaders = [{ key: 'X-Frame-Options', value: 'DENY' }]

const nextConfig: NextConfig = {
  reactStrictMode: true,
  skipTrailingSlashRedirect: true,
  serverExternalPackages: monitorDriverPackages,
  images: {
    localPatterns: [{ pathname: '/api/media/file/**' }],
  },
  async headers() {
    return [
      { source: '/:path*', headers: securityHeaders },
      { source: '/((?!status/).*)', headers: frameHeaders },
    ]
  },
  async rewrites() {
    // PostHog reverse proxy (only used when analytics is enabled). Order matters: catch-all last.
    return [
      { source: '/ph/static/:path*', destination: `${posthogAssetsHost}/static/:path*` },
      { source: '/ph/array/:path*', destination: `${posthogAssetsHost}/array/:path*` },
      { source: '/ph/:path*', destination: `${posthogHost}/:path*` },
    ]
  },
  webpack: (webpackConfig) => {
    webpackConfig.resolve.extensionAlias = {
      '.cjs': ['.cts', '.cjs'],
      '.js': ['.ts', '.tsx', '.js', '.jsx'],
      '.mjs': ['.mts', '.mjs'],
    }
    return webpackConfig
  },
  turbopack: {
    root: path.resolve(dirname),
  },
}

// next-intl resolves `next-intl/config` to the request configuration in `src/i18n/request.ts`.
const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts')

export default withPayload(withNextIntl(nextConfig), { devBundleServerPackages: false })
