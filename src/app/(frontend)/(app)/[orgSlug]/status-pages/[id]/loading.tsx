import { useTranslations } from 'next-intl'

import { FormPageSkeleton } from '@/components/page-skeletons'

export default function Loading() {
  const t = useTranslations('statusPages.editorPage')
  return <FormPageSkeleton label={t('loading')} />
}
