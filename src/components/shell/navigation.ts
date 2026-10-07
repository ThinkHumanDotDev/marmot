import { Activity, Bell, Globe, Settings, Users, Wrench, type LucideIcon } from 'lucide-react'

export interface NavItem {
  /** Path segment under `/{orgSlug}`. */
  segment: string
  /** Message key of the label under `shell.nav`. */
  label: 'monitors' | 'statusPages' | 'maintenance' | 'notifications' | 'members' | 'settings'
  icon: LucideIcon
  /** "g" then this key jumps to the page (kan.bn-style sequence, also shown in the palette). */
  shortcut: string
}

export const orgNavigation: NavItem[] = [
  { segment: 'monitors', label: 'monitors', icon: Activity, shortcut: 'm' },
  { segment: 'status-pages', label: 'statusPages', icon: Globe, shortcut: 's' },
  { segment: 'maintenance', label: 'maintenance', icon: Wrench, shortcut: 'w' },
  { segment: 'notifications', label: 'notifications', icon: Bell, shortcut: 'n' },
  { segment: 'members', label: 'members', icon: Users, shortcut: 'u' },
  { segment: 'settings', label: 'settings', icon: Settings, shortcut: ',' },
]

export const orgPath = (orgSlug: string, segment?: string) =>
  segment ? `/${orgSlug}/${segment}` : `/${orgSlug}`
