'use client'

import { Menu, PanelLeftClose, PanelLeftOpen, Search } from 'lucide-react'
import Link from 'next/link'
import * as React from 'react'

import { Logo, LogoMark } from '@/components/logo'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { useUiStore } from '@/stores/ui-store'

import { CommandPalette } from './command-palette'
import { OrgSwitcher } from './org-switcher'
import { SidebarNav } from './sidebar-nav'
import type { ShellContext } from './types'
import { UserMenu } from './user-menu'

interface AppShellProps extends ShellContext {
  children: React.ReactNode
}

/**
 * Dashboard frame (kan.bn `Dashboard.tsx` pattern): the whole viewport is the muted sidebar
 * surface; the main content is a rounded, bordered panel floating inside it. On phones the
 * sidebar becomes a Sheet drawer behind a slim top bar.
 */
export function AppShell({ user, organizations, currentOrg, children }: AppShellProps) {
  const collapsed = useUiStore((s) => s.sidebarCollapsed)
  const toggleSidebar = useUiStore((s) => s.toggleSidebar)
  const mobileNavOpen = useUiStore((s) => s.mobileNavOpen)
  const setMobileNavOpen = useUiStore((s) => s.setMobileNavOpen)
  const openPalette = useUiStore((s) => s.setCommandPaletteOpen)

  // The persisted sidebar preference is applied after mount so SSR and the first client
  // render agree (see `skipHydration` in the store).
  React.useEffect(() => {
    void useUiStore.persist.rehydrate()
  }, [])

  const closeMobileNav = React.useCallback(() => setMobileNavOpen(false), [setMobileNavOpen])

  const sidebarBody = (collapsedView: boolean, onNavigate?: () => void) => (
    <>
      <OrgSwitcher
        organizations={organizations}
        currentOrg={currentOrg}
        collapsed={collapsedView}
      />
      <Separator className="my-3 bg-sidebar-border" />
      <SidebarNav orgSlug={currentOrg.slug} collapsed={collapsedView} onNavigate={onNavigate} />
      <div className="mt-auto flex flex-col gap-1">
        {collapsedView ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="w-full text-muted-foreground"
                onClick={() => openPalette(true)}
                aria-label="Search (⌘K)"
              >
                <Search />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="right">Search · ⌘K</TooltipContent>
          </Tooltip>
        ) : (
          <button
            type="button"
            onClick={() => openPalette(true)}
            className="flex h-9 items-center gap-2.5 rounded-lg px-2.5 text-sm text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
          >
            <Search className="size-4" aria-hidden />
            <span className="flex-1 text-left">Search</span>
            <kbd className="rounded-sm border bg-background px-1.5 py-0.5 font-sans text-[10px] font-medium text-muted-foreground">
              ⌘K
            </kbd>
          </button>
        )}
        <Separator className="my-2 bg-sidebar-border" />
        <UserMenu user={user} collapsed={collapsedView} />
      </div>
    </>
  )

  return (
    <div className="flex h-dvh min-h-0 flex-col bg-sidebar text-sidebar-foreground md:flex-row md:p-3">
      {/* Mobile top bar */}
      <header className="flex h-14 items-center justify-between border-b border-sidebar-border px-3 md:hidden">
        <Button
          variant="ghost"
          size="icon"
          aria-label="Open navigation"
          onClick={() => setMobileNavOpen(true)}
        >
          <Menu />
        </Button>
        <Link href={`/${currentOrg.slug}`} aria-label="Marmot home">
          <Logo />
        </Link>
        <Button variant="ghost" size="icon" aria-label="Search" onClick={() => openPalette(true)}>
          <Search />
        </Button>
      </header>

      <Sheet open={mobileNavOpen} onOpenChange={setMobileNavOpen}>
        <SheetContent side="left" className="w-[18rem] bg-sidebar p-3 text-sidebar-foreground">
          <SheetHeader className="sr-only">
            <SheetTitle>Navigation</SheetTitle>
            <SheetDescription>Organization pages and account</SheetDescription>
          </SheetHeader>
          <div className="flex h-full flex-col pt-8">{sidebarBody(false, closeMobileNav)}</div>
        </SheetContent>
      </Sheet>

      {/* Desktop sidebar */}
      <aside
        data-collapsed={collapsed}
        className={cn(
          'hidden shrink-0 flex-col pr-3 transition-[width] duration-200 ease-in-out md:flex',
          collapsed ? 'w-[4.25rem]' : 'w-64',
        )}
      >
        <div
          className={cn(
            'flex h-11 items-center pb-3',
            collapsed ? 'justify-center' : 'justify-between pl-1',
          )}
        >
          <Link href={`/${currentOrg.slug}`} aria-label="Marmot home" className="flex items-center">
            {collapsed ? <LogoMark /> : <Logo />}
          </Link>
          {!collapsed && (
            <Button
              variant="ghost"
              size="icon-sm"
              className="text-muted-foreground"
              onClick={toggleSidebar}
              aria-label="Collapse sidebar"
            >
              <PanelLeftClose />
            </Button>
          )}
        </div>
        {collapsed && (
          <Button
            variant="ghost"
            size="icon-sm"
            className="mb-2 w-full text-muted-foreground"
            onClick={toggleSidebar}
            aria-label="Expand sidebar"
          >
            <PanelLeftOpen />
          </Button>
        )}
        <div className="flex min-h-0 flex-1 flex-col">{sidebarBody(collapsed)}</div>
      </aside>

      {/* Main panel */}
      <main className="relative flex min-h-0 flex-1 flex-col overflow-hidden bg-background text-foreground md:rounded-xl md:border md:shadow-xs">
        <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
      </main>

      <CommandPalette organizations={organizations} currentOrg={currentOrg} />
    </div>
  )
}
