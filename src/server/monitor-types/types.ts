/**
 * Monitor type plugin interface. Heavily inspired by Uptime Kuma's `server/monitor-types/`.
 * Each type lives in its own file and registers itself in `./index.ts`.
 */
export type HeartbeatStatus = 'up' | 'down' | 'pending' | 'maintenance'

export interface MonitorCheckContext {
  /** Monitor document (shape defined by the `monitors` collection). */
  monitor: Record<string, unknown> & { id: string | number; type: string }
  /** Mutable heartbeat being produced by this check. */
  heartbeat: {
    status: HeartbeatStatus
    msg: string
    ping?: number | null
    [extra: string]: unknown
  }
  /** Abort signal honouring the monitor timeout. */
  signal: AbortSignal
}

export interface MonitorType {
  /** Unique slug stored in `monitors.type`, e.g. `http`. */
  readonly name: string
  /** Human label for the UI. */
  readonly label: string
  /** UI grouping: general, passive, specific, database, game. */
  readonly group: 'general' | 'passive' | 'specific' | 'database' | 'game'
  /** Whether the type supports the condition builder. */
  readonly supportsConditions?: boolean
  /**
   * Run the check. Resolve on success after setting `heartbeat.status = 'up'`,
   * throw an Error on failure (the engine converts it to DOWN/PENDING).
   */
  check(ctx: MonitorCheckContext): Promise<void>
}
