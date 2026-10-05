'use client'

import {
  Activity,
  ExternalLink,
  Globe,
  LogOut,
  Monitor,
  Moon,
  Pause,
  Pencil,
  Play,
  Plus,
  SunMoon,
  Sun,
  Wrench,
} from 'lucide-react'
import { usePathname, useRouter } from 'next/navigation'
import { useTheme } from 'next-themes'
import * as React from 'react'
import { toast } from 'sonner'

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
import { StatusDot } from '@/components/status-dot'
import { publicStatusPagePath } from '@/components/status-pages/api'
import { isRole, PERMISSIONS, roleSatisfies, type Permission } from '@/access/permissions'
import { api, authApi } from '@/lib/api'
import type { OrgMembership } from '@/lib/auth'
import { statusKey, useMonitorStore, type MonitorStatusKey } from '@/stores/monitor-store'
import { useUiStore } from '@/stores/ui-store'

import { useGoShortcuts } from './keyboard-shortcuts'
import { orgNavigation, orgPath } from './navigation'

interface CommandPaletteProps {
  organizations: OrgMembership[]
  currentOrg: OrgMembership
}

interface PaletteMonitor {
  id: string
  name: string
  active: boolean
  status: MonitorStatusKey
}

interface PaletteStatusPage {
  id: string
  title: string
  slug: string
  published: boolean
}

/** `currentOrg.role` is the membership role, or `superadmin` for instance admins browsing an org. */
export function roleCan(role: string | undefined, permission: Permission): boolean {
  if (role === 'superadmin') return true
  return isRole(role) && roleSatisfies(role, PERMISSIONS[permission])
}

const lastStatusKey: Record<string, MonitorStatusKey> = {
  up: 'up',
  down: 'down',
  pending: 'pending',
  maintenance: 'maintenance',
}

/**
 * Monitors and status pages for the palette. The live monitor store is preferred (it is fed by
 * the socket and already holds the organization's monitors); the REST API fills in when the
 * store is not hydrated yet (realtime offline, or the palette opened before the socket joined).
 */
