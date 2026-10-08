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
  Search,
  SunMoon,
  Sun,
  Trash2,
  Wrench,
  Zap,
} from 'lucide-react'
import { usePathname, useRouter } from 'next/navigation'
import { useLocale, useTranslations } from 'next-intl'
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
import { supportsCheckNow } from '@/lib/on-demand-check'
import {
  selectMonitorList,
  statusKey,
  useMonitorStore,
  type MonitorStatusKey,
} from '@/stores/monitor-store'
import { selectSelectionCount, useMonitorSelection } from '@/stores/monitor-selection-store'
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
  type?: string
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
  const locale = useLocale()
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
            type?: string
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
              type: doc.type,
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
    return selectMonitorList({ monitors: storeMonitors }, locale).map((m) => ({
      id: m.id,
      name: m.name,
      type: m.type,
      active: m.active,
      status: m.active ? statusKey(storeHeartbeats[m.id]?.last()?.status) : ('unknown' as const),
    }))
  }, [storeHydrated, storeMonitors, storeHeartbeats, fetchedMonitors, locale])

  return { monitors, statusPages: statusPages ?? [] }
}

/**
 * ⌘K / Ctrl+K palette: jump to pages and monitors by name, open status pages, run quick actions
 * (new monitor, pause/resume the monitor on screen), switch organization and theme. Also wires
 * the `g <key>` navigation sequences.
 */
