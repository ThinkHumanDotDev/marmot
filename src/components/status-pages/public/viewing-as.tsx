import { LogOut, UserRound } from 'lucide-react'
import { getFormatter, getTranslations } from 'next-intl/server'

import { Button } from '@/components/ui/button'
import type { Locale } from '@/i18n/locales'

/**
 * "Viewing as" bar (#278) of a page a visitor signed in to with an email link (`email-domain` and
 * `audience` modes): who they are signed in as, on audience pages the audiences they see the page
 * as, and a sign-out button. A plain form, so it works without JavaScript.
 */
export async function ViewingAs({
  slug,
  locale,
  email,
  audiences,
}: {
  slug: string
  locale: Locale
  email: string
  /** Audience names; `null` on `email-domain` pages. */
  audiences: readonly string[] | null
}) {
  const t = await getTranslations({ locale, namespace: 'statusPages.access.session' })
  const format = await getFormatter({ locale })
  const action = `/api/status-pages/${encodeURIComponent(slug)}/access?locale=${locale}`
  return (
    <div className="mx-auto w-full max-w-3xl px-4 pt-6 sm:px-6" data-viewing-as>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-xl border bg-muted/40 px-4 py-2.5 text-sm">
        <p className="flex min-w-0 items-center gap-2 text-muted-foreground">
          <UserRound className="size-4 shrink-0" aria-hidden />
          <span className="min-w-0">
            {t('signedInAs')} <span className="font-medium break-all text-foreground">{email}</span>
            {audiences && audiences.length > 0 && (
              <>
                {' · '}
                {t('viewingAs')}{' '}
                <span className="font-medium text-foreground" data-viewing-as-audiences>
                  {format.list(audiences, { type: 'conjunction' })}
                </span>
              </>
            )}
          </span>
        </p>
        <form method="post" action={action}>
          <input type="hidden" name="signout" value="1" />
          <Button type="submit" variant="ghost" size="sm" className="h-7 px-2">
            <LogOut aria-hidden /> {t('signOut')}
          </Button>
        </form>
      </div>
    </div>
  )
}
