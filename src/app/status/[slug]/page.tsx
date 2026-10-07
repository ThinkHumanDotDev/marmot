import type { Metadata } from 'next'
import { headers } from 'next/headers'
import { notFound, redirect } from 'next/navigation'
import { getTranslations } from 'next-intl/server'

import { StatusPageView } from '@/components/status-pages/public/status-page-view'
import { getStatusPageLocale } from '@/i18n/server'
import { markdownToText } from '@/lib/markdown'
import { isProtectedPage } from '@/server/status-pages/access'
import { NOINDEX, statusPageMetadata } from '@/server/status-pages/seo'
import { statusPageBasePath, statusPageUrlForHeaders } from '@/server/status-pages/urls'

import { loadPageAccess, loadPublicData, loadPublishedPage } from './data'
import { StatusPageExtras } from './extras'

export const dynamic = 'force-dynamic'

type PageProps = { params: Promise<{ slug: string }> }

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
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

  return statusPageMetadata(page, {
    title: page.title,
    description: page.description ? markdownToText(page.description) : undefined,
    url: statusPageUrlForHeaders(page, await headers()),
  })
}

export default async function PublicStatusPage({ params }: PageProps) {
  const { slug } = await params
  const page = await loadPublishedPage(slug)
  if (!page) notFound()

  const basePath = statusPageBasePath(page, await headers())
  const restricted = isProtectedPage(page)
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
        <StatusPageView slug={config.slug} initial={data} basePath={basePath} />
      </main>
    </>
  )
}
