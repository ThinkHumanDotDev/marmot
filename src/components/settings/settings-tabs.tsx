'use client'

import {
  ArrowDownUp,
  Bell,
  Building2,
  Container,
  CreditCard,
  FileText,
  KeyRound,
  LockKeyhole,
  Network,
  Server,
  ShieldCheck,
  Tags,
  UserRound,
  Users,
} from 'lucide-react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useTranslations } from 'next-intl'

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
  const t = useTranslations('settings.tabs')
  const pathname = usePathname()
  const tabs = [
    { href: `/${orgSlug}/settings/account`, label: t('account'), icon: UserRound },
    { href: `/${orgSlug}/settings/organization`, label: t('organization'), icon: Building2 },
    { href: `/${orgSlug}/members`, label: t('members'), icon: Users },
    { href: `/${orgSlug}/settings/tags`, label: t('tags'), icon: Tags },
    { href: `/${orgSlug}/settings/templates`, label: t('templates'), icon: FileText },
    { href: `/${orgSlug}/settings/proxies`, label: t('proxies'), icon: Network },
    { href: `/${orgSlug}/settings/docker-hosts`, label: t('dockerHosts'), icon: Container },
    { href: `/${orgSlug}/settings/api-keys`, label: t('apiKeys'), icon: KeyRound },
    { href: `/${orgSlug}/settings/import-export`, label: t('importExport'), icon: ArrowDownUp },
    ...(showBilling
      ? [{ href: `/${orgSlug}/settings/billing`, label: t('billing'), icon: CreditCard }]
      : []),
    { href: `/${orgSlug}/settings/permissions`, label: t('permissions'), icon: ShieldCheck },
    { href: `/${orgSlug}/settings/security`, label: t('security'), icon: LockKeyhole },
    { href: `/${orgSlug}/settings/notifications`, label: t('notifications'), icon: Bell },
    ...(superadmin
      ? [{ href: `/${orgSlug}/settings/instance`, label: t('instance'), icon: Server }]
      : []),
  ]

  return (
    <nav aria-label={t('label')} className="-mb-px flex gap-1 overflow-x-auto">
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
