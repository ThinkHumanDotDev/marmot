import type * as React from 'react'

import type { MonitorTagChip } from '@/lib/monitor-resources'
import { cn } from '@/lib/utils'

/** Coloured tag chip (`name` or `name: value`), shared by the monitor list, detail and form. */
export function TagChip({
  tag,
  className,
  children,
}: {
  tag: MonitorTagChip
  className?: string
  children?: React.ReactNode
}) {
  return (
    <span
      className={cn(
        'inline-flex max-w-full items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] leading-none font-medium',
        !tag.color && 'text-muted-foreground',
        className,
      )}
      style={
        tag.color
          ? { borderColor: tag.color, color: tag.color, backgroundColor: `${tag.color}14` }
          : undefined
      }
      data-testid="tag-chip"
    >
      <span className="truncate">
        {tag.name}
        {tag.value ? `: ${tag.value}` : ''}
      </span>
      {children}
    </span>
  )
}

/** A row of chips; renders nothing without tags. */
export function TagList({ tags, className }: { tags?: MonitorTagChip[]; className?: string }) {
  if (!tags || tags.length === 0) return null
  return (
    <span className={cn('flex flex-wrap items-center gap-1', className)}>
      {tags.map((tag, i) => (
        <TagChip key={`${tag.id ?? tag.name}-${i}`} tag={tag} />
      ))}
    </span>
  )
}
