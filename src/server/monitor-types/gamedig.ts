/**
 * GameDig monitor: queries a game server at `hostname:port` with the GameDig protocol library for
 * `game` (a GameDig game id such as `minecraft` or `csgo`); UP when the server answers, with the
 * server name as message and the query time as ping. `gamedig` is an optional dependency loaded
 * inside `check()`.
 *
 * Ported from Uptime Kuma 2.5.5 `server/monitor-types/gamedig.js` — Copyright (c) 2021 Louis Lam,
 * MIT License. See THIRD_PARTY_NOTICES.md.
 */
import { resolveGuardedTarget } from '@/server/security/outbound-guard'

import { registerMonitorType } from './registry'
import {
  checkTimeoutMs,
  errorMessage,
  loadOptionalDriver,
  requireField,
  requireHostname,
  withAbort,
} from './util'

registerMonitorType({
  name: 'gamedig',
  label: 'GameDig',
  group: 'game',
  async check(ctx) {
    const host = requireHostname(ctx.monitor)
    const game = requireField(ctx.monitor.game, 'Game')
    const timeout = checkTimeoutMs(ctx.monitor)
    const { GameDig } = await loadOptionalDriver(() => import('gamedig'), 'gamedig', 'GameDig')
    // Outbound address guard: query the vetted address (null when the guard is off). GameDig may
    // still look up SRV records for some games (e.g. Minecraft) by the given address; with an IP
    // there is nothing left to resolve.
    const vetted = await resolveGuardedTarget(host)

    let state
    try {
      state = await withAbort(
        GameDig.query({
          type: game,
          host: vetted?.address ?? host,
          port: ctx.monitor.port ?? undefined,
          // Only probe the port the user gave instead of the game's usual alternatives.
          givenPortOnly: ctx.monitor.gamedigGivenPortOnly ?? true,
          socketTimeout: timeout,
          attemptTimeout: timeout,
          maxRetries: 0,
        }),
        ctx.signal,
      )
    } catch (err) {
      throw new Error(errorMessage(err))
    }

    ctx.heartbeat.msg = state.name
    ctx.heartbeat.ping = state.ping
    ctx.heartbeat.status = 'up'
  },
})
