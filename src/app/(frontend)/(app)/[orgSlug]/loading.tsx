import { useTranslations } from 'next-intl'

import { ListPageSkeleton } from '@/components/page-skeletons'

export default function Loading() {
  const t = useTranslations('common.loading')
  return <ListPageSkeleton label={t('default')} />
}
