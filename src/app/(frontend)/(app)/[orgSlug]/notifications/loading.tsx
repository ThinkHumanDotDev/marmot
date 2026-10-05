import { ListPageSkeleton } from '@/components/page-skeletons'

export default function Loading() {
  return <ListPageSkeleton title="Notifications" label="Loading notification channels" rows={3} />
}
