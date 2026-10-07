'use client'

import { Check, ChevronsUpDown, Plus } from 'lucide-react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { isRole } from '@/access/permissions'
import type { OrgMembership } from '@/lib/auth'
import { cn, initials } from '@/lib/utils'

interface OrgSwitcherProps {
  organizations: OrgMembership[]
  currentOrg: OrgMembership
  collapsed?: boolean
}

function OrgBadge({ name, className }: { name: string; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        'flex size-7 shrink-0 items-center justify-center rounded-md bg-foreground text-[11px] font-semibold text-background',
        className,
      )}
    >
      {initials(name)}
    </span>
  )
}

export function OrgSwitcher({ organizations, currentOrg, collapsed = false }: OrgSwitcherProps) {
  const t = useTranslations('shell.orgSwitcher')
  const router = useRouter()
  const role = currentOrg.role
  const roleLabel =
    role && (isRole(role) || role === 'superadmin') ? t(`role.${role}`) : (role ?? null)

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={t('trigger', { name: currentOrg.name })}
        className={cn(
          'flex h-10 w-full items-center gap-2.5 rounded-lg px-2 text-left text-sm outline-none transition-colors',
          'hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-sidebar-ring data-[state=open]:bg-sidebar-accent',
          collapsed && 'justify-center px-0',
        )}
      >
        <OrgBadge name={currentOrg.name} />
        {!collapsed && (
          <>
            <span className="min-w-0 flex-1">
              <span className="block truncate font-semibold">{currentOrg.name}</span>
              {roleLabel && (
                <span className="block truncate text-xs text-muted-foreground capitalize">
                  {roleLabel}
                </span>
              )}
            </span>
            <ChevronsUpDown className="size-4 text-muted-foreground" aria-hidden />
          </>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="bottom" className="w-60">
        <DropdownMenuLabel className="text-xs text-muted-foreground">
          {t('organizations')}
        </DropdownMenuLabel>
        <DropdownMenuGroup>
          {organizations.map((org) => {
            const selected = org.slug === currentOrg.slug
            return (
              <DropdownMenuItem
                key={String(org.id)}
                onSelect={() => router.push(`/${org.slug}`)}
                className="gap-2.5"
              >
                <OrgBadge name={org.name} className="size-6 text-[10px]" />
                <span className="min-w-0 flex-1 truncate">{org.name}</span>
                {selected && <Check className="size-4 text-primary" aria-hidden />}
              </DropdownMenuItem>
            )
          })}
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link href="/onboarding" className="gap-2.5">
            <Plus className="size-4" aria-hidden />
            {t('newOrganization')}
          </Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
