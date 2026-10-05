'use client'

import { Building2, UserRound, Users } from 'lucide-react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'

import { cn } from '@/lib/utils'

interface SettingsTabsProps {
  orgSlug: string
}

/**
 * Link-based tab strip for the settings area. Future tabs (Permissions, API keys, Billing) slot in
 * here once their issues land.
 */
export function SettingsTabs({ orgSlug }: SettingsTabsProps) {
  const pathname = usePathname()
  const tabs = [
    { href: `/${orgSlug}/settings/account`, label: 'Account', icon: UserRound },
    { href: `/${orgSlug}/settings/organization`, label: 'Organization', icon: Building2 },
    { href: `/${orgSlug}/members`, label: 'Members', icon: Users },
  ]

  return (
    <nav aria-label="Settings sections" className="-mb-px flex gap-1 overflow-x-auto">
      {tabs.map((tab) => {
        const active = pathname === tab.href || pathname.startsWith(`${tab.href}/`)
        return (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'relative inline-flex h-10 items-center gap-2 border-b-2 px-3 text-sm font-medium whitespace-nowrap transition-colors',
              active
                ? 'border-foreground text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            <tab.icon className="size-4" aria-hidden />
            {tab.label}
          </Link>
        )
      })}
    </nav>
  )
}
