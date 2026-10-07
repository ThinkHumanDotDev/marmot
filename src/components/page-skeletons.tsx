import { useTranslations } from 'next-intl'
import * as React from 'react'

import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'

/**
 * Route-level loading placeholders (`loading.tsx`). They mirror the real page layout (header,
 * padded section, list rows) so the shell does not jump when data arrives, and announce
 * themselves once to assistive technology.
 */

function LoadingRegion({
  label,
  children,
  className,
}: {
  label: string
  children: React.ReactNode
  className?: string
}) {
  return (
    <div role="status" aria-live="polite" aria-busy="true" className={className}>
      <span className="sr-only">{label}</span>
      <div aria-hidden>{children}</div>
    </div>
  )
}

export function PageHeaderSkeleton({
  title,
  actions = 1,
  eyebrow = false,
}: {
  /** Real title when it is static, so the heading does not flicker. */
  title?: string
  actions?: number
  eyebrow?: boolean
}) {
  return (
    <div className="flex flex-col gap-4 border-b px-4 py-5 sm:px-6 md:flex-row md:items-end md:justify-between md:px-8">
      <div className="min-w-0 space-y-2">
        {eyebrow && <Skeleton className="h-3 w-24" />}
        {title ? (
          <div className="text-xl font-semibold tracking-tight md:text-2xl">{title}</div>
        ) : (
          <Skeleton className="h-7 w-48" />
        )}
        <Skeleton className="h-4 w-64 max-w-full" />
      </div>
      {actions > 0 && (
        <div className="flex items-center gap-2">
          {Array.from({ length: actions }, (_, i) => (
            <Skeleton key={i} className="h-9 w-28" />
          ))}
        </div>
      )}
    </div>
  )
}

export function ListSkeleton({ rows = 5, className }: { rows?: number; className?: string }) {
  return (
    <div className={cn('overflow-hidden rounded-xl border bg-card', className)}>
      <div className="divide-y">
        {Array.from({ length: rows }, (_, i) => (
          <div key={i} className="flex items-center gap-3 px-4 py-3">
            <Skeleton className="size-2.5 rounded-full" />
            <div className="min-w-0 flex-1 space-y-1.5">
              <Skeleton className="h-4 w-40 max-w-[60%]" />
              <Skeleton className="h-3 w-56 max-w-[80%]" />
            </div>
            <Skeleton className="hidden h-6 w-48 md:block" />
            <Skeleton className="hidden h-4 w-12 md:block" />
          </div>
        ))}
      </div>
    </div>
  )
}

export function ListPageSkeleton({
  title,
  label,
  rows,
  actions,
}: {
  title?: string
  label: string
  rows?: number
  actions?: number
}) {
  return (
    <LoadingRegion label={label}>
      <PageHeaderSkeleton title={title} actions={actions} />
      <section className="p-4 sm:p-6 md:p-8">
        <ListSkeleton rows={rows} />
      </section>
    </LoadingRegion>
  )
}

export function MonitorDetailSkeleton() {
  const t = useTranslations('common.loading')
  return (
    <LoadingRegion label={t('monitor')}>
      <PageHeaderSkeleton eyebrow actions={3} />
      <section className="flex flex-col gap-6 p-4 sm:p-6 md:p-8">
        <Skeleton className="h-20 w-full rounded-xl" />
        <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
          {Array.from({ length: 5 }, (_, i) => (
            <Skeleton key={i} className="h-24 rounded-xl" />
          ))}
        </div>
        <Skeleton className="h-64 w-full rounded-xl" />
        <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
          <Skeleton className="h-56 rounded-xl" />
          <Skeleton className="h-56 rounded-xl" />
        </div>
      </section>
    </LoadingRegion>
  )
}

export function FormPageSkeleton({ title, label }: { title?: string; label: string }) {
  return (
    <LoadingRegion label={label}>
      <PageHeaderSkeleton title={title} actions={0} eyebrow />
      <section className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-4 sm:p-6 md:p-8">
        {Array.from({ length: 3 }, (_, i) => (
          <div key={i} className="space-y-4 rounded-xl border p-6">
            <Skeleton className="h-5 w-40" />
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-full" />
          </div>
        ))}
      </section>
    </LoadingRegion>
  )
}

export function SettingsSkeleton() {
  const t = useTranslations('common.loading')
  return (
    <LoadingRegion label={t('settings')} className="flex flex-col gap-8">
      {Array.from({ length: 2 }, (_, i) => (
        <div key={i} className="space-y-4 rounded-xl border p-6">
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-4 w-72 max-w-full" />
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-full" />
        </div>
      ))}
    </LoadingRegion>
  )
}
