/**
 * Minimal typings for the optional `gamedig` dependency (the package ships none). Only the
 * surface `src/server/monitor-types/gamedig.ts` uses.
 */
declare module 'gamedig' {
  export interface GameDigQueryOptions {
    /** GameDig game id, e.g. `minecraft`. */
    type: string
    host: string
    port?: number
    /** Only query the given port instead of the game's alternative ports. */
    givenPortOnly?: boolean
    /** Per-packet socket timeout in milliseconds. */
    socketTimeout?: number
    /** Timeout for one full query attempt in milliseconds. */
    attemptTimeout?: number
    maxRetries?: number
    token?: string
  }

  export interface GameDigState {
    name: string
    map?: string
    password?: boolean
    numplayers?: number
    maxplayers?: number
    players?: unknown[]
    bots?: unknown[]
    connect?: string
    /** Round-trip time of the query in milliseconds. */
    ping: number
    raw?: Record<string, unknown>
  }

  export class GameDig {
    static query(options: GameDigQueryOptions): Promise<GameDigState>
  }
}
