import { Compass } from 'lucide-react'
import Link from 'next/link'
import { getTranslations } from 'next-intl/server'

import { EmptyState } from '@/components/empty-state'
import { Button } from '@/components/ui/button'

export default async function NotFound() {
  const t = await getTranslations('common.notFound')
  return (
    <main className="flex min-h-dvh items-center justify-center p-6">
      <EmptyState
        icon={Compass}
        title={t('title')}
        description={t('description')}
        action={
          <Button asChild variant="outline">
            <Link href="/">{t('backHome')}</Link>
          </Button>
        }
      />
    </main>
  )
}
