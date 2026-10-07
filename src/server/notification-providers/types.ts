import type { z } from 'zod'

import type { Locale } from '@/i18n/locales'
import type { Heartbeat, Monitor } from '@/payload-types'

/**
 * Notification provider interface, mirroring Uptime Kuma's `NotificationProvider` base class.
 * Each provider lives in its own file and registers itself in `./index.ts`.
 */

/** UI grouping of providers in the "New channel" picker. */
export type NotificationProviderGroup = 'chat' | 'push' | 'email' | 'generic'

export const NOTIFICATION_PROVIDER_GROUPS: Record<NotificationProviderGroup, string> = {
  chat: 'Chat',
  push: 'Push',
  email: 'Email',
  generic: 'Generic',
}

/** Presentation hints for one key of a provider's `configSchema`, consumed by the dynamic form. */
export interface NotificationFieldMeta {
  label: string
  description?: string
  placeholder?: string
  /** Render as a password input and never echo the value in logs. */
  secret?: boolean
  /** Render as a textarea. */
  multiline?: boolean
  /** Labels for enum values (defaults to the raw value). */
  options?: Record<string, string>
}

export interface NotificationSendContext {
  /** Provider-specific configuration stored on the `notifications` document (already validated). */
  config: Record<string, unknown>
  /** Rendered plain-text message (`[name] [✅ Up] msg`). */
  message: string
  /** Monitor document (depth 0), or null for test notifications. */
  monitor: Monitor | null
  /** Heartbeat document, or null for test notifications. */
  heartbeat: Heartbeat | null
  /**
   * Language of the owning organization (`settings.language`); `message` is already rendered in it.
   * Pass it to the shared builders (`statusLabel`, `renderMessageTemplate`) for any extra text.
   * Optional so a context without it (tests, older callers) renders English.
   */
  locale?: Locale
}

export interface NotificationProvider {
  /** Unique slug stored in `notifications.type`, e.g. `discord`. */
  readonly name: string
  /** Human label for the UI. */
  readonly label: string
  /** Picker group. */
  readonly group: NotificationProviderGroup
  /** Where the user finds the webhook URL / token. */
  readonly docsUrl?: string
  /**
   * Shape of `notifications.config`. Only object schemas of string, number, boolean and enum
   * fields (optionally `.optional()` / `.default()`) are rendered by the UI form.
   */
  readonly configSchema: z.ZodTypeAny
  /** Labels, placeholders and secrecy per config key. */
  readonly fieldMeta?: Record<string, NotificationFieldMeta>
  /**
   * Deliver the message. Resolve with a short success string, throw on failure.
   */
  send(ctx: NotificationSendContext): Promise<string>
}