export function CommandPalette({ organizations, currentOrg }: CommandPaletteProps) {
  const t = useTranslations('shell.palette')
  const tNav = useTranslations('shell.nav')
  const tTheme = useTranslations('shell.theme')
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
  const canDeleteMonitors = roleCan(currentOrg.role, 'monitor:delete')
  // Bulk actions on the monitor list's selection (#124), while the list is on screen.
  const listMounted = useMonitorSelection((s) => s.listMounted)
  const selectedCount = useMonitorSelection(selectSelectionCount)
  const bulkCount = listMounted ? selectedCount : 0

  function searchMonitors() {
    useMonitorSelection.getState().requestSearchFocus()
    if (!useMonitorSelection.getState().listMounted) {
      router.push(orgPath(currentOrg.slug, 'monitors'))
    }
  }
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
      toast.success(
        active ? t('resumed', { name: monitor.name }) : t('pausedToast', { name: monitor.name }),
      )
      router.refresh()
    } catch (error) {
      if (previous) useMonitorStore.getState().upsertMonitor(previous)
      toast.error(error instanceof Error ? error.message : t('updateFailed'))
    }
  }

  async function checkMonitorNow(monitor: PaletteMonitor) {
    const pending = toast.loading(t('checkingMonitor', { name: monitor.name }))
    try {
      const result = await api.post<{ status: MonitorStatusKey; msg: string }>(
        `/api/orgs/${currentOrg.id}/monitors/${monitor.id}/check`,
      )
      const text = t('checkResult', { name: monitor.name, status: result.status, msg: result.msg })
      if (result.status === 'down') toast.error(text, { id: pending })
      else toast.success(text, { id: pending })
      router.refresh()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('checkFailed'), { id: pending })
    }
  }

  const otherOrgs = organizations.filter((org) => org.slug !== currentOrg.slug)
  const nextTheme = resolvedTheme === 'dark' ? 'light' : 'dark'

  return (
    <CommandDialog
      open={open}
      onOpenChange={setOpen}
      title={t('title')}
      description={t('description')}
      className="top-[12%] translate-y-0 sm:top-[20%] sm:max-w-lg"
    >
      <CommandInput placeholder={t('placeholder')} aria-label={t('inputLabel')} />
      <CommandList>
        <CommandEmpty>{t('empty')}</CommandEmpty>

        <CommandGroup heading={t('actions')}>
          {canCreateMonitors && (
            <CommandItem
              value="new monitor create add"
              keywords={[t('newMonitor')]}
              onSelect={run(() => router.push(orgPath(currentOrg.slug, 'monitors/new')))}
            >
              <Plus aria-hidden /> {t('newMonitor')}
            </CommandItem>
          )}
          <CommandItem
            value="search monitors filter find"
            keywords={[t('searchMonitors')]}
            onSelect={run(searchMonitors)}
          >
            <Search aria-hidden /> {t('searchMonitors')}
            <CommandShortcut aria-hidden>/</CommandShortcut>
          </CommandItem>
          {bulkCount > 0 && canWriteMonitors && (
            <>
              <CommandItem
                value="pause selected monitors bulk"
                keywords={[t('bulkPause', { count: bulkCount })]}
                onSelect={run(() => useMonitorSelection.getState().requestBulk('pause'))}
              >
                <Pause aria-hidden /> {t('bulkPause', { count: bulkCount })}
              </CommandItem>
              <CommandItem
                value="resume selected monitors bulk"
                keywords={[t('bulkResume', { count: bulkCount })]}
                onSelect={run(() => useMonitorSelection.getState().requestBulk('resume'))}
              >
                <Play aria-hidden /> {t('bulkResume', { count: bulkCount })}
              </CommandItem>
              <CommandItem
                value="check selected monitors now bulk"
                keywords={[t('bulkCheck', { count: bulkCount })]}
                onSelect={run(() => useMonitorSelection.getState().requestBulk('check'))}
              >
                <Zap aria-hidden /> {t('bulkCheck', { count: bulkCount })}
              </CommandItem>
            </>
          )}
          {bulkCount > 0 && canDeleteMonitors && (
            <CommandItem
              value="delete selected monitors bulk"
              keywords={[t('bulkDelete', { count: bulkCount })]}
              onSelect={run(() => useMonitorSelection.getState().requestBulk('delete'))}
            >
              <Trash2 aria-hidden /> {t('bulkDelete', { count: bulkCount })}
            </CommandItem>
          )}
          {canCreateMaintenance && (
            <CommandItem
              value="schedule maintenance window new create"
              keywords={[t('scheduleMaintenance')]}
              onSelect={run(() => router.push(orgPath(currentOrg.slug, 'maintenance/new')))}
            >
              <Wrench aria-hidden /> {t('scheduleMaintenance')}
            </CommandItem>
          )}
          {currentMonitor && canWriteMonitors && (
            <CommandItem
              value={`${currentMonitor.active ? 'pause' : 'resume'} monitor ${currentMonitor.name}`}
              onSelect={run(() => setMonitorActive(currentMonitor, !currentMonitor.active))}
            >
              {currentMonitor.active ? <Pause aria-hidden /> : <Play aria-hidden />}
              {currentMonitor.active
                ? t('pauseMonitor', { name: currentMonitor.name })
                : t('resumeMonitor', { name: currentMonitor.name })}
            </CommandItem>
          )}
          {currentMonitor &&
            canWriteMonitors &&
            currentMonitor.active &&
            supportsCheckNow(currentMonitor.type) && (
              <CommandItem
                value={`check now run monitor ${currentMonitor.name}`}
                keywords={[t('checkNow', { name: currentMonitor.name })]}
                onSelect={run(() => checkMonitorNow(currentMonitor))}
              >
                <Zap aria-hidden /> {t('checkNow', { name: currentMonitor.name })}
              </CommandItem>
            )}
          {currentMonitor && canWriteMonitors && (
            <CommandItem
              value={`edit monitor ${currentMonitor.name}`}
              onSelect={run(() =>
                router.push(orgPath(currentOrg.slug, `monitors/${currentMonitor.id}/edit`)),
              )}
            >
              <Pencil aria-hidden /> {t('editMonitor', { name: currentMonitor.name })}
            </CommandItem>
          )}
          <CommandItem
            value={`toggle theme ${nextTheme} mode`}
            onSelect={run(() => setTheme(nextTheme))}
          >
            <SunMoon aria-hidden /> {t('switchTheme', { theme: nextTheme })}
          </CommandItem>
        </CommandGroup>

        <CommandSeparator />
        <CommandGroup heading={t('goTo')}>
          {orgNavigation.map((item) => (
            <CommandItem
              key={item.segment}
              value={`go ${tNav(item.label)}`}
              onSelect={run(() => router.push(orgPath(currentOrg.slug, item.segment)))}
            >
              <item.icon aria-hidden />
              {tNav(item.label)}
              <CommandShortcut aria-label={t('shortcut', { key: item.shortcut })}>
                G {item.shortcut.toUpperCase()}
              </CommandShortcut>
            </CommandItem>
          ))}
        </CommandGroup>

        {monitors.length > 0 && (
          <>
            <CommandSeparator />
            <CommandGroup heading={t('monitors')}>
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
                    <span className="text-xs text-muted-foreground">{t('paused')}</span>
                  )}
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}

        {statusPages.length > 0 && (
          <>
            <CommandSeparator />
            <CommandGroup heading={t('statusPages')}>
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
                    <span className="min-w-0 flex-1 truncate">
                      {t('openStatusPage', { title: page.title })}
                    </span>
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
                    <span className="min-w-0 flex-1 truncate">
                      {t('editStatusPage', { title: page.title })}
                    </span>
                    <span className="text-xs text-muted-foreground">{t('draft')}</span>
                  </CommandItem>
                ),
              )}
            </CommandGroup>
          </>
        )}

        {otherOrgs.length > 0 && (
          <>
            <CommandSeparator />
            <CommandGroup heading={t('switchOrganization')}>
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
        <CommandGroup heading={t('theme')}>
          <CommandItem
            value="theme light"
            keywords={[tTheme('light')]}
            onSelect={run(() => setTheme('light'))}
          >
            <Sun aria-hidden /> {tTheme('light')}
          </CommandItem>
          <CommandItem
            value="theme dark"
            keywords={[tTheme('dark')]}
            onSelect={run(() => setTheme('dark'))}
          >
            <Moon aria-hidden /> {tTheme('dark')}
          </CommandItem>
          <CommandItem
            value="theme system"
            keywords={[tTheme('system')]}
            onSelect={run(() => setTheme('system'))}
          >
            <Monitor aria-hidden /> {tTheme('system')}
          </CommandItem>
        </CommandGroup>
        <CommandSeparator />
        <CommandGroup heading={t('account')}>
          <CommandItem
            value="new organization"
            keywords={[t('newOrganization')]}
            onSelect={run(() => router.push('/onboarding'))}
          >
            <Plus aria-hidden /> {t('newOrganization')}
          </CommandItem>
          <CommandItem
            value="sign out"
            keywords={[t('signOut')]}
            onSelect={run(async () => {
              try {
                await authApi.logout()
              } finally {
                router.replace('/login')
                router.refresh()
              }
            })}
          >
            <LogOut aria-hidden /> {t('signOut')}
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  )
}
