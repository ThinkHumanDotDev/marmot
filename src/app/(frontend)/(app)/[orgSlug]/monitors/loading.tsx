import { useTranslations } from 'next-intl'

import { ListPageSkeleton } from '@/components/page-skeletons'

export default function Loading() {
  const t = useTranslations('monitors.list')
  return <ListPageSkeleton title={t('title')} label={t('loading')} rows={6} actions={2} />
}
