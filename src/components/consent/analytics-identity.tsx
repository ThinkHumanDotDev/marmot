'use client'

import * as React from 'react'

import { identify } from '@/lib/analytics'

interface AnalyticsIdentityProps {
  /** `hashAnalyticsId(user.id)` computed on the server; never a raw id, email or name. */
  hashedUserId: string
  plan?: string
}

/** Links the browser session to the signed-in user's hashed id (a no-op without consent). */
export function AnalyticsIdentity({ hashedUserId, plan }: AnalyticsIdentityProps) {
  React.useEffect(() => {
    identify(hashedUserId, plan ? { plan } : undefined)
  }, [hashedUserId, plan])
  return null
}
