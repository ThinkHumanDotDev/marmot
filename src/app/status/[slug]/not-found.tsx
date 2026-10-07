import { Compass } from 'lucide-react'
import { getTranslations } from 'next-intl/server'

import { getStatusPageLocale } from '@/i18n/server'

export default async function StatusPageNotFound() {
  // No page to take the language from: follow the visitor (cookie, then Accept-Language).
  const locale = await getStatusPageLocale(null)
  const t = await getTranslations({ locale, namespace: 'statusPages.notFound' })
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col items-center justify-center gap-3 px-6 text-center">
      <span className="flex size-11 items-center justify-center rounded-lg bg-muted text-muted-foreground">
        <Compass className="size-5" aria-hidden />
      </span>
      <h1 className="text-base font-semibold">{t('title')}</h1>
      <p className="text-sm text-muted-foreground">{t('description')}</p>
    </main>
  )
}
