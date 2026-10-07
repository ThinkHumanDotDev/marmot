import type { Metadata } from 'next'
import { headers } from 'next/headers'
import { notFound, redirect } from 'next/navigation'
import { getTranslations } from 'next-intl/server'

import { StatusPageView } from '@/components/status-pages/public/status-page-view'
import { getStatusPageLocale } from '@/i18n/server'
import { markdownToText } from '@/lib/markdown'
import { isProtectedPage } from '@/server/status-pages/access'
import { statusPageBasePath, statusPagePath, statusPageUrl } from '@/server/status-pages/urls'

import { loadPageAccess, loadPublicData, loadPublishedPage } from './data'

export const dynamic = 'force-dynamic'

type PageProps = { params: Promise<{ slug: string }> }

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params
  const page = await loadPublishedPage(slug)
  if (!page) {
    const locale = await getStatusPageLocale(null)
    const t = await getTranslations({ locale, namespace: 'statusPages.notFound' })
    return { title: t('pageTitle'), robots: { index: false, follow: false } }
  }

  // Protected pages are never indexed; without access, only the title is revealed.
  const restricted = isProtectedPage(page)
  if (restricted && !(await loadPageAccess(slug))?.allowed) {
    return { title: page.title, robots: { index: false, follow: false } }
  }

  const description = page.description ? markdownToText(page.description) : undefined
  const logo = page.logo && typeof page.logo === 'object' ? page.logo.url : null
  const favicon = page.favicon && typeof page.favicon === 'object' ? page.favicon : null
  // Favicon first, then the logo. Media URLs point at Marmot's own host, so they load on custom domains too.
  const icon = favicon?.url
    ? { url: favicon.url, ...(favicon.mimeType ? { type: favicon.mimeType } : {}) }
    : logo
      ? { url: logo }
      : null
  const url = statusPageUrl(page.slug)

  return {
    title: page.title,
    description,
    applicationName: page.title,
    robots:
      page.searchEngineIndex && !restricted
        ? { index: true, follow: true }
        : { index: false, follow: false },
    // Protected pages link the manifest themselves, with credentials (see the page below).
    ...(restricted ? {} : { manifest: `${statusPagePath(page.slug)}/manifest.json` }),
    alternates: {
      canonical: url,
      types: { 'application/rss+xml': `${statusPagePath(page.slug)}/rss` },
    },
    openGraph: {
      type: 'website',
      title: page.title,
      description,
      url,
      siteName: page.title,
      ...(logo ? { images: [{ url: logo }] } : {}),
    },
    twitter: { card: logo ? 'summary' : 'summary_large_image', title: page.title, description },
    ...(icon ? { icons: { icon: [icon] } } : {}),
  }
}

export default async function PublicStatusPage({ params }: PageProps) {
  const { slug } = await params
  const page = await loadPublishedPage(slug)
  if (!page) notFound()

  const restricted = isProtectedPage(page)
  if (restricted && !(await loadPageAccess(slug))?.allowed) {
    redirect(`${statusPageBasePath(page, await headers())}/login`)
  }

  const data = await loadPublicData(slug)
  if (!data) notFound()

  const { config } = data
  const gaId = config.googleAnalyticsId?.trim()
  const locale = await getStatusPageLocale(config)
  const t = await getTranslations({ locale, namespace: 'statusPages.overall' })

  return (
    <>
      {restricted && (
        // Browsers fetch manifests without cookies unless asked to; the manifest needs the cookie.
        <link
          rel="manifest"
          href={`${statusPagePath(config.slug)}/manifest.json`}
          crossOrigin="use-credentials"
        />
      )}
      {config.customCSS && (
        // Operators own their status page; custom CSS is a documented feature (as in Uptime Kuma).
        <style data-custom-css dangerouslySetInnerHTML={{ __html: config.customCSS }} />
      )}
      {gaId && /^[A-Z0-9-]+$/i.test(gaId) && (
        <>
          <script async src={`https://www.googletagmanager.com/gtag/js?id=${gaId}`} />
          <script
            dangerouslySetInnerHTML={{
              __html: `window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments)}gtag('js',new Date());gtag('config','${gaId}');`,
            }}
          />
        </>
      )}
      <main
        id="status-page"
        data-slug={config.slug}
        aria-label={`${config.title}: ${t(data.overall)}`}
      >
        <StatusPageView slug={config.slug} initial={data} />
      </main>
    </>
  )
}
