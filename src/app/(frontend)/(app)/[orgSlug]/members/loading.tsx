import { useTranslations } from 'next-intl'

import { ListPageSkeleton } from '@/components/page-skeletons'

export default function Loading() {
  const t = useTranslations('members.page')
  return <ListPageSkeleton title={t('title')} label={t('loading')} rows={3} />
}
