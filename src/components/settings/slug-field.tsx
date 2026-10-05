'use client'

import { Check, Loader2, X } from 'lucide-react'
import * as React from 'react'

import { Input } from '@/components/ui/input'
import { orgApi } from '@/lib/org-api'
import { validateOrganizationSlug } from '@/lib/reserved-slugs'

export type SlugStatus =
  | { state: 'idle' }
  | { state: 'checking' }
  | { state: 'available' }
  | { state: 'unavailable'; reason: string }
  | { state: 'current' }

/**
 * Debounced availability check against `GET /api/orgs/slug-available`. Reserved and malformed
 * slugs are rejected locally first so the server is only asked about plausible candidates.
 */
export function useSlugAvailability(slug: string, current?: string): SlugStatus {
  const value = slug.trim().toLowerCase()

  // Everything that can be decided without the server is derived synchronously.
  const local = React.useMemo<SlugStatus | null>(() => {
    if (!value) return { state: 'idle' }
    if (current && value === current) return { state: 'current' }
    const valid = validateOrganizationSlug(value)
    return valid === true ? null : { state: 'unavailable', reason: valid }
  }, [value, current])

  const [remote, setRemote] = React.useState<{ slug: string; status: SlugStatus } | null>(null)

  React.useEffect(() => {
    if (local) return
    let cancelled = false
    const timer = setTimeout(async () => {
      let status: SlugStatus = { state: 'idle' }
      try {
        const result = await orgApi.slugAvailable(value)
        status = result.available
          ? { state: 'available' }
          : { state: 'unavailable', reason: result.reason ?? 'This slug is not available.' }
      } catch {
        // Leave idle so the user can retry by editing.
      }
      if (!cancelled) setRemote({ slug: value, status })
    }, 350)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [value, local])

  if (local) return local
  return remote && remote.slug === value ? remote.status : { state: 'checking' }
}

interface SlugFieldProps extends Omit<React.ComponentProps<typeof Input>, 'value' | 'onChange'> {
  value: string
  onChange: (value: string) => void
  status: SlugStatus
}

export function SlugField({ value, onChange, status, className, ...props }: SlugFieldProps) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center overflow-hidden rounded-md border border-input shadow-xs focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50">
        <span className="shrink-0 border-r bg-muted px-3 py-2 text-sm text-muted-foreground select-none">
          {typeof window !== 'undefined' ? window.location.host : 'marmot'}/
        </span>
        <Input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          className={`rounded-none border-0 shadow-none focus-visible:ring-0 ${className ?? ''}`}
          aria-invalid={status.state === 'unavailable' || undefined}
          {...props}
        />
        <span className="flex w-9 shrink-0 items-center justify-center text-muted-foreground">
          {status.state === 'checking' && (
            <Loader2 className="size-4 animate-spin" aria-label="Checking" />
          )}
          {status.state === 'available' && (
            <Check className="size-4 text-status-up" aria-label="Available" />
          )}
          {status.state === 'unavailable' && (
            <X className="size-4 text-destructive" aria-label="Unavailable" />
          )}
        </span>
      </div>
      <p className="min-h-4 text-xs text-muted-foreground" aria-live="polite">
        {status.state === 'unavailable'
          ? status.reason
          : status.state === 'available'
            ? 'This slug is available.'
            : 'Lowercase letters, numbers and hyphens. Used in URLs.'}
      </p>
    </div>
  )
}
