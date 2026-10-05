import { ListPageSkeleton } from '@/components/page-skeletons'

export default function Loading() {
  return <ListPageSkeleton title="Monitors" label="Loading monitors" rows={6} actions={2} />
}
