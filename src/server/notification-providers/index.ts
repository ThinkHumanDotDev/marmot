import type { NotificationProvider } from './types'

export * from './types'

const registry = new Map<string, NotificationProvider>()

export function registerNotificationProvider(provider: NotificationProvider): void {
  if (registry.has(provider.name)) {
    throw new Error(`Notification provider "${provider.name}" is already registered`)
  }
  registry.set(provider.name, provider)
}

export function getNotificationProvider(name: string): NotificationProvider | undefined {
  return registry.get(name)
}

export function listNotificationProviders(): NotificationProvider[] {
  return [...registry.values()]
}

// Built-in providers register themselves on import. Add new providers below (one line each).
// import './smtp'
