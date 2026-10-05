import { describeProvider, type NotificationProviderDescriptor } from './describe'
import type { NotificationProvider } from './types'

const registry = new Map<string, NotificationProvider>()

export function registerNotificationProvider(provider: NotificationProvider): void {
  if (registry.has(provider.name)) {
    throw new Error(`Notification provider "${provider.name}" is already registered`)
  }
  // Fail at import time when a schema cannot be rendered by the UI.
  describeProvider(provider)
  registry.set(provider.name, provider)
}

export function getNotificationProvider(name: string): NotificationProvider | undefined {
  return registry.get(name)
}

export function listNotificationProviders(): NotificationProvider[] {
  return [...registry.values()]
}

/** Serialisable form descriptors for every provider, sorted by group then label. */
export function describeNotificationProviders(): NotificationProviderDescriptor[] {
  return listNotificationProviders()
    .map(describeProvider)
    .sort((a, b) => a.group.localeCompare(b.group) || a.label.localeCompare(b.label))
}
