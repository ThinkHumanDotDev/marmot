import type { z } from 'zod'

import type { Locale } from '@/i18n/locales'
import type { ChannelEvent } from '@/lib/notification-events'
import type { Heartbeat, Monitor } from '@/payload-types'
import type { TemplateOrganization } from '@/server/notifications/message'

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
  /**
   * The value is a Liquid message template (#150): checked when the channel is saved and shown in
   * the form's preview. `html` renders with HTML escaping.
   */
  template?: 'text' | 'html'
  /** A boolean config key that switches this `text` template to HTML (SMTP's `htmlBody`). */
  templateHtmlWhen?: string
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
  /**
   * Why the channel is told (#126): `down`, `up`, `degraded`, `reminder`, `certificate`,
   * `maintenance`; null/absent when unknown. Pass the whole context as `extras` to
   * `renderMessageTemplate` so templates can use `{{ event }}`, `{{ downtime }}` and the rest.
   */
  event?: ChannelEvent | null
  /** How long the monitor was DOWN, on `up` (recovery) notifications; null when unknown. */
  downtimeSeconds?: number | null
  /** The channel's organization (name, slug, logo) for templates and the default email. */
  organization?: TemplateOrganization | null
  /** The organization's time zone (IANA) for dates in templates; UTC when absent. */
  timeZone?: string
  /** The channel being sent to (absent for unsaved test channels). */
  notificationId?: string | null
  /** The channel's organization id. */
  organizationId?: string | null
  /**
   * The monitor incident a DOWN message or a page is about while nobody acknowledged it yet
   * (phone calls let the callee acknowledge it, #146); null otherwise.
   */
  incidentId?: string | null
  /** A test message from the channel form. */
  test?: boolean
  /**
   * The open tickets of issue-tracker providers (#149) for this channel and monitor. Present for
   * monitor notifications of a saved channel; absent for tests and organization-wide messages.
   */
  issues?: IssueStateStore
}

/**
 * Remembers the external ticket of an open outage per channel and monitor
 * (`notification-sent-history`, type `issue`). `target` names the repository, project or team, so
 * a channel pointed at another repository starts afresh.
 */
export interface IssueStateStore {
  get(target: string): Promise<string | null>
  set(target: string, externalId: string): Promise<void>
  clear(target: string): Promise<void>
}

/** A rendered notification email: subject, HTML part (null for plain-text only) and text part. */
export interface NotificationEmail {
  subject: string
  html: string | null
  text: string
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
   * Email providers: the email `send` delivers for `ctx`, so the channel form can preview it
   * without sending anything.
   */
  renderEmail?(ctx: NotificationSendContext): NotificationEmail
  /**
   * Whether the provider can be used on this instance (e.g. the Slack app needs its environment
   * variables). Unavailable providers are not offered in the channel picker. Default: available.
   */
  available?(): boolean
  /**
   * Send one test sample whatever the channel's events (a phone call per event would be a lot);
   * the others send one per selected event.
   */
  readonly testOnce?: boolean
  /**
   * Deliver the message. Resolve with a short success string, throw on failure.
   */
  send(ctx: NotificationSendContext): Promise<string>
}
