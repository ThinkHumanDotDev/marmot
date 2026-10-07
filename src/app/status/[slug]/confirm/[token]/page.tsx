import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { getTranslations } from 'next-intl/server'

import { Button } from '@/components/ui/button'
import { getStatusPageLocale } from '@/i18n/server'
import { statusPagePath } from '@/server/status-pages/urls'

import { loadPublishedPage } from '../../data'
import { SubscriptionShell } from '../../subscription-shell'
import { loadLinkSubscription } from '../../subscription-data'

export const dynamic = 'force-dynamic'

type PageProps = { params: Promise<{ slug: string; token: string }> }

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params
  const page = await loadPublishedPage(slug)
  const t = await getTranslations({
    locale: await getStatusPageLocale(page),
    namespace: 'statusPages.subscription',
  })
  return {
    title: t('metaTitle', { title: page?.title ?? '' }),
    robots: { index: false, follow: false },
  }
}

/**
 * `/status/:slug/confirm/:token`: the double opt-in link of the confirmation email. Confirming is a
 * button (a form POST), so mail scanners that prefetch links never confirm on the visitor's behalf.
 */
export default async function ConfirmSubscriptionPage({ params }: PageProps) {
  const { slug, token } = await params
  const page = await loadPublishedPage(slug)
  if (!page) notFound()
  const t = await getTranslations({
    locale: await getStatusPageLocale(page),
    namespace: 'statusPages.subscription',
  })
  const ctx = await loadLinkSubscription(slug, token)
  const logo = page.logo && typeof page.logo === 'object' ? (page.logo.url ?? null) : null
  const back = {
    backHref: statusPagePath(page.slug),
    backLabel: t('backToPage', { title: page.title }),
  }

  return (
    <SubscriptionShell logo={logo} title={page.title} {...back}>
      {!ctx ? (
        <p role="alert" className="text-sm">
          {t('notFound')}
        </p>
      ) : (
        <form
          method="post"
          action={`/api/status-pages/${encodeURIComponent(page.slug)}/subscriptions/${encodeURIComponent(token)}/confirm`}
          className="flex flex-col gap-4"
        >
          <h2 className="text-base font-medium">{t('confirmTitle')}</h2>
          <p className="text-sm text-muted-foreground">
            {t('confirmDescription', { title: page.title, target: ctx.subscriber.target })}
          </p>
          <Button type="submit">{t('confirm')}</Button>
        </form>
      )}
    </SubscriptionShell>
  )
}
