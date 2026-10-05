import { Compass } from 'lucide-react'
import Link from 'next/link'

import { EmptyState } from '@/components/empty-state'
import { Button } from '@/components/ui/button'

export default function NotFound() {
  return (
    <main className="flex min-h-dvh items-center justify-center p-6">
      <EmptyState
        icon={Compass}
        title="Page not found"
        description="The page you are looking for does not exist or has moved."
        action={
          <Button asChild variant="outline">
            <Link href="/">Back home</Link>
          </Button>
        }
      />
    </main>
  )
}
