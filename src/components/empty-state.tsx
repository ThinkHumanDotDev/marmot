import type { LucideIcon } from 'lucide-react'
import * as React from 'react'

import { cn } from '@/lib/utils'

interface EmptyStateProps extends Omit<React.ComponentProps<'div'>, 'title'> {
  icon?: LucideIcon
  title: React.ReactNode
  description?: React.ReactNode
  /** Primary call to action (usually a Button). */
  action?: React.ReactNode
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
  ...props
}: EmptyStateProps) {
  return (
    <div
      data-slot="empty-state"
      className={cn(
        'mx-auto flex w-full max-w-md flex-col items-center justify-center gap-3 rounded-xl border border-dashed px-6 py-14 text-center',
        className,
      )}
      {...props}
    >
      {Icon && (
        <span className="flex size-11 items-center justify-center rounded-lg bg-muted text-muted-foreground">
          <Icon className="size-5" aria-hidden />
        </span>
      )}
      <h2 className="text-base font-semibold">{title}</h2>
      {description && <p className="text-sm text-muted-foreground">{description}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  )
}
