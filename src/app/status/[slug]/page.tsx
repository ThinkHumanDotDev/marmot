import type { Metadata } from 'next'
import { headers } from 'next/headers'
import { notFound, redirect } from 'next/navigation'
import { getTranslations } from 'next-intl/server'

import { StatusPageEmbed } from '@/components/status-pages/public/status-page-embed'
import { StatusPageView } from '@/components/status-pages/public/status-page-view'
import { getStatusPageLocale } from '@/i18n/server'
import { markdownToText } from '@/lib/markdown'
import { EMBED_PARAM, parseEmbedSections } from '@/lib/status-page-embed'
import { isProtectedPage } from '@/server/status-pages/access'
import { NOINDEX, statusPageMetadata } from '@/server/status-pages/seo'
import { statusPageBasePath, statusPageUrlForHeaders } from '@/server/status-pages/urls'

import { loadPageAccess, loadPublicData, loadPublishedPage } from './data'
import { StatusPageExtras } from './extras'

export const dynamic = 'force-dynamic'

type PageProps = {
  params: Promise<{ slug: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

export async function generateMetadata({ params, searchParams }: PageProps): Promise<Metadata> {
  const { slug } = await params
  const page = await loadPublishedPage(slug)
  if (!page) {
    const locale = await getStatusPageLocale(null)
    const t = await getTranslations({ locale, namespace: 'statusPages.notFound' })
    return { title: t('pageTitle'), robots: NOINDEX }
  }

  // Protected pages are never indexed; without access, only the title is revealed.
  if (isProtectedPage(page) && !(await loadPageAccess(slug))?.allowed) {
    return { title: page.title, robots: NOINDEX }
  }

  const metadata = statusPageMetadata(page, {
    title: page.title,
    description: page.description ? markdownToText(page.description) : undefined,
    url: statusPageUrlForHeaders(page, await headers()),
  })
  // The embed mode repeats the page's content; only the page itself is indexed.
  const embedded = parseEmbedSections((await searchParams)[EMBED_PARAM]) !== null
  return embedded ? { ...metadata, robots: NOINDEX } : metadata
}

export default async function PublicStatusPage({ params, searchParams }: PageProps) {
  const { slug } = await params
  const page = await loadPublishedPage(slug)
  if (!page) notFound()

  const embed = parseEmbedSections((await searchParams)[EMBED_PARAM])
  const basePath = statusPageBasePath(page, await headers())
  const restricted = isProtectedPage(page)
  // Only public pages have an embed mode (#109): a protected page is never rendered for a frame,
  // so no access cookie is ever used inside one.
  if (embed && restricted) notFound()
  if (restricted && !(await loadPageAccess(slug))?.allowed) {
    redirect(`${basePath}/login`)
  }

  const data = await loadPublicData(slug)
  if (!data) notFound()

  const { config } = data
  const locale = await getStatusPageLocale(config)
  const t = await getTranslations({ locale, namespace: 'statusPages.overall' })

  return (
    <>
      <StatusPageExtras config={config} restricted={restricted} />
      <main
        id="status-page"
        data-slug={config.slug}
        aria-label={`${config.title}: ${t(data.overall)}`}
      >
        {embed ? (
          <StatusPageEmbed slug={config.slug} initial={data} basePath={basePath} sections={embed} />
        ) : (
          <StatusPageView slug={config.slug} initial={data} basePath={basePath} />
        )}
      </main>
    </>
  )
}
