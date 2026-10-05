import type { Metadata } from 'next'
import { notFound } from 'next/navigation'

import { StatusPageView } from '@/components/status-pages/public/status-page-view'
import { markdownToText } from '@/lib/markdown'
import { STATUS_DESCRIPTIONS } from '@/server/status-pages/public'
import { statusPagePath, statusPageUrl } from '@/server/status-pages/urls'

import { loadPublicData, loadPublishedPage } from './data'

export const dynamic = 'force-dynamic'

type PageProps = { params: Promise<{ slug: string }> }

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params
  const page = await loadPublishedPage(slug)
  if (!page) return { title: 'Status page not found', robots: { index: false, follow: false } }

  const description = page.description ? markdownToText(page.description) : undefined
  const logo = page.logo && typeof page.logo === 'object' ? page.logo.url : null
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
    ...(logo ? { icons: { icon: logo } } : {}),
  }
}

export default async function PublicStatusPage({ params }: PageProps) {
  const { slug } = await params
  const data = await loadPublicData(slug)
  if (!data) notFound()

  const { config } = data
  const gaId = config.googleAnalyticsId?.trim()

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
        aria-label={`${config.title}: ${STATUS_DESCRIPTIONS[data.overall]}`}
      >
        <StatusPageView slug={config.slug} initial={data} />
      </main>
    </>
  )
}
