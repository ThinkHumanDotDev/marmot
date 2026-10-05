'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

import { orgNavigation, orgPath } from './navigation'

interface SidebarNavProps {
  orgSlug: string
  collapsed?: boolean
  onNavigate?: () => void
}

export function SidebarNav({ orgSlug, collapsed = false, onNavigate }: SidebarNavProps) {
  const pathname = usePathname()

  return (
    <nav aria-label="Organization" className="flex flex-col gap-0.5">
      {orgNavigation.map((item) => {
        const href = orgPath(orgSlug, item.segment)
        const active = pathname === href || pathname.startsWith(`${href}/`)
        const link = (
          <Link
            key={item.segment}
            href={href}
            onClick={onNavigate}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'group flex h-9 items-center gap-2.5 rounded-lg px-2.5 text-sm font-medium text-sidebar-foreground/80 transition-colors outline-none',
              'hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring',
              active && 'bg-sidebar-accent text-sidebar-accent-foreground shadow-xs',
              collapsed && 'justify-center px-0',
            )}
          >
            <item.icon
              className={cn(
                'size-4 shrink-0 text-muted-foreground transition-colors group-hover:text-foreground',
                active && 'text-primary',
              )}
              aria-hidden
            />
            {!collapsed && <span className="truncate">{item.label}</span>}
          </Link>
        )

        if (!collapsed) return link
        return (
          <Tooltip key={item.segment}>
            <TooltipTrigger asChild>{link}</TooltipTrigger>
            <TooltipContent side="right">{item.label}</TooltipContent>
          </Tooltip>
        )
      })}
    </nav>
  )
}
