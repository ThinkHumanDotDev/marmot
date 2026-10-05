import { Activity, Bell, Globe, Settings, Users, Wrench, type LucideIcon } from 'lucide-react'

export interface NavItem {
  /** Path segment under `/{orgSlug}`. */
  segment: string
  label: string
  icon: LucideIcon
  /** "g" then this key jumps to the page (shown in the command palette). */
  shortcut: string
}

export const orgNavigation: NavItem[] = [
  { segment: 'monitors', label: 'Monitors', icon: Activity, shortcut: 'm' },
  { segment: 'status-pages', label: 'Status pages', icon: Globe, shortcut: 'p' },
  { segment: 'maintenance', label: 'Maintenance', icon: Wrench, shortcut: 'w' },
  { segment: 'notifications', label: 'Notifications', icon: Bell, shortcut: 'n' },
  { segment: 'members', label: 'Members', icon: Users, shortcut: 'u' },
  { segment: 'settings', label: 'Settings', icon: Settings, shortcut: 's' },
]

export const orgPath = (orgSlug: string, segment?: string) =>
  segment ? `/${orgSlug}/${segment}` : `/${orgSlug}`
