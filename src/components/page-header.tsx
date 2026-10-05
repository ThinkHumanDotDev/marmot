import * as React from 'react'

import { cn } from '@/lib/utils'

interface PageHeaderProps extends Omit<React.ComponentProps<'header'>, 'title'> {
  title: React.ReactNode
  description?: React.ReactNode
  /** Right-aligned actions (buttons, filters). */
  actions?: React.ReactNode
  /** Breadcrumb or eyebrow rendered above the title. */
  eyebrow?: React.ReactNode
}

export function PageHeader({
  title,
  description,
  actions,
  eyebrow,
  className,
  ...props
}: PageHeaderProps) {
  return (
    <header
      data-slot="page-header"
      className={cn(
        'flex flex-col gap-4 border-b px-4 py-5 sm:px-6 md:flex-row md:items-end md:justify-between md:px-8',
        className,
      )}
      {...props}
    >
      <div className="min-w-0 space-y-1">
        {eyebrow && <div className="text-xs font-medium text-muted-foreground">{eyebrow}</div>}
        <h1 className="truncate text-xl font-semibold tracking-tight md:text-2xl">{title}</h1>
        {description && <p className="max-w-2xl text-sm text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2 md:shrink-0">{actions}</div>}
    </header>
  )
}
