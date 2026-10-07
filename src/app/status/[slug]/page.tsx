import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { getTranslations } from 'next-intl/server'

import { StatusPageView } from '@/components/status-pages/public/status-page-view'
import { getStatusPageLocale } from '@/i18n/server'
import { markdownToText } from '@/lib/markdown'
import { statusPagePath, statusPageUrl } from '@/server/status-pages/urls'

import { loadPublicData, loadPublishedPage } from './data'

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
    robots: page.searchEngineIndex
      ? { index: true, follow: true }
      : { index: false, follow: false },
    manifest: `${statusPagePath(page.slug)}/manifest.json`,
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
  const data = await loadPublicData(slug)
  if (!data) notFound()

  const { config } = data
  const gaId = config.googleAnalyticsId?.trim()
  const locale = await getStatusPageLocale(config)
  const t = await getTranslations({ locale, namespace: 'statusPages.overall' })

  return (
    <>
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
