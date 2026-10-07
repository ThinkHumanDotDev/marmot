import { LockKeyhole, MailCheck, ShieldOff } from 'lucide-react'
import type { Metadata } from 'next'
import { headers } from 'next/headers'
import { notFound, redirect } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import type * as React from 'react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { getStatusPageLocale } from '@/i18n/server'
import { isEventsReturnPath } from '@/lib/status-page-events'
import { STATUS_PAGE_MAGIC_LINK_TTL_MINUTES } from '@/lib/status-page-access'
import { isProtectedPage } from '@/server/status-pages/access'
import { MAGIC_LINK_TOKEN_PARAM } from '@/server/status-pages/magic-link'
import { statusPageBasePath } from '@/server/status-pages/urls'

import { loadPageAccess, loadPublishedPage } from '../data'

export const dynamic = 'force-dynamic'

type PageProps = {
  params: Promise<{ slug: string }>
  searchParams: Promise<{ error?: string; sent?: string; token?: string; next?: string }>
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params
  const page = await loadPublishedPage(slug)
  const locale = await getStatusPageLocale(page)
  const t = await getTranslations({ locale, namespace: 'statusPages.access' })
  return {
    title: page ? t('metaTitle', { title: page.title }) : t('pageTitle'),
    robots: { index: false, follow: false },
    // The sign-in token in the URL must not leak to other origins through `Referer`. Not
    // `no-referrer`: browsers then send `Origin: null` with the form post, which the access route
    // refuses as cross-site.
    referrer: 'same-origin',
  }
}

function Alert({ children }: { children: React.ReactNode }) {
  return (
    <p
      role="alert"
      className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
    >
      {children}
    </p>
  )
}

/**
 * `/status/:slug/login` (and `/login` on the page's custom domains): the sign-in screen of a
 * protected page. Plain HTML forms posting to `POST /api/status-pages/:slug/access`, so it works
 * without JavaScript; the route sets the access cookie and redirects back to the page.
 *
 * - `password`: the password form.
 * - `email-domain`: the address form, then "check your inbox" (`?sent=1`); the emailed link opens
 *   this page with `?token=…`, which asks for one click to redeem it (mail scanners that prefetch
 *   links cannot use it up).
 * - `ip-allowlist`: a static "restricted" notice; there is nothing to sign in with.
 */
export default async function StatusPageLogin({ params, searchParams }: PageProps) {
  const { slug } = await params
  const query = await searchParams
  const page = await loadPublishedPage(slug)
  if (!page) notFound()

  const base = statusPageBasePath(page, await headers())
  // Where to go after signing in: the history or a permalink (#107), else the page itself.
  const next = isEventsReturnPath(query.next) ? query.next : null
  if (!isProtectedPage(page) || (await loadPageAccess(slug))?.allowed) {
    redirect(next ? `${base}${next}` : base || '/')
  }
  const nextField = next ? <input type="hidden" name="next" value={next} /> : null

  const locale = await getStatusPageLocale(page)
  const t = await getTranslations({ locale, namespace: 'statusPages.access' })
  const logo = page.logo && typeof page.logo === 'object' ? page.logo.url : null
  const action = `/api/status-pages/${encodeURIComponent(page.slug)}/access`
  const mode = page.access ?? 'public'

  let description: string
  let content: React.ReactNode = null
  let Icon = LockKeyhole

  if (mode === 'ip-allowlist') {
    Icon = ShieldOff
    description = t('ipAllowlist.description')
  } else if (mode === 'email-domain') {
    const token =
      typeof query.token === 'string' && query.token.length <= 128 ? query.token : undefined
    const message =
      query.error === 'rate-limited'
        ? t('rateLimited')
        : query.error === 'invalid-email'
          ? t('emailDomain.invalidEmail')
          : query.error === 'link-invalid'
            ? t('emailDomain.linkInvalid')
            : null

    if (token) {
      description = t('emailDomain.confirmDescription')
      content = (
        <form method="post" action={action} className="flex flex-col gap-3">
          <input type="hidden" name={MAGIC_LINK_TOKEN_PARAM} value={token} />
          {nextField}
          <Button type="submit" className="mt-1" autoFocus>
            {t('emailDomain.confirm')}
          </Button>
        </form>
      )
    } else if (query.sent) {
      Icon = MailCheck
      description = t('emailDomain.sent', { minutes: STATUS_PAGE_MAGIC_LINK_TTL_MINUTES })
      content = (
        <a href={`${base}/login`} className="text-center text-sm underline underline-offset-4">
          {t('emailDomain.useAnother')}
        </a>
      )
    } else {
      description = t('emailDomain.description')
      content = (
        <form method="post" action={action} className="flex flex-col gap-3">
          {message && <Alert>{message}</Alert>}
          <label htmlFor="status-page-email" className="text-sm font-medium">
            {t('emailDomain.email')}
          </label>
          <Input
            id="status-page-email"
            name="email"
            type="email"
            autoComplete="email"
            inputMode="email"
            maxLength={254}
            required
            autoFocus
            aria-invalid={message ? true : undefined}
          />
          <Button type="submit" className="mt-1">
            {t('emailDomain.submit')}
          </Button>
        </form>
      )
    }
  } else {
    const message =
      query.error === 'rate-limited'
        ? t('rateLimited')
        : query.error === 'invalid'
          ? t('invalid')
          : null
    description = t('description')
    content = (
      <form method="post" action={action} className="flex flex-col gap-3">
        {nextField}
        {message && <Alert>{message}</Alert>}
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
    )
  }

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
            <Icon className="size-5" aria-hidden />
          </span>
        )}
        <h1 className="text-xl font-semibold tracking-tight">{page.title}</h1>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
      {content}
    </main>
  )
}
