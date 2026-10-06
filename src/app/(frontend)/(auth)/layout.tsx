import { redirect } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { getPayload } from 'payload'
import React from 'react'

import config from '@payload-config'
import { needsSetup } from '@/server/setup'

export const dynamic = 'force-dynamic'

/**
 * Centered card layout for sign-in, sign-up and password flows. While the instance has no user
 * yet, every auth page hands over to the first-run wizard.
 */
export default async function AuthLayout({ children }: { children: React.ReactNode }) {
  const payload = await getPayload({ config })
  if (await needsSetup(payload)) redirect('/setup')
  const t = await getTranslations('common')

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center bg-sidebar px-4 py-10 text-foreground">
      {children}
      <p className="mt-10 text-xs text-muted-foreground">{t('tagline')}</p>
    </main>
  )
}
