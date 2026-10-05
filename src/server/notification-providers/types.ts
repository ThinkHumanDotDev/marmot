/**
 * Notification provider interface, mirroring Uptime Kuma's `NotificationProvider` base class.
 * Each provider lives in its own file and registers itself in `./index.ts`.
 */
export interface NotificationSendContext {
  /** Provider-specific configuration stored on the `notifications` document. */
  config: Record<string, unknown>
  /** Rendered plain-text message. */
  message: string
  /** Monitor document, or null for test notifications. */
  monitor: Record<string, unknown> | null
  /** Heartbeat document, or null for test notifications. */
  heartbeat: Record<string, unknown> | null
}

export interface NotificationProvider {
  /** Unique slug stored in `notifications.type`, e.g. `discord`. */
  readonly name: string
  /** Human label for the UI. */
  readonly label: string
  /**
   * Deliver the message. Resolve with a short success string, throw on failure.
   */
  send(ctx: NotificationSendContext): Promise<string>
}
