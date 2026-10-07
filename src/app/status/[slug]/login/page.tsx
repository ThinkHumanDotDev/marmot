import { LockKeyhole } from 'lucide-react'
import type { Metadata } from 'next'
import { headers } from 'next/headers'
import { notFound, redirect } from 'next/navigation'
import { getTranslations } from 'next-intl/server'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { getStatusPageLocale } from '@/i18n/server'
import { isProtectedPage } from '@/server/status-pages/access'
import { statusPageBasePath } from '@/server/status-pages/urls'

import { loadPageAccess, loadPublishedPage } from '../data'

export const dynamic = 'force-dynamic'

type PageProps = {
  params: Promise<{ slug: string }>
  searchParams: Promise<{ error?: string }>
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params
  const page = await loadPublishedPage(slug)
  const locale = await getStatusPageLocale(page)
  const t = await getTranslations({ locale, namespace: 'statusPages.access' })
  return {
    title: page ? t('metaTitle', { title: page.title }) : t('pageTitle'),
    robots: { index: false, follow: false },
  }
}

/**
 * `/status/:slug/login` (and `/login` on the page's custom domains): the password form of a
 * protected page. A plain HTML form posting to `POST /api/status-pages/:slug/access`, so it works
 * without JavaScript; the route sets the access cookie and redirects back to the page.
 */
export default async function StatusPageLogin({ params, searchParams }: PageProps) {
  const { slug } = await params
  const { error } = await searchParams
  const page = await loadPublishedPage(slug)
  if (!page) notFound()

  const base = statusPageBasePath(page, await headers())
  if (!isProtectedPage(page) || (await loadPageAccess(slug))?.allowed) redirect(base || '/')

  const locale = await getStatusPageLocale(page)
  const t = await getTranslations({ locale, namespace: 'statusPages.access' })
  const logo = page.logo && typeof page.logo === 'object' ? page.logo.url : null
  const message =
    error === 'rate-limited' ? t('rateLimited') : error === 'invalid' ? t('invalid') : null

  return (
    <main
      id="status-page-login"
      className="mx-auto flex min-h-dvh w-full max-w-sm flex-col justify-center gap-6 px-4 py-10"
    >
      <div className="flex flex-col items-center gap-3 text-center">
        {logo ? (
          // eslint-disable-next-line @next/next/no-img-element -- user upload, arbitrary size
          <img
            src={logo}
            alt=""
            className="size-14 rounded-lg object-contain"
            width={56}
            height={56}
          />
        ) : (
          <span className="flex size-11 items-center justify-center rounded-lg bg-muted text-muted-foreground">
            <LockKeyhole className="size-5" aria-hidden />
          </span>
        )}
        <h1 className="text-xl font-semibold tracking-tight">{page.title}</h1>
        <p className="text-sm text-muted-foreground">{t('description')}</p>
      </div>
      <form
        method="post"
        action={`/api/status-pages/${encodeURIComponent(page.slug)}/access`}
        className="flex flex-col gap-3"
      >
        {message && (
          <p
            role="alert"
            className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          >
            {message}
          </p>
        )}
        <label htmlFor="status-page-password" className="text-sm font-medium">
          {t('password')}
        </label>
        <Input
          id="status-page-password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          autoFocus
          aria-invalid={message ? true : undefined}
        />
        <Button type="submit" className="mt-1">
          {t('submit')}
        </Button>
      </form>
    </main>
  )
}
