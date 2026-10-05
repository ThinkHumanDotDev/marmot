'use client'

import { LogOut, Monitor, Moon, Plus, Sun } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useTheme } from 'next-themes'
import * as React from 'react'

import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from '@/components/ui/command'
import { authApi } from '@/lib/api'
import type { OrgMembership } from '@/lib/auth'
import { useUiStore } from '@/stores/ui-store'

import { orgNavigation, orgPath } from './navigation'

interface CommandPaletteProps {
  organizations: OrgMembership[]
  currentOrg: OrgMembership
}

/**
 * ⌘K / Ctrl+K palette. Navigation only for now; search over monitors and status pages plugs in
 * here once those collections exist.
 */
export function CommandPalette({ organizations, currentOrg }: CommandPaletteProps) {
  const router = useRouter()
  const { setTheme } = useTheme()
  const open = useUiStore((s) => s.commandPaletteOpen)
  const setOpen = useUiStore((s) => s.setCommandPaletteOpen)
  const toggle = useUiStore((s) => s.toggleCommandPalette)

  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        toggle()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [toggle])

  const run = (action: () => void) => () => {
    setOpen(false)
    action()
  }

  const otherOrgs = organizations.filter((org) => org.slug !== currentOrg.slug)

  return (
    <CommandDialog
      open={open}
      onOpenChange={setOpen}
      title="Command palette"
      description="Jump to a page or run an action"
      className="top-[20%] translate-y-0 sm:max-w-lg"
    >
      <CommandInput placeholder="Where to?" />
      <CommandList>
        <CommandEmpty>No results.</CommandEmpty>
        <CommandGroup heading="Go to">
          {orgNavigation.map((item) => (
            <CommandItem
              key={item.segment}
              value={`go ${item.label}`}
              onSelect={run(() => router.push(orgPath(currentOrg.slug, item.segment)))}
            >
              <item.icon aria-hidden />
              {item.label}
              <CommandShortcut>G {item.shortcut.toUpperCase()}</CommandShortcut>
            </CommandItem>
          ))}
        </CommandGroup>
        {otherOrgs.length > 0 && (
          <>
            <CommandSeparator />
            <CommandGroup heading="Switch organization">
              {otherOrgs.map((org) => (
                <CommandItem
                  key={String(org.id)}
                  value={`org ${org.name}`}
                  onSelect={run(() => router.push(`/${org.slug}`))}
                >
                  <span className="flex size-4 items-center justify-center rounded-sm bg-foreground text-[9px] font-semibold text-background">
                    {org.name.slice(0, 1).toUpperCase()}
                  </span>
                  {org.name}
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}
        <CommandSeparator />
        <CommandGroup heading="Theme">
          <CommandItem value="theme light" onSelect={run(() => setTheme('light'))}>
            <Sun aria-hidden /> Light
          </CommandItem>
          <CommandItem value="theme dark" onSelect={run(() => setTheme('dark'))}>
            <Moon aria-hidden /> Dark
          </CommandItem>
          <CommandItem value="theme system" onSelect={run(() => setTheme('system'))}>
            <Monitor aria-hidden /> System
          </CommandItem>
        </CommandGroup>
        <CommandSeparator />
        <CommandGroup heading="Account">
          <CommandItem value="new organization" onSelect={run(() => router.push('/onboarding'))}>
            <Plus aria-hidden /> New organization
          </CommandItem>
          <CommandItem
            value="sign out"
            onSelect={run(async () => {
              try {
                await authApi.logout()
              } finally {
                router.replace('/login')
                router.refresh()
              }
            })}
          >
            <LogOut aria-hidden /> Sign out
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  )
}
