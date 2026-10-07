import { defaultLocale, type Locale } from '@/i18n/locales'
import {
  describeProvider,
  localizeDescriptor,
  type NotificationProviderDescriptor,
} from './describe'
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

/**
 * Serialisable form descriptors for every provider with their labels in `locale`
 * (`notifications.providers.*`), sorted by group, then by label in that locale.
 */
export function describeNotificationProviders(
  locale: Locale = defaultLocale,
): NotificationProviderDescriptor[] {
  const collator = new Intl.Collator(locale)
  return listNotificationProviders()
    .map((provider) => localizeDescriptor(describeProvider(provider), locale))
    .sort((a, b) => collator.compare(a.group, b.group) || collator.compare(a.label, b.label))
}
