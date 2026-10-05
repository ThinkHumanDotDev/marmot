'use client'

import {
  ArrowDownUp,
  Bell,
  Building2,
  CreditCard,
  KeyRound,
  Server,
  ShieldCheck,
  UserRound,
  Users,
} from 'lucide-react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'

import { cn } from '@/lib/utils'

interface SettingsTabsProps {
  orgSlug: string
  /** Billing tab: only when `BILLING_ENABLED` and the viewer is an admin or owner. */
  showBilling?: boolean
  /** Shows the instance tab (superadmins only). */
  superadmin?: boolean
}

/**
 * Link-based tab strip for the settings area. New tabs slot in here once their
 * issues land.
 */
export function SettingsTabs({
  orgSlug,
  showBilling = false,
  superadmin = false,
}: SettingsTabsProps) {
  const pathname = usePathname()
  const tabs = [
    { href: `/${orgSlug}/settings/account`, label: 'Account', icon: UserRound },
    { href: `/${orgSlug}/settings/organization`, label: 'Organization', icon: Building2 },
    { href: `/${orgSlug}/members`, label: 'Members', icon: Users },
    { href: `/${orgSlug}/settings/api-keys`, label: 'API keys', icon: KeyRound },
    { href: `/${orgSlug}/settings/import-export`, label: 'Import / Export', icon: ArrowDownUp },
    ...(showBilling
      ? [{ href: `/${orgSlug}/settings/billing`, label: 'Billing', icon: CreditCard }]
      : []),
    { href: `/${orgSlug}/settings/permissions`, label: 'Permissions', icon: ShieldCheck },
    { href: `/${orgSlug}/settings/notifications`, label: 'Notifications', icon: Bell },
    ...(superadmin
      ? [{ href: `/${orgSlug}/settings/instance`, label: 'Instance', icon: Server }]
      : []),
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
