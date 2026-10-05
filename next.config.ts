import { withPayload } from '@payloadcms/next/withPayload'
import type { NextConfig } from 'next'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const dirname = path.dirname(__filename)

const posthogHost = process.env.NEXT_PUBLIC_POSTHOG_HOST || 'https://us.i.posthog.com'
const posthogAssetsHost = posthogHost.replace('.i.posthog.com', '-assets.i.posthog.com')

// Security headers applied to every response. CSP is deliberately not set yet (the Payload admin and
// status pages with custom CSS need an allowlist first). HSTS only in production, where TLS terminates
// at Caddy or the operator's proxy; enabling it over plain-HTTP dev would poison browsers for localhost.
const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
  ...(process.env.NODE_ENV === 'production'
    ? [{ key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' }]
    : []),
]

const nextConfig: NextConfig = {
  reactStrictMode: true,
  skipTrailingSlashRedirect: true,
  images: {
    localPatterns: [{ pathname: '/api/media/file/**' }],
  },
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }]
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

export default withPayload(nextConfig, { devBundleServerPackages: false })
