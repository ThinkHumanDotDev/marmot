import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { getTranslations } from 'next-intl/server'

import { ManageSubscription } from '@/components/status-pages/public/manage-subscription'
import { getStatusPageLocale } from '@/i18n/server'
import { statusPagePath } from '@/server/status-pages/urls'

import { loadPublishedPage } from '../../data'
import { SubscriptionShell } from '../../subscription-shell'
import { loadLinkSubscription, subscriptionPickerGroups } from '../../subscription-data'

export const dynamic = 'force-dynamic'

type PageProps = {
  params: Promise<{ slug: string; token: string }>
  searchParams: Promise<{ confirmed?: string }>
}

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
 * `/status/:slug/manage/:token`: the subscription behind a signed link. Works on password-protected
 * pages without the page cookie: the token is the credential and only the subscription is shown.
 */
export default async function ManageSubscriptionPage({ params, searchParams }: PageProps) {
  const { slug, token } = await params
  const { confirmed } = await searchParams
  const page = await loadPublishedPage(slug)
  if (!page) notFound()
  const t = await getTranslations({
    locale: await getStatusPageLocale(page),
    namespace: 'statusPages.subscription',
  })
  const tc = await getTranslations({
    locale: await getStatusPageLocale(page),
    namespace: 'statusPages.subscribe.channels',
  })
  const ctx = await loadLinkSubscription(slug, token)
  const logo = page.logo && typeof page.logo === 'object' ? (page.logo.url ?? null) : null
  const back = {
    backHref: statusPagePath(page.slug),
    backLabel: t('backToPage', { title: page.title }),
  }

  if (!ctx) {
    return (
      <SubscriptionShell logo={logo} title={page.title} {...back}>
        <p role="alert" className="text-sm">
          {t('notFound')}
        </p>
      </SubscriptionShell>
    )
  }
  const { subscriber } = ctx
  return (
    <SubscriptionShell logo={logo} title={page.title} {...back}>
      {confirmed && (
        <p role="status" className="rounded-md bg-status-up/10 px-3 py-2 text-sm">
          {t('confirmed')}
        </p>
      )}
      <h2 className="text-base font-medium">{t('manageTitle')}</h2>
      <p className="text-sm text-muted-foreground">
        {t('manageDescription', {
          title: page.title,
          target: subscriber.target,
          channel: tc(subscriber.channel),
        })}
      </p>
      {!subscriber.confirmedAt && <p className="text-sm">{t('pending')}</p>}
      <ManageSubscription
        slug={page.slug}
        token={token}
        groups={await subscriptionPickerGroups(ctx.page)}
        initial={subscriber.components ?? []}
      />
      <a
        href={`${statusPagePath(page.slug)}/unsubscribe/${encodeURIComponent(token)}`}
        className="text-sm text-destructive underline-offset-4 hover:underline"
      >
        {t('unsubscribe')}
      </a>
    </SubscriptionShell>
  )
}