function usePaletteData(open: boolean, orgId: string | number) {
  const storeHydrated = useMonitorStore((s) => s.hydrated)
  const storeMonitors = useMonitorStore((s) => s.monitors)
  const storeHeartbeats = useMonitorStore((s) => s.heartbeats)
  const [fetchedMonitors, setFetchedMonitors] = React.useState<PaletteMonitor[] | null>(null)
  const [statusPages, setStatusPages] = React.useState<PaletteStatusPage[] | null>(null)

  React.useEffect(() => {
    if (!open) return
    let cancelled = false
    const where = { 'where[organization][equals]': String(orgId), depth: 0, limit: 500 }
    if (!useMonitorStore.getState().hydrated) {
      api
        .get<{
          docs: {
            id: string | number
            name: string
            active?: boolean | null
            status?: { lastStatus?: string | null } | null
          }[]
        }>('/api/monitors', { query: { ...where, sort: 'name' } })
        .then(({ docs }) => {
          if (cancelled) return
          setFetchedMonitors(
            docs.map((doc) => ({
              id: String(doc.id),
              name: doc.name,
              active: doc.active !== false,
              status:
                doc.active === false
                  ? 'unknown'
                  : (lastStatusKey[doc.status?.lastStatus ?? ''] ?? 'unknown'),
            })),
          )
        })
        .catch(() => undefined)
    }
    api
      .get<{
        docs: { id: string | number; title: string; slug: string; published?: boolean | null }[]
      }>('/api/status-pages', { query: { ...where, sort: 'title' } })
      .then(({ docs }) => {
        if (cancelled) return
        setStatusPages(
          docs.map((doc) => ({
            id: String(doc.id),
            title: doc.title,
            slug: doc.slug,
            published: !!doc.published,
          })),
        )
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [open, orgId])

  const monitors = React.useMemo<PaletteMonitor[]>(() => {
    if (!storeHydrated) return fetchedMonitors ?? []
    return Object.values(storeMonitors)
      .map((m) => ({
        id: m.id,
        name: m.name,
        active: m.active,
        status: m.active ? statusKey(storeHeartbeats[m.id]?.last()?.status) : ('unknown' as const),
      }))
      .sort((a, b) => a.name.localeCompare(b.name))
  }, [storeHydrated, storeMonitors, storeHeartbeats, fetchedMonitors])

  return { monitors, statusPages: statusPages ?? [] }
}

/**
 * ⌘K / Ctrl+K palette: jump to pages and monitors by name, open status pages, run quick actions
 * (new monitor, pause/resume the monitor on screen), switch organization and theme. Also wires
 * the `g <key>` navigation sequences.
 */
export function CommandPalette({ organizations, currentOrg }: CommandPaletteProps) {
  const router = useRouter()
  const pathname = usePathname()
  const { setTheme, resolvedTheme } = useTheme()
  const open = useUiStore((s) => s.commandPaletteOpen)
  const setOpen = useUiStore((s) => s.setCommandPaletteOpen)
  const toggle = useUiStore((s) => s.toggleCommandPalette)

  useGoShortcuts(currentOrg.slug)

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

  const { monitors, statusPages } = usePaletteData(open, currentOrg.id)

  const run = (action: () => void | Promise<void>) => () => {
    setOpen(false)
    void action()
  }

  const canWriteMonitors = roleCan(currentOrg.role, 'monitor:update')
  const canCreateMonitors = roleCan(currentOrg.role, 'monitor:create')
  const canCreateMaintenance = roleCan(currentOrg.role, 'maintenance:create')

  // On a monitor detail page (`/{org}/monitors/{id}`), offer pause/resume for that monitor.
  const detailMatch = pathname.match(/^\/[^/]+\/monitors\/([^/]+)$/)
  const currentMonitorId = detailMatch && detailMatch[1] !== 'new' ? detailMatch[1] : null
  const currentMonitor = currentMonitorId
    ? monitors.find((m) => m.id === currentMonitorId)
    : undefined

  async function setMonitorActive(monitor: PaletteMonitor, active: boolean) {
    const store = useMonitorStore.getState()
    const previous = store.monitors[monitor.id]
    // Optimistic: flip the live store first so lists and dots update immediately.
    if (previous) store.upsertMonitor({ ...previous, active })
    try {
      await api.post(
        `/api/orgs/${currentOrg.id}/monitors/${monitor.id}/${active ? 'resume' : 'pause'}`,
      )
      toast.success(active ? `Resumed “${monitor.name}”` : `Paused “${monitor.name}”`)
      router.refresh()
    } catch (error) {
      if (previous) useMonitorStore.getState().upsertMonitor(previous)
      toast.error(error instanceof Error ? error.message : 'Could not update the monitor')
    }
  }

  const otherOrgs = organizations.filter((org) => org.slug !== currentOrg.slug)
  const nextTheme = resolvedTheme === 'dark' ? 'light' : 'dark'

  return (
    <CommandDialog
      open={open}
      onOpenChange={setOpen}
      title="Command palette"
      description="Jump to a page or monitor, or run an action"
      className="top-[12%] translate-y-0 sm:top-[20%] sm:max-w-lg"
    >
      <CommandInput placeholder="Search pages, monitors, actions…" aria-label="Search commands" />
      <CommandList>
        <CommandEmpty>No results.</CommandEmpty>

        <CommandGroup heading="Actions">
          {canCreateMonitors && (
            <CommandItem
              value="new monitor create add"
              onSelect={run(() => router.push(orgPath(currentOrg.slug, 'monitors/new')))}
            >
              <Plus aria-hidden /> New monitor
            </CommandItem>
          )}
          {canCreateMaintenance && (
            <CommandItem
              value="schedule maintenance window new create"
              onSelect={run(() => router.push(orgPath(currentOrg.slug, 'maintenance/new')))}
            >
              <Wrench aria-hidden /> Schedule maintenance
            </CommandItem>
          )}
          {currentMonitor && canWriteMonitors && (
            <CommandItem
              value={`${currentMonitor.active ? 'pause' : 'resume'} monitor ${currentMonitor.name}`}
              onSelect={run(() => setMonitorActive(currentMonitor, !currentMonitor.active))}
            >
              {currentMonitor.active ? <Pause aria-hidden /> : <Play aria-hidden />}
              {currentMonitor.active ? 'Pause' : 'Resume'} “{currentMonitor.name}”
            </CommandItem>
          )}
          {currentMonitor && canWriteMonitors && (
            <CommandItem
              value={`edit monitor ${currentMonitor.name}`}
              onSelect={run(() =>
                router.push(orgPath(currentOrg.slug, `monitors/${currentMonitor.id}/edit`)),
              )}
            >
              <Pencil aria-hidden /> Edit “{currentMonitor.name}”
            </CommandItem>
          )}
          <CommandItem
            value={`toggle theme ${nextTheme} mode`}
            onSelect={run(() => setTheme(nextTheme))}
          >
            <SunMoon aria-hidden /> Switch to {nextTheme} theme
          </CommandItem>
        </CommandGroup>

        <CommandSeparator />
        <CommandGroup heading="Go to">
          {orgNavigation.map((item) => (
            <CommandItem
              key={item.segment}
              value={`go ${item.label}`}
              onSelect={run(() => router.push(orgPath(currentOrg.slug, item.segment)))}
            >
              <item.icon aria-hidden />
              {item.label}
              <CommandShortcut aria-label={`Shortcut: G then ${item.shortcut}`}>
                G {item.shortcut.toUpperCase()}
              </CommandShortcut>
            </CommandItem>
          ))}
        </CommandGroup>

        {monitors.length > 0 && (
          <>
            <CommandSeparator />
            <CommandGroup heading="Monitors">
              {monitors.map((monitor) => (
                <CommandItem
                  key={monitor.id}
                  value={`monitor ${monitor.name} ${monitor.id}`}
                  onSelect={run(() =>
                    router.push(orgPath(currentOrg.slug, `monitors/${monitor.id}`)),
                  )}
                >
                  <Activity aria-hidden />
                  <span className="min-w-0 flex-1 truncate">{monitor.name}</span>
                  {monitor.active ? (
                    <StatusDot status={monitor.status} pulse={false} className="size-2" />
                  ) : (
                    <span className="text-xs text-muted-foreground">Paused</span>
                  )}
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}

        {statusPages.length > 0 && (
          <>
            <CommandSeparator />
            <CommandGroup heading="Status pages">
              {statusPages.map((page) =>
                page.published ? (
                  <CommandItem
                    key={page.id}
                    value={`open status page ${page.title} ${page.slug}`}
                    onSelect={run(() => {
                      window.open(publicStatusPagePath(page.slug), '_blank', 'noopener')
                    })}
                  >
                    <ExternalLink aria-hidden />
                    <span className="min-w-0 flex-1 truncate">Open {page.title}</span>
                    <span className="font-mono text-xs text-muted-foreground">
                      /status/{page.slug}
                    </span>
                  </CommandItem>
                ) : (
                  <CommandItem
                    key={page.id}
                    value={`edit status page ${page.title} ${page.slug} draft`}
                    onSelect={run(() =>
                      router.push(orgPath(currentOrg.slug, `status-pages/${page.id}`)),
                    )}
                  >
                    <Globe aria-hidden />
                    <span className="min-w-0 flex-1 truncate">Edit {page.title}</span>
                    <span className="text-xs text-muted-foreground">Draft</span>
                  </CommandItem>
                ),
              )}
            </CommandGroup>
          </>
        )}

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
                  <span
                    aria-hidden
                    className="flex size-4 items-center justify-center rounded-sm bg-foreground text-[9px] font-semibold text-background"
                  >
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
