import { ListPageSkeleton } from '@/components/page-skeletons'

export default function Loading() {
  return <ListPageSkeleton title="Members" label="Loading members" rows={3} />
}
